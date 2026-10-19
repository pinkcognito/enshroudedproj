#!/bin/bash
# provision-host.sh - Enshrouded host provisioning (WP-05). Idempotent: safe to re-run.
#
# Delivered over SSM Run Command (there is no SSH). Runs as root on Ubuntu 24.04.
# Architecture refs: section 4 (shutdown), 6.1.2-6.1.4 (Proton, pinning, SSM Agent), 7 (install).
#
# NEVER-DO list (data-loss critical):
#   * never mkfs a device that carries ANY filesystem/RAID/LVM/partition signature
#   * never mkfs unless the disk is positively identified as THE data volume (SSM param
#     /enshroudedproj/server/data-volume-id == the volume id behind the NVMe serial)
#   * never mkfs unless ENSHROUDED_ALLOW_FIRST_FORMAT names that exact volume id
#   (the rules and their rationale are ARCHITECTURE section 8.2)
#   * never start/stop/restart enshrouded.service from here (a re-run on a live host must
#     not interrupt a session or trigger a stop)
#   * never extract or use a GE-Proton tarball whose SHA256 does not match
set -euo pipefail
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"

if [ "$(id -u)" -ne 0 ]; then echo "must run as root" >&2; exit 1; fi

log()  { echo "[provision-host] $*"; }
warn() { echo "[provision-host] WARNING: $*" >&2; }
die()  { echo "[provision-host] FATAL: $*" >&2; exit 1; }

WORK_DIR=""
cleanup() { if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Configuration (all pinned values live here; nothing floats - invariant 1.4)
# ---------------------------------------------------------------------------
GAME_USER="enshrouded"
DATA_MOUNT="/srv/enshrouded"
STEAMCMD_DIR="/opt/steamcmd"

GE_PROTON_VERSION="11-9"
GE_PROTON_SHA256="b2cf4a632a70ec321cdb9904fa396a2a45d4061129f9fdc89d8a27ea5ceeb9d6"
# GE-Proton 11 ships as GE-Proton<ver>-x86_64.tar.gz and extracts to GE-Proton<ver>-x86_64/;
# we install it as GE-Proton<ver> so the unit path stays version-keyed only.
# SHA256 of the extracted, lsteamclient-patched proton script (the derived artifact we actually
# run; see patch_lsteamclient). Regenerate on every Proton bump - that is the point.
GE_PROTON_PATCHED_PROTON_SHA256="81ce6ce5fce8501abe8614c97770b975b0ea2ca6d5385de62592ea3a797b759d"
GE_PROTON_TARBALL="GE-Proton${GE_PROTON_VERSION}-x86_64.tar.gz"
GE_PROTON_EXTRACTED="GE-Proton${GE_PROTON_VERSION}-x86_64"
GE_PROTON_URL="https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton${GE_PROTON_VERSION}/${GE_PROTON_TARBALL}"
GE_PROTON_DIR="${STEAMCMD_DIR}/compatibilitytools.d/GE-Proton${GE_PROTON_VERSION}"
# Optional S3 mirror prefix, e.g. s3://<bucket>/mirror/ge-proton  (set by the SSM caller).
# Used as fallback when upstream is unreachable or serves bad bits; also best-effort upload target.
ENSHROUDED_MIRROR_S3_URI="${ENSHROUDED_MIRROR_S3_URI:-}"

# Optional hint: the data volume id (vol-0123...). Matches the NVMe serial. Never required.
ENSHROUDED_DATA_VOLUME_ID="${ENSHROUDED_DATA_VOLUME_ID:-}"
# First-format acknowledgement (ARCHITECTURE 8.2). NOT a boolean: it must equal the volume id the
# script resolved from the NVMe serial (e.g. vol-0142d5163b94a5e53), so it confirms THIS disk and
# fails safe if the expected volume ever changes. Only needed on true first provision.
ENSHROUDED_ALLOW_FIRST_FORMAT="${ENSHROUDED_ALLOW_FIRST_FORMAT:-}"
# Published by WP-04's WorldStorage; the source of truth for which volume is the data volume.
DATA_VOLUME_ID_PARAM="/enshroudedproj/server/data-volume-id"
# The device name WP-04 attaches the volume as (Nitro surfaces it as NVMe; this name may not exist).
DATA_DEVICE_HINT="sdf"

CW_LOG_GROUP="${CW_LOG_GROUP:-/enshroudedproj/game-log}"
GAME_LOG_FILE="${DATA_MOUNT}/logs/enshrouded_server.log"

# ---------------------------------------------------------------------------
# 1. SSM Agent  (MUST stay first; block is shared verbatim with the instance user data)
#    server.ts extracts the text between the BEGIN/END markers at synth time and uses it as
#    user data. Edit it HERE ONLY; test/host-scripts.test.ts enforces the equality.
# ---------------------------------------------------------------------------
# BEGIN SSM-AGENT-BOOTSTRAP
ensure_ssm_agent() {
  local snap_unit="snap.amazon-ssm-agent.amazon-ssm-agent.service"
  agent_active() {
    systemctl is-active --quiet "$snap_unit" || systemctl is-active --quiet amazon-ssm-agent.service
  }
  if ! agent_active; then
    if ! snap list amazon-ssm-agent >/dev/null 2>&1 && ! dpkg -s amazon-ssm-agent >/dev/null 2>&1; then
      snap wait system seed.loaded || true
      for _ in 1 2 3 4 5; do
        snap install amazon-ssm-agent && break
        sleep 10
      done
    fi
    snap start amazon-ssm-agent || true
    systemctl enable --now "$snap_unit" || true
    systemctl enable --now amazon-ssm-agent.service || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      agent_active && break
      sleep 5
    done
  fi
  if ! agent_active && ! snap list amazon-ssm-agent >/dev/null 2>&1 && ! dpkg -s amazon-ssm-agent >/dev/null 2>&1; then
    # Last resort: AWS's own regional package (TLS, AWS-owned bucket).
    # Split rather than `curl && dpkg || true` (SC2015): that form cannot
    # distinguish a download failure from an install failure, and this is the
    # path deciding whether the host is reachable at all (no SSH, no key pair).
    # Both stay non-fatal - the agent_active gate below is what decides - but
    # each failure is now named in the console log.
    ssm_deb_url="https://s3.us-east-2.amazonaws.com/amazon-ssm-us-east-2/latest/debian_amd64/amazon-ssm-agent.deb"
    if curl -fsSL --retry 5 -o /tmp/amazon-ssm-agent.deb "$ssm_deb_url"; then
      if ! dpkg -i /tmp/amazon-ssm-agent.deb; then
        echo "WARN: dpkg install of amazon-ssm-agent.deb failed" >&2
      fi
    else
      echo "WARN: could not download amazon-ssm-agent.deb from AWS" >&2
    fi
    systemctl enable --now amazon-ssm-agent.service || true
  fi
  for _ in 1 2 3 4 5 6; do
    agent_active && return 0
    sleep 5
  done
  return 1
}
ensure_ssm_agent || { echo "FATAL: SSM Agent is not running; host is unreachable" >&2; exit 1; }
# END SSM-AGENT-BOOTSTRAP
log "SSM Agent is active"

# ---------------------------------------------------------------------------
# 2. Packages
# ---------------------------------------------------------------------------
install_packages() {
  local apt_opts=(-o DPkg::Lock::Timeout=600 -y -qq)
  apt-get "${apt_opts[@]}" update
  # Package set from the reference container recipe (jsknnr/enshrouded-server 11ac003) + SteamCMD
  # 32-bit needs. GE-Proton 11's proton script loads libvulkan.so.1 at startup (libvulkan1); winbind
  # is the reference's. No Vulkan ICD (mesa-vulkan-drivers): the reference installs none.
  apt-get "${apt_opts[@]}" install --no-install-recommends \
    ca-certificates curl tar gzip jq procps xdg-user-dirs python3 libfreetype6 \
    nvme-cli util-linux e2fsprogs ufw lib32gcc-s1 lib32stdc++6 \
    libvulkan1 winbind
  if [ ! -x /snap/bin/aws ] && ! command -v aws >/dev/null 2>&1; then
    snap install aws-cli --classic
  fi
  # systemd units run with a PATH that lacks /snap/bin.
  if [ -x /snap/bin/aws ]; then ln -sf /snap/bin/aws /usr/local/bin/aws; fi
}

# ---------------------------------------------------------------------------
# 3. Unprivileged game user
# ---------------------------------------------------------------------------
ensure_user() {
  if id "$GAME_USER" >/dev/null 2>&1; then
    log "user $GAME_USER exists"
  else
    useradd --system --create-home --home-dir "/home/${GAME_USER}" --shell /usr/sbin/nologin "$GAME_USER"
    log "created user $GAME_USER"
  fi
}

# ---------------------------------------------------------------------------
# 4. Retained data volume -> /srv/enshrouded   (THE WORLD LIVES HERE)
# ---------------------------------------------------------------------------
root_disk() {
  local src parent
  src="$(findmnt -n -o SOURCE /)"
  # PKNAME is the parent disk of the root partition (empty if / is on a bare disk).
  parent="$(lsblk -no PKNAME "$src" 2>/dev/null | head -n1)"
  if [ -n "$parent" ]; then echo "/dev/${parent}"; else echo "$src"; fi
}

# All whole disks that are not the root disk, one per line.
non_root_disks() {
  local rd d
  rd="$(root_disk)"
  while read -r d; do
    if [ "$d" != "$rd" ]; then echo "$d"; fi
  done < <(lsblk -dnpo NAME,TYPE | awk '$2 == "disk" {print $1}')
}

# EBS-on-NVMe stores the requested attach name (e.g. "sdf") in the vendor-specific area of
# Identify Controller, bytes 3072..3103 (the same field AWS's ebsnvme-id reads).
nvme_mapped_name() {
  nvme id-ctrl -b "$1" 2>/dev/null | dd bs=1 skip=3072 count=32 2>/dev/null | tr -d '\0 ' | sed 's#^/dev/##'
}

find_data_device() {
  local d serial want link found candidates
  candidates="$(non_root_disks)"
  [ -n "$candidates" ] || return 1

  # Strategy 1 (exact): volume id -> NVMe serial ("vol0123..." = volume id without the dash).
  if [ -n "$ENSHROUDED_DATA_VOLUME_ID" ]; then
    want="${ENSHROUDED_DATA_VOLUME_ID//-/}"
    for d in $candidates; do
      serial="$(lsblk -dno SERIAL "$d" 2>/dev/null | tr -d ' ')"
      if [ "$serial" = "$want" ]; then echo "$d"; return 0; fi
    done
    warn "volume id ${ENSHROUDED_DATA_VOLUME_ID} not found among disks; trying other strategies"
  fi

  # Strategy 2: the attach name WP-04 requested (sdf / xvdf), via NVMe id-ctrl or a /dev symlink.
  for d in $candidates; do
    case "$(nvme_mapped_name "$d")" in
      "$DATA_DEVICE_HINT"|"xv${DATA_DEVICE_HINT#s}") echo "$d"; return 0 ;;
    esac
  done
  for link in "/dev/${DATA_DEVICE_HINT}" "/dev/xv${DATA_DEVICE_HINT#s}"; do
    if [ -e "$link" ]; then
      found="$(readlink -f "$link")"
      if echo "$candidates" | grep -qx "$found"; then echo "$found"; return 0; fi
    fi
  done

  # Strategy 3 (weakest): exactly one non-root whole disk exists. Anything else is ambiguous.
  if [ "$(echo "$candidates" | wc -l)" -eq 1 ]; then
    warn "identifying data volume as the only non-root disk: $candidates"
    echo "$candidates"; return 0
  fi
  return 1
}

wait_for_data_device() {
  local dev
  for _ in $(seq 1 30); do
    if dev="$(find_data_device)"; then echo "$dev"; return 0; fi
    sleep 2
  done
  return 1
}

# Volume id behind a disk's NVMe serial ("vol0123abc" -> "vol-0123abc"). Fails if the serial is
# not an EBS volume serial.
device_volume_id() {
  local serial
  serial="$(lsblk -dno SERIAL "$1" 2>/dev/null | tr -d ' ')" || return 1
  case "$serial" in
    vol[0-9a-f]*) echo "vol-${serial#vol}" ;;
    *) return 1 ;;
  esac
}

# The volume id this stack expects, from SSM. Prints it; fails (with a reason on stderr) if it
# cannot be read or is not a volume id. Never guesses.
read_expected_volume_id() {
  local v
  v="$(aws ssm get-parameter --region "${REGION:-us-east-2}" --name "$DATA_VOLUME_ID_PARAM" \
        --query Parameter.Value --output text 2>/dev/null)" || {
    echo "cannot read SSM parameter ${DATA_VOLUME_ID_PARAM} (not yet created by the EnshroudedServerStack deploy, or the instance role cannot read it)" >&2
    return 1
  }
  case "$v" in
    vol-[0-9a-f]*) echo "$v" ;;
    *) echo "SSM parameter ${DATA_VOLUME_ID_PARAM} holds '${v}', which is not a volume id" >&2; return 1 ;;
  esac
}

# Positive identification (ARCHITECTURE 8.2): the disk we are about to use must BE the volume the
# stack created. Prints the resolved volume id. Applies whether or not a filesystem exists.
verify_volume_identity() {
  local dev="$1" expected="$2" resolved
  resolved="$(device_volume_id "$dev")" \
    || die "refusing to use $dev: its NVMe serial is not an EBS volume id, so it cannot be identified.
  device:             $dev
  expected volume id: $expected (from SSM ${DATA_VOLUME_ID_PARAM})
  failed condition:   volume identity (no vol-... serial on the device)"
  if [ "$resolved" != "$expected" ]; then
    die "refusing to use $dev: it is NOT the data volume this stack expects.
  device:             $dev
  resolved volume id: $resolved
  expected volume id: $expected (from SSM ${DATA_VOLUME_ID_PARAM})
  failed condition:   volume identity (resolved id != expected id)
  Nothing was changed. Find out why a different volume is attached before doing anything else."
  fi
  echo "$resolved"
}

# True ONLY if the device carries no signature of any kind: no filesystem/RAID/LVM signature
# (wipefs), nothing blkid recognises (rc 2 = nothing found), and no partition table. Any doubt =>
# false, with the failed condition left in BLANK_FAIL for the error message.
#
# DO NOT REINSTATE an "all-zeros in the first MiB" condition (ARCHITECTURE 8.2). On an ENCRYPTED
# EBS volume never-written blocks read back as pseudo-random bytes (observed: zeros for 4 KiB,
# random from 0x1000), so that test fails for EVERY volume, blank or not. It is not a safety
# control, it is an outage - and it is what gets a guard deleted along with the checks that
# matter. The world always lives on ext4, and any volume that held one carries a superblock
# signature that the checks below detect; volume identity + the named acknowledgement cover the
# rest.
device_is_blank() {
  local dev="$1" sigs pttype rc=0
  BLANK_FAIL=""
  sigs="$(wipefs --noheadings --no-act "$dev")" || { BLANK_FAIL="wipefs could not probe $dev"; return 1; }
  if [ -n "$sigs" ]; then BLANK_FAIL="wipefs reports a signature on $dev"; return 1; fi
  blkid -p "$dev" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 2 ]; then BLANK_FAIL="blkid -p found something on $dev (rc=$rc, expected 2)"; return 1; fi
  pttype="$(blkid -p -o value -s PTTYPE "$dev" 2>/dev/null || true)"
  if [ -n "$pttype" ]; then BLANK_FAIL="$dev has a partition table ($pttype)"; return 1; fi
  return 0
}

# The ONLY place a filesystem is ever created. No -F: mke2fs itself also refuses to
# overwrite a detected filesystem when it is not forced.
# format_if_blank <device> <resolved-volume-id>
format_if_blank() {
  local dev="$1" vol="$2" given
  device_is_blank "$dev" || die "refusing to format $dev: not blank.
  device:             $dev
  resolved volume id: $vol
  failed condition:   ${BLANK_FAIL:-unknown}"
  if [ "$ENSHROUDED_ALLOW_FIRST_FORMAT" != "$vol" ]; then
    given="unset or empty"
    if [ -n "$ENSHROUDED_ALLOW_FIRST_FORMAT" ]; then given="'${ENSHROUDED_ALLOW_FIRST_FORMAT}' (does not match)"; fi
    die "refusing to format $dev: first format not acknowledged for this volume.
  device:             $dev
  resolved volume id: $vol
  failed condition:   ENSHROUDED_ALLOW_FIRST_FORMAT is ${given}; it must equal the resolved volume id
  To format this (empty, never-used) volume, set exactly:
    ENSHROUDED_ALLOW_FIRST_FORMAT=$vol
  (deploy-game-server workflow: run it with the allow_first_format input set to $vol)
  Formatting a volume that holds a world destroys it; only acknowledge a volume you know is new."
  fi
  log "first boot: $dev ($vol) is blank and acknowledged, creating ext4 (label enshrouded-data)"
  mkfs.ext4 -q -L enshrouded-data "$dev"
  udevadm settle || true
}

# Decide what to do with the filesystem on <device> (volume <resolved-volume-id>). An existing
# ext4/xfs filesystem means we NEVER format (instance replacement and the 8.1 cross-AZ restore
# both land here, so they stay cheap and need no acknowledgement).
ensure_filesystem() {
  local dev="$1" vol="$2" rc=0 fstype pttype
  fstype="$(blkid -p -o value -s TYPE "$dev" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$fstype" ]; then
    case "$fstype" in
      ext4|xfs) log "existing $fstype filesystem on $dev - will NOT format" ;;
      *) die "$dev holds an unexpected filesystem '$fstype'; refusing to touch it" ;;
    esac
  elif [ "$rc" -eq 2 ]; then
    pttype="$(blkid -p -o value -s PTTYPE "$dev" 2>/dev/null || true)"
    [ -z "$pttype" ] || die "$dev has a partition table ($pttype); refusing to touch it"
    format_if_blank "$dev" "$vol"
  else
    die "blkid failed (rc=$rc) on $dev; refusing to guess"
  fi
}

ensure_data_volume() {
  local dev fstype uuid expected_id resolved_id
  if mountpoint -q "$DATA_MOUNT"; then
    fstype="$(findmnt -n -o FSTYPE "$DATA_MOUNT")"
    case "$fstype" in
      ext4|xfs) log "$DATA_MOUNT already mounted ($fstype); leaving it untouched"; return 0 ;;
      *) die "$DATA_MOUNT is mounted with unexpected fs type '$fstype'" ;;
    esac
  fi

  # The expected volume id is the source of truth; it also makes device lookup exact (strategy 1).
  expected_id="$(read_expected_volume_id)" || die "cannot establish which volume is the data volume; refusing to touch any disk"
  if [ -z "$ENSHROUDED_DATA_VOLUME_ID" ]; then ENSHROUDED_DATA_VOLUME_ID="$expected_id"; fi

  dev="$(wait_for_data_device)" || die "could not identify the data volume (no unambiguous non-root disk)"
  log "data volume device: $dev"
  resolved_id="$(verify_volume_identity "$dev" "$expected_id")" || exit 1
  log "data volume identity verified: $resolved_id matches ${DATA_VOLUME_ID_PARAM}"
  if lsblk -nro MOUNTPOINT "$dev" | grep -q .; then
    die "$dev (or a partition) is mounted somewhere else; refusing to touch it"
  fi

  ensure_filesystem "$dev" "$resolved_id"

  uuid="$(blkid -p -o value -s UUID "$dev")"
  [ -n "$uuid" ] || die "no UUID on $dev after probe"
  fstype="$(blkid -p -o value -s TYPE "$dev")"

  # While unmounted, make the bare directory immutable so nothing can ever write a stray
  # 'world' onto the root volume. (Mounting over it is unaffected.)
  mkdir -p "$DATA_MOUNT"
  chattr +i "$DATA_MOUNT" 2>/dev/null || warn "could not set immutable flag on bare $DATA_MOUNT"

  if grep -qE "^[^#]*[[:space:]]${DATA_MOUNT}[[:space:]]" /etc/fstab; then
    grep -qE "^UUID=${uuid}[[:space:]]+${DATA_MOUNT}[[:space:]]" /etc/fstab \
      || die "/etc/fstab already has a different entry for $DATA_MOUNT; resolve by hand"
  else
    [ -e /etc/fstab.pre-enshrouded ] || cp -p /etc/fstab /etc/fstab.pre-enshrouded
    echo "UUID=${uuid} ${DATA_MOUNT} ${fstype} defaults,nofail,x-systemd.device-timeout=30 0 2" >> /etc/fstab
    log "added fstab entry for UUID=${uuid}"
  fi
  systemctl daemon-reload
  mount "$DATA_MOUNT"
  mountpoint -q "$DATA_MOUNT" || die "$DATA_MOUNT is not a mount point after mount"
  [ "$(findmnt -n -o UUID "$DATA_MOUNT")" = "$uuid" ] || die "mounted UUID mismatch at $DATA_MOUNT"

  log "data volume mounted at $DATA_MOUNT (UUID ${uuid})"
}

# Game directories on the data volume, owned by the game user. Separate from ensure_data_volume
# because that returns early when the volume is already mounted (every re-run on a live host).
# savegame/ gets a write test, as the reference entrypoint does: a read-only or root-owned world
# directory must fail provisioning, not the first save.
ensure_game_dirs() {
  mountpoint -q "$DATA_MOUNT" || die "$DATA_MOUNT is not mounted; refusing to create game directories on the root volume"
  mkdir -p "${DATA_MOUNT}/compatdata" "${DATA_MOUNT}/savegame" "${DATA_MOUNT}/logs"
  chown "${GAME_USER}:${GAME_USER}" "$DATA_MOUNT" "${DATA_MOUNT}/compatdata" "${DATA_MOUNT}/savegame" "${DATA_MOUNT}/logs"
  runuser -u "$GAME_USER" -- touch "${DATA_MOUNT}/savegame/.permtest" \
    || die "${DATA_MOUNT}/savegame is not writable by ${GAME_USER}"
  rm -f "${DATA_MOUNT}/savegame/.permtest"
}

# ---------------------------------------------------------------------------
# 5. SteamCMD
# ---------------------------------------------------------------------------
as_game_user() { runuser -u "$GAME_USER" -- env "HOME=/home/${GAME_USER}" "$@"; }

install_steamcmd() {
  mkdir -p "$STEAMCMD_DIR"
  if [ ! -x "${STEAMCMD_DIR}/steamcmd.sh" ]; then
    curl -fsSL --proto '=https' --tlsv1.2 --retry 5 \
      https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz -C "$STEAMCMD_DIR"
  fi
  chown -R "${GAME_USER}:${GAME_USER}" "$STEAMCMD_DIR"
  ln -sf "${STEAMCMD_DIR}/steamcmd.sh" /usr/local/bin/steamcmd
  # First run self-updates and can exit non-zero; the second run must be clean.
  as_game_user "${STEAMCMD_DIR}/steamcmd.sh" +quit || true
  as_game_user "${STEAMCMD_DIR}/steamcmd.sh" +quit || die "steamcmd does not run cleanly"
}

# Steam SDK links for the game user (the server's Steamworks layer looks in ~/.steam/sdk64|32).
# Must run AFTER install_steamcmd: steamcmd's first run populates linux64/ and linux32/.
install_steam_sdk_links() {
  local home="/home/${GAME_USER}" bits dir link
  as_game_user mkdir -p "${home}/.steam"
  for bits in 64 32; do
    dir="${STEAMCMD_DIR}/linux${bits}"
    link="${home}/.steam/sdk${bits}"
    [ -e "${dir}/steamclient.so" ] || die "${dir}/steamclient.so is missing (did steamcmd run?)"
    # steamcmd may have made a real directory here; move it aside rather than delete it.
    if [ -e "$link" ] && [ ! -L "$link" ]; then
      rm -rf "${link}.pre-enshrouded"
      mv "$link" "${link}.pre-enshrouded"
    fi
    as_game_user ln -sfn "$dir" "$link"
    as_game_user ln -sfn "${link}/steamclient.so" "${link}/steamservice.so"
  done
  log "Steam SDK links in place (sdk64 -> ${STEAMCMD_DIR}/linux64, sdk32 -> ${STEAMCMD_DIR}/linux32)"
}

# ---------------------------------------------------------------------------
# 6. GE-Proton: pinned version AND SHA256, S3 mirror fallback (invariant 1.4)
# ---------------------------------------------------------------------------
verify_sha256() {
  local f="$1" got
  got="$(sha256sum "$f" | awk '{print $1}')"
  if [ "$got" = "$GE_PROTON_SHA256" ]; then return 0; fi
  warn "SHA256 mismatch for $f: expected $GE_PROTON_SHA256 got $got"
  return 1
}

# DOCUMENTED DEVIATION FROM THE PINNED UPSTREAM ARTIFACT (ARCHITECTURE 6.1.3a) - not a local hack.
# GE-Proton 11's umu mode (UMU_ID set) disables lsteamclient, which the 1.0 server needs for
# Steamworks (SteamUtils011). We remove that override from the proton script, as the reference
# (jsknnr/enshrouded-server 11ac003) does. On every Proton bump ask whether this is still needed
# before carrying it over; regenerating GE_PROTON_PATCHED_PROTON_SHA256 is deliberate friction.
#
# Integrity chain: tarball SHA256 (verify_sha256, "did we get upstream's bits") -> extract ->
# this patch -> SHA256 of the patched proton script == GE_PROTON_PATCHED_PROTON_SHA256 ("are these
# the bits we intend to run"). Called only AFTER verify_sha256, on the freshly extracted tree.
#
# Fresh tree (no LSTEAMCLIENT_PATCHED_MARKER; the marker is only written after a successful
# patch): the override line must occur EXACTLY ONCE - 0 or >1 means upstream changed shape and
# we stop. Already-patched tree (marker present, e.g. a re-run): the line must be absent and the
# script must hash to the patched pin; nothing is modified. A fully provisioned host never gets
# here at all - install_ge_proton returns early on the marker + tarball-SHA record.
LSTEAMCLIENT_PATCHED_MARKER=".lsteamclient-patched"
LSTEAMCLIENT_LINE='append_to_env_str(self.env, "WINEDLLOVERRIDES", "lsteamclient=d", ";")'
patch_lsteamclient() {
  local proton_script="$1" tree n got
  tree="$(dirname "$proton_script")"
  n="$(grep -cF -- "$LSTEAMCLIENT_LINE" "$proton_script" || true)"
  if [ -e "${tree}/${LSTEAMCLIENT_PATCHED_MARKER}" ]; then
    [ "$n" -eq 0 ] || die "${proton_script} is marked patched but still contains the lsteamclient override"
  else
    [ "$n" -eq 1 ] || die "expected exactly 1 lsteamclient override line in ${proton_script}, found ${n}; GE-Proton ${GE_PROTON_VERSION} no longer matches the patch - NOT installing an unpatched or unknown build"
    sed -i 's/append_to_env_str(self.env, "WINEDLLOVERRIDES", "lsteamclient=d", ";")/pass/' "$proton_script"
    if grep -q 'lsteamclient=d' "$proton_script"; then
      die "lsteamclient=d still present in ${proton_script} after patching"
    fi
  fi
  got="$(sha256sum "$proton_script" | awk '{print $1}')"
  [ "$got" = "$GE_PROTON_PATCHED_PROTON_SHA256" ] \
    || die "patched proton script SHA256 mismatch: expected ${GE_PROTON_PATCHED_PROTON_SHA256} got ${got}; NOT installing"
}

install_ge_proton() {
  local marker="${GE_PROTON_DIR}/.sha256-verified" tarball ok=0
  if [ -x "${GE_PROTON_DIR}/proton" ] && [ -e "${GE_PROTON_DIR}/${LSTEAMCLIENT_PATCHED_MARKER}" ] \
     && [ "$(cat "$marker" 2>/dev/null || true)" = "$GE_PROTON_SHA256" ]; then
    log "GE-Proton ${GE_PROTON_VERSION} already installed and verified"
    return 0
  fi

  WORK_DIR="$(mktemp -d /var/tmp/ge-proton.XXXXXX)"
  tarball="${WORK_DIR}/${GE_PROTON_TARBALL}"

  if curl -fL --proto '=https' --tlsv1.2 --retry 5 --retry-delay 5 -o "$tarball" "$GE_PROTON_URL" && verify_sha256 "$tarball"; then
    ok=1
    if [ -n "$ENSHROUDED_MIRROR_S3_URI" ]; then
      aws s3 cp --only-show-errors "$tarball" "${ENSHROUDED_MIRROR_S3_URI%/}/${GE_PROTON_TARBALL}" \
        || warn "could not upload to S3 mirror (instance role may lack write there); continuing"
    fi
  else
    rm -f "$tarball"
    if [ -n "$ENSHROUDED_MIRROR_S3_URI" ]; then
      warn "upstream download failed or failed verification; trying S3 mirror"
      if aws s3 cp --only-show-errors "${ENSHROUDED_MIRROR_S3_URI%/}/${GE_PROTON_TARBALL}" "$tarball" && verify_sha256 "$tarball"; then
        ok=1
      fi
    fi
  fi
  [ "$ok" -eq 1 ] || die "could not obtain a GE-Proton ${GE_PROTON_VERSION} tarball matching SHA256 ${GE_PROTON_SHA256}; NOT installing an unverified binary"

  mkdir -p "${STEAMCMD_DIR}/compatibilitytools.d" "${WORK_DIR}/x"
  tar -xzf "$tarball" -C "${WORK_DIR}/x"
  [ -x "${WORK_DIR}/x/${GE_PROTON_EXTRACTED}/proton" ] || die "tarball did not contain ${GE_PROTON_EXTRACTED}/proton"
  # Patch only AFTER the SHA256 check above, and before the tree is moved into place.
  patch_lsteamclient "${WORK_DIR}/x/${GE_PROTON_EXTRACTED}/proton"
  touch "${WORK_DIR}/x/${GE_PROTON_EXTRACTED}/${LSTEAMCLIENT_PATCHED_MARKER}"
  echo "$GE_PROTON_SHA256" > "${WORK_DIR}/x/${GE_PROTON_EXTRACTED}/.sha256-verified"
  rm -rf "${GE_PROTON_DIR}.new"
  mv "${WORK_DIR}/x/${GE_PROTON_EXTRACTED}" "${GE_PROTON_DIR}.new"
  rm -rf "$GE_PROTON_DIR"
  mv "${GE_PROTON_DIR}.new" "$GE_PROTON_DIR"
  chown -R "${GAME_USER}:${GAME_USER}" "$GE_PROTON_DIR"
  log "installed GE-Proton ${GE_PROTON_VERSION} (SHA256 verified)"
}

# ---------------------------------------------------------------------------
# 7. systemd units (+ update helper). Units are embedded verbatim from
#    infrastructure/systemd/*.service; test/host-scripts.test.ts enforces equality.
#    Written/enabled only. This script never starts, stops or restarts the game.
# ---------------------------------------------------------------------------
CHANGED=0
write_if_changed() {   # write_if_changed <dest> <mode> ; content on stdin. Sets CHANGED=1 if it wrote.
  local dest="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    return 0
  fi
  install -D -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
  CHANGED=1
}

install_units() {
  mkdir -p /usr/local/lib/enshrouded

  # SteamCMD update helper, gated by the SSM flag (section 7). Before it changes any game file it
  # syncs savegame/ to S3 (section 7/8: a world-corrupting Keen patch must be a restore, not a loss).
  # --backup-only runs just the backup (used by deploy-game-server.sh, which runs its own steamcmd).
  write_if_changed /usr/local/lib/enshrouded/update-game.sh 0755 <<'UPDATE_EOF'
#!/bin/bash
set -euo pipefail
# +@sSteamCmdForcePlatformType windows is MANDATORY: app 2278520 has no Linux depot, and
# omitting it does not fail loudly - steamcmd just reports nothing to download.
BACKUP_ONLY=0
if [ "${1:-}" = "--backup-only" ]; then BACKUP_ONLY=1; fi
TOKEN="$(curl -fsS -m 5 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
REGION="$(curl -fsS -m 5 -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/placement/region || true)"
REGION="${REGION:-us-east-2}"
mountpoint -q /srv/enshrouded || { echo "/srv/enshrouded is not mounted; refusing to update" >&2; exit 1; }

# Pre-update backup. Copies the WHOLE savegame/ tree (every <worldid>* numbered copy plus the
# -index pointer; section 8). No --delete: the instance has no delete rights and versions are kept.
# Fail closed: if the backup cannot be taken, the update does not run. A cheap no-op when there is
# no save yet; on a cold boot the drain already synced, so this uploads nothing new.
backup_savegame() {
  local dir=/srv/enshrouded/savegame bucket
  if [ ! -d "$dir" ] || [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "no savegame yet; nothing to back up"
    return 0
  fi
  bucket="$(aws ssm get-parameter --region "$REGION" --name /enshroudedproj/server/backup-bucket --query Parameter.Value --output text)"     || { echo "cannot read backup-bucket parameter; refusing to update without a backup" >&2; return 1; }
  aws s3 sync --region "$REGION" --only-show-errors "$dir" "s3://${bucket}/savegame/"     || { echo "pre-update savegame sync failed; refusing to update" >&2; return 1; }
  echo "pre-update savegame backup complete"
}

if [ "$BACKUP_ONLY" -eq 1 ]; then
  backup_savegame
  exit 0
fi
FLAG="$(aws ssm get-parameter --region "$REGION" --name /enshroudedproj/server/auto-update-on-boot --query Parameter.Value --output text 2>/dev/null || true)"
if [ "$FLAG" = "false" ]; then
  echo "auto-update-on-boot is false; skipping update"
  exit 0
fi
backup_savegame
exec /opt/steamcmd/steamcmd.sh   +@sSteamCmdForcePlatformType windows   +force_install_dir /srv/enshrouded   +login anonymous   +app_update 2278520 validate   +quit
UPDATE_EOF

  # Game stop helper (ExecStop): resolve the game PID once, SIGINT it alone, wait on /proc/<pid>. ARCHITECTURE 4.3.1/4.3.2.
  write_if_changed /usr/local/lib/enshrouded/stop-game.sh 0755 <<'STOP_EOF'
#!/bin/bash
# stop-game.sh - ExecStop for enshrouded.service (WP-05a, ARCHITECTURE 4.3.1 / 4.3.2). Data-loss critical.
# systemd runs ExecStop to completion BEFORE applying KillSignal/KillMode. This SIGINTs the game
# process alone and WAITS for that same process to exit, so the save finishes before anything
# else is touched. It must never signal the Wine server process: that is Wine's kernel, and the
# save is performed through it.
# The PID is resolved ONCE, before anything is signalled, by exact match on the kernel's
# (15-char-truncated) comm, which is 'enshrouded_serv'. The Proton launcher's comm is 'python3',
# so it is not matched. Exactly one match is required; zero-with-the-game-visible or several
# aborts without signalling. The wait polls /proc/<pid>, never a pattern: a broken pattern must
# not be able to look like "the game exited" (that would let KillMode SIGKILL a mid-save game).
# Idempotent: exits 0 if the game is not running at all. Bound (110 s) is inside TimeoutStopSec=120.
COMM='enshrouded_serv'
mapfile -t pids < <(pgrep -x "$COMM" 2>/dev/null)
if [ "${#pids[@]}" -eq 0 ]; then
  # Nothing has the game's comm. Either it is not running (fine), or the selector is stale and
  # the game is running under another name (NOT fine). Tell them apart by command line.
  if pgrep -f '[e]nshrouded_server' >/dev/null 2>&1; then
    echo "stop-game: ABORT: no process has comm '$COMM' but a process mentions enshrouded_server; selector is stale; signalling nothing" >&2
    pgrep -af '[e]nshrouded_server' >&2
    exit 2
  fi
  echo "stop-game: game not running; nothing to do"
  exit 0
fi
if [ "${#pids[@]}" -ne 1 ]; then
  echo "stop-game: ABORT: expected exactly 1 process with comm '$COMM', found ${#pids[@]}; signalling nothing" >&2
  ps -o pid,comm,args -p "${pids[*]}" >&2
  exit 2
fi
pid="${pids[0]}"
echo "stop-game: sending SIGINT to game pid $pid"
kill -INT "$pid" || true
for _ in $(seq 1 110); do
  if [ ! -d "/proc/$pid" ]; then
    echo "stop-game: game exited"
    exit 0
  fi
  sleep 1
done
echo "stop-game: game pid $pid still running after 110s; leaving it to systemd" >&2
exit 1
STOP_EOF

  # On-box player probe (WP-08, section 5.6). Read-only reporter; WP-10 invokes it over SSM.
  # Byte-identical copy of scripts/probe-players.py (test/host-scripts.test.ts enforces it).
  write_if_changed /usr/local/lib/enshrouded/probe-players.py 0755 <<'PROBE_EOF'
#!/usr/bin/env python3
"""probe-players.py - on-box player probe (WP-08, ARCHITECTURE 5.6). Python 3, stdlib only.

Runs on the game host via SSM. Prints exactly ONE line of JSON with exactly these keys:

    a2sOk, players, logOk, mCount, udpRate, cpuRate

It only REPORTS. The ACTIVE / IDLE / INDETERMINATE classification is WP-10's job.

Signals (all measured; see 5.6):
  a2sOk/players  A2S_INFO on 127.0.0.1:15637, with the mandatory two-leg challenge handshake.
  logOk/mCount   count of m#N rows with N >= 1 in the NEWEST Session block of the game log.
                 m#0 is always present and is NOT a player.
  udpRate        /proc/net/snmp Udp InDatagrams, datagrams/sec over ~10 s.
  cpuRate        cgroup cpu.stat usage_usec, CPU cores over the same window.

Hard constraints:
  * Game-log timestamps are NOT wall-clock (uptime-relative). The newest block is found by FILE
    POSITION (last marker in the file tail). No timestamp is ever parsed or compared to `date`.
  * Never throws. Any failure -> a2sOk/logOk false with the numeric fields null, still valid JSON,
    so a crashed probe is distinguishable from an idle server. A failure is NEVER reported as 0.
  * fd count and RSS are deliberately NOT implemented: they do not separate 0 from 1 player.
"""
import json
import re
import socket
import sys
import time

A2S_HOST = "127.0.0.1"
A2S_PORT = 15637
A2S_TIMEOUT = 3.0
LOG_PATH = "/srv/enshrouded/logs/enshrouded_server.log"
SNMP_PATH = "/proc/net/snmp"
CPU_STAT_PATH = "/sys/fs/cgroup/system.slice/enshrouded.service/cpu.stat"
WINDOW_SECONDS = 10.0
LOG_TAIL_BYTES = 1024 * 1024
SESSION_MARKER = "-------------- Session ----------------"

A2S_QUERY = b"\xff\xff\xff\xffTSource Engine Query\x00"
_M_ROW = re.compile(r"(?<![\w#])m#(\d+)(?!\d)")


# --------------------------------------------------------------------------- A2S
def parse_a2s_info(data):
    """Parse S2A_INFO_SRC. Returns (players, max_players) or None if not a valid INFO reply."""
    if len(data) < 6 or data[:4] != b"\xff\xff\xff\xff" or data[4:5] != b"I":
        return None
    off = 6  # past header + protocol byte
    try:
        for _ in range(4):  # name, map, folder, game
            end = data.index(b"\x00", off)
            off = end + 1
        off += 2  # appid
        players = data[off]
        max_players = data[off + 1]
        return players, max_players
    except (ValueError, IndexError):
        return None


def a2s_players(host=A2S_HOST, port=A2S_PORT, timeout=A2S_TIMEOUT):
    """Two-leg A2S_INFO. Returns the players byte, or None on ANY failure (never 0 for a failure)."""
    sock = None
    try:
        deadline = time.monotonic() + timeout
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect((host, port))
        sock.settimeout(timeout)
        sock.send(A2S_QUERY)
        challenged = False
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            sock.settimeout(remaining)
            data = sock.recv(1400)
            if data[:5] == b"\xff\xff\xff\xffA" and len(data) >= 9 and not challenged:
                challenged = True  # challenge differs per request: use this reply's bytes, never cache
                sock.send(A2S_QUERY + data[5:9])
                continue
            parsed = parse_a2s_info(data)
            return parsed[0] if parsed else None
    except Exception:
        return None
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


# --------------------------------------------------------------------------- game log
def newest_session_block(text):
    """Text from the LAST Session marker to the end (by position, never by timestamp), or None."""
    pos = text.rfind(SESSION_MARKER)
    if pos < 0:
        return None
    return text[pos:]


def count_m_rows(block):
    """Number of distinct m#N rows with N >= 1. m#0 is always present and is not a player."""
    return len({int(n) for n in _M_ROW.findall(block) if int(n) >= 1})


def read_log_tail(path=LOG_PATH, nbytes=LOG_TAIL_BYTES):
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - nbytes))
        return f.read().decode("utf-8", errors="replace")


def log_m_count(path=LOG_PATH):
    """mCount from the newest Session block, or None if the log or a Session block is unavailable."""
    try:
        block = newest_session_block(read_log_tail(path))
        return None if block is None else count_m_rows(block)
    except Exception:
        return None


# --------------------------------------------------------------------------- rate maths
def counter_delta(before, after):
    """Delta of a monotonically increasing counter, tolerating 32/64-bit wraparound. None if unusable."""
    if before is None or after is None:
        return None
    d = after - before
    if d >= 0:
        return d
    return d + (2 ** 32 if before < 2 ** 32 else 2 ** 64)


def udp_rate(before, after, seconds):
    d = counter_delta(before, after)
    if d is None or seconds <= 0:
        return None
    return d / seconds


def cpu_rate(before_usec, after_usec, seconds):
    """CPU cores. cpu.stat usage_usec is 64-bit; a decrease means the cgroup restarted, so no wrap
    correction here - report None rather than a bogus number."""
    if before_usec is None or after_usec is None or seconds <= 0 or after_usec < before_usec:
        return None
    return (after_usec - before_usec) / 1e6 / seconds


def read_udp_in_datagrams(path=SNMP_PATH):
    try:
        with open(path, "r") as f:
            lines = [ln.split() for ln in f if ln.startswith("Udp:")]
        header, values = lines[0], lines[1]
        return int(values[header.index("InDatagrams")])
    except Exception:
        return None


def read_cpu_usage_usec(path=CPU_STAT_PATH):
    try:
        with open(path, "r") as f:
            for ln in f:
                parts = ln.split()
                if len(parts) == 2 and parts[0] == "usage_usec":
                    return int(parts[1])
    except Exception:
        pass
    return None


def _round(v, nd):
    return None if v is None else round(v, nd)


# --------------------------------------------------------------------------- main
def probe(window=WINDOW_SECONDS, log_path=LOG_PATH, snmp_path=SNMP_PATH, cpu_path=CPU_STAT_PATH,
          a2s_host=A2S_HOST, a2s_port=A2S_PORT):
    t0 = time.monotonic()
    udp0 = read_udp_in_datagrams(snmp_path)
    cpu0 = read_cpu_usage_usec(cpu_path)

    # The exact signals run inside the sampling window so the whole probe is ~window seconds.
    # (A2S adds 2 datagrams = ~0.2/s to udpRate; idle is 0.55/s vs a threshold of 10/s.)
    players = a2s_players(a2s_host, a2s_port)
    m_count = log_m_count(log_path)

    remaining = window - (time.monotonic() - t0)
    if remaining > 0:
        time.sleep(remaining)
    udp1 = read_udp_in_datagrams(snmp_path)
    cpu1 = read_cpu_usage_usec(cpu_path)
    elapsed = time.monotonic() - t0

    return {
        "a2sOk": players is not None,
        "players": players,
        "logOk": m_count is not None,
        "mCount": m_count,
        "udpRate": _round(udp_rate(udp0, udp1, elapsed), 2),
        "cpuRate": _round(cpu_rate(cpu0, cpu1, elapsed), 3),
    }


FAILED = {"a2sOk": False, "players": None, "logOk": False, "mCount": None, "udpRate": None, "cpuRate": None}


def main():
    try:
        result = probe()
    except BaseException:  # never throw: a crashed probe must still print valid JSON
        result = dict(FAILED)
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
PROBE_EOF

  # BEGIN UNIT: enshrouded.service
  write_if_changed /etc/systemd/system/enshrouded.service 0644 <<'UNIT_EOF'
[Unit]
Description=Enshrouded dedicated server (GE-Proton 11-9)
Documentation=file:///srv/enshrouded
After=network-online.target enshrouded-update.service
Wants=network-online.target enshrouded-update.service
# The world lives on the retained data volume. If it is not mounted, REFUSE to start
# rather than silently writing a brand-new world onto the root volume (fstab uses nofail).
RequiresMountsFor=/srv/enshrouded

[Service]
Type=simple
User=enshrouded
Group=enshrouded
WorkingDirectory=/srv/enshrouded

Environment=WINEDEBUG=-all
# GE-Proton 11 umu mode: the proton script is patched at install (lsteamclient override removed)
# and expects UMU_ID set. Launch the exe by RELATIVE name (WorkingDirectory above): an absolute
# path routes through umu.exe, which blocks the server at startup once lsteamclient is enabled.
Environment=UMU_ID=0
# Proton needs a client install path and a compat-data (Wine prefix) path.
# The prefix MUST be on the retained data volume so it survives instance replacement.
Environment=STEAM_COMPAT_CLIENT_INSTALL_PATH=/opt/steamcmd
Environment=STEAM_COMPAT_DATA_PATH=/srv/enshrouded/compatdata

# Loud failures, never a silent skip: wrong mount or missing binary must be an error.
ExecStartPre=/usr/bin/mountpoint -q /srv/enshrouded
ExecStartPre=/usr/bin/test -f /srv/enshrouded/enshrouded_server.exe
ExecStart=/opt/steamcmd/compatibilitytools.d/GE-Proton11-9/proton run enshrouded_server.exe

# ---- Shutdown path: invariant 1.3. Do not "simplify" any of these. ----
# ExecStop runs to completion BEFORE KillSignal/KillMode apply. It SIGINTs the game exe ALONE
# (never wineserver, Wine's kernel, which the save is written through) and waits for it to exit.
ExecStop=/usr/local/lib/enshrouded/stop-game.sh
# SIGINT, not systemd's SIGTERM default: the signal the binary is believed to save on.
KillSignal=SIGINT
# Backstop only: after ExecStop the game is already gone; this reaps the Proton launcher and
# wineserver so no orphan blocks the next start. Do not change to "mixed" or "process".
KillMode=control-group
# The save window; covers ExecStop (<=110s wait) PLUS the kill after it. SIGKILL (left enabled, deliberately) can only arrive after this.
# Keep well under AWS's ~4 minute force-stop window; do not raise past ~180.
TimeoutStopSec=120
# Never resurrect the server after a deliberate stop; it would fight the drain.
Restart=no

[Install]
WantedBy=multi-user.target
UNIT_EOF
  # END UNIT: enshrouded.service
  # BEGIN UNIT: enshrouded-update.service
  write_if_changed /etc/systemd/system/enshrouded-update.service 0644 <<'UNIT_EOF'
[Unit]
Description=Update Enshrouded dedicated server files (SteamCMD app 2278520)
After=network-online.target
Wants=network-online.target
# Must finish before the game starts, never while it runs.
Before=enshrouded.service
RequiresMountsFor=/srv/enshrouded

[Service]
Type=oneshot
RemainAfterExit=yes
User=enshrouded
Group=enshrouded
WorkingDirectory=/srv/enshrouded
# Honours /enshroudedproj/server/auto-update-on-boot, then runs steamcmd with
# +@sSteamCmdForcePlatformType windows (see /usr/local/lib/enshrouded/update-game.sh).
ExecStart=/usr/local/lib/enshrouded/update-game.sh
TimeoutStartSec=1800
UNIT_EOF
  # END UNIT: enshrouded-update.service

  systemctl daemon-reload
  systemctl enable enshrouded.service
  systemd-analyze verify /etc/systemd/system/enshrouded.service /etc/systemd/system/enshrouded-update.service \
    || warn "systemd-analyze verify reported issues (review above)"
  if [ "$CHANGED" -eq 1 ]; then
    log "units/helper (re)written; a running game was NOT restarted - changes apply on next start"
  fi
}

# ---------------------------------------------------------------------------
# 8. Host firewall: UDP 15636/15637 (the SG is the real boundary; this is defence in depth)
# ---------------------------------------------------------------------------
configure_firewall() {
  ufw allow 15636/udp comment 'Enshrouded game'
  ufw allow 15637/udp comment 'Enshrouded query'
  if ufw status | grep -q '^Status: active'; then
    log "ufw active; UDP 15636/15637 allowed"
  else
    log "ufw inactive (Ubuntu default); rules staged but ufw NOT enabled by this script"
  fi
}

# ---------------------------------------------------------------------------
# 9. CloudWatch agent: ship the game log (the game deletes it on every launch)
# ---------------------------------------------------------------------------
install_cloudwatch_agent() {
  local ctl=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl cfg deb
  if [ ! -x "$ctl" ]; then
    deb="$(mktemp --suffix=.deb)"
    curl -fsSL --proto '=https' --tlsv1.2 --retry 5 -o "$deb" \
      https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
    dpkg -i "$deb"
    rm -f "$deb"
  fi
  cfg=/opt/aws/amazon-cloudwatch-agent/etc/enshrouded-agent.json
  write_if_changed "$cfg" 0644 <<CW_EOF
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "${GAME_LOG_FILE}",
            "log_group_name": "${CW_LOG_GROUP}",
            "log_stream_name": "{instance_id}",
            "timezone": "UTC"
          }
        ]
      }
    }
  }
}
CW_EOF
  "$ctl" -a fetch-config -m ec2 -c "file:${cfg}" -s \
    || warn "cloudwatch agent did not start (log group / IAM are WP-15; the instance role has no logs permissions yet)"
}

# ---------------------------------------------------------------------------
main() {
  install_packages
  ensure_user
  ensure_data_volume
  ensure_game_dirs
  install_steamcmd
  install_steam_sdk_links
  install_ge_proton
  install_units
  configure_firewall
  install_cloudwatch_agent
  log "done. data volume: $(findmnt -n -o SOURCE,FSTYPE "$DATA_MOUNT"); GE-Proton ${GE_PROTON_VERSION} verified"
  log "enshrouded.service is enabled but NOT started (game install/config is WP-06)"
}
main "$@"
