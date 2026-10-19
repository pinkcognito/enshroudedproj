#!/bin/bash
# provision-host.sh - Enshrouded host provisioning (WP-05). Idempotent: safe to re-run.
#
# Delivered over SSM Run Command (there is no SSH). Runs as root on Ubuntu 24.04.
# Architecture refs: section 4 (shutdown), 6.1.2-6.1.4 (Proton, pinning, SSM Agent), 7 (install).
#
# NEVER-DO list (data-loss critical):
#   * never mkfs a device that has ANY signature or non-zero data in its first MiB
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

GE_PROTON_VERSION="10-26"
GE_PROTON_SHA256="e2ffd9d2a1ece30b5da3d3dc9cedaa82875008d1c984b5efc7666c028203f9db"
GE_PROTON_TARBALL="GE-Proton${GE_PROTON_VERSION}.tar.gz"
GE_PROTON_URL="https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton${GE_PROTON_VERSION}/${GE_PROTON_TARBALL}"
GE_PROTON_DIR="${STEAMCMD_DIR}/compatibilitytools.d/GE-Proton${GE_PROTON_VERSION}"
# Optional S3 mirror prefix, e.g. s3://<bucket>/mirror/ge-proton  (set by the SSM caller).
# Used as fallback when upstream is unreachable or serves bad bits; also best-effort upload target.
ENSHROUDED_MIRROR_S3_URI="${ENSHROUDED_MIRROR_S3_URI:-}"

# Optional hint: the data volume id (vol-0123...). Matches the NVMe serial. Never required.
ENSHROUDED_DATA_VOLUME_ID="${ENSHROUDED_DATA_VOLUME_ID:-}"
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
  # ASSUMED package set (reference container recipe + SteamCMD 32-bit needs); WP-07 confirms.
  apt-get "${apt_opts[@]}" install --no-install-recommends \
    ca-certificates curl tar gzip jq procps xdg-user-dirs python3 libfreetype6 \
    nvme-cli util-linux e2fsprogs ufw lib32gcc-s1 lib32stdc++6
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

# True ONLY if the device is provably empty: no filesystem/RAID/LVM signature (wipefs),
# nothing blkid recognises, and the first MiB is all zeroes. Any doubt => false.
device_is_blank() {
  local dev="$1" sigs nonzero rc=0
  sigs="$(wipefs --noheadings --no-act "$dev")" || return 1
  [ -z "$sigs" ] || return 1
  blkid -p "$dev" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 2 ] || return 1
  nonzero="$(head -c 1048576 "$dev" | tr -d '\0' | wc -c)" || return 1
  [ "$nonzero" -eq 0 ]
}

# The ONLY place a filesystem is ever created. No -F: mke2fs itself also refuses to
# overwrite a detected filesystem when it is not forced.
format_if_blank() {
  local dev="$1"
  device_is_blank "$dev" || die "refusing to format $dev: not provably blank"
  log "first boot: $dev is blank, creating ext4 (label enshrouded-data)"
  mkfs.ext4 -q -L enshrouded-data "$dev"
  udevadm settle || true
}

ensure_data_volume() {
  local dev fstype rc pttype uuid
  if mountpoint -q "$DATA_MOUNT"; then
    fstype="$(findmnt -n -o FSTYPE "$DATA_MOUNT")"
    case "$fstype" in
      ext4|xfs) log "$DATA_MOUNT already mounted ($fstype); leaving it untouched"; return 0 ;;
      *) die "$DATA_MOUNT is mounted with unexpected fs type '$fstype'" ;;
    esac
  fi

  dev="$(wait_for_data_device)" || die "could not identify the data volume (no unambiguous non-root disk)"
  log "data volume device: $dev"
  if lsblk -nro MOUNTPOINT "$dev" | grep -q .; then
    die "$dev (or a partition) is mounted somewhere else; refusing to touch it"
  fi

  rc=0
  fstype="$(blkid -p -o value -s TYPE "$dev" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$fstype" ]; then
    case "$fstype" in
      ext4|xfs) log "existing $fstype filesystem on $dev - will NOT format" ;;
      *) die "$dev holds an unexpected filesystem '$fstype'; refusing to touch it" ;;
    esac
  elif [ "$rc" -eq 2 ]; then
    pttype="$(blkid -p -o value -s PTTYPE "$dev" 2>/dev/null || true)"
    [ -z "$pttype" ] || die "$dev has a partition table ($pttype); refusing to touch it"
    format_if_blank "$dev"
  else
    die "blkid failed (rc=$rc) on $dev; refusing to guess"
  fi

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

  mkdir -p "${DATA_MOUNT}/compatdata" "${DATA_MOUNT}/logs"
  chown "${GAME_USER}:${GAME_USER}" "$DATA_MOUNT" "${DATA_MOUNT}/compatdata" "${DATA_MOUNT}/logs"
  log "data volume mounted at $DATA_MOUNT (UUID ${uuid})"
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

install_ge_proton() {
  local marker="${GE_PROTON_DIR}/.sha256-verified" tarball ok=0
  if [ -x "${GE_PROTON_DIR}/proton" ] && [ "$(cat "$marker" 2>/dev/null || true)" = "$GE_PROTON_SHA256" ]; then
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
  [ -x "${WORK_DIR}/x/GE-Proton${GE_PROTON_VERSION}/proton" ] || die "tarball did not contain GE-Proton${GE_PROTON_VERSION}/proton"
  echo "$GE_PROTON_SHA256" > "${WORK_DIR}/x/GE-Proton${GE_PROTON_VERSION}/.sha256-verified"
  rm -rf "${GE_PROTON_DIR}.new"
  mv "${WORK_DIR}/x/GE-Proton${GE_PROTON_VERSION}" "${GE_PROTON_DIR}.new"
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

  # Game stop helper (ExecStop): SIGINT the exe alone, wait for exit. ARCHITECTURE 4.3.1.
  write_if_changed /usr/local/lib/enshrouded/stop-game.sh 0755 <<'STOP_EOF'
#!/bin/bash
# stop-game.sh - ExecStop for enshrouded.service (WP-05a, ARCHITECTURE 4.3.1). Data-loss critical.
# systemd runs ExecStop to completion BEFORE applying KillSignal/KillMode. This signals ONLY the
# game executable (SIGINT) and WAITS for it to exit, so the save finishes before anything else
# is touched. It must never signal the Wine server process: that is Wine's kernel, and the save
# is performed through it. The '[e]' bracket stops pkill/pgrep matching their own command line;
# -f matches the full command line (the game and the Proton launcher, not the Wine server).
# Idempotent: exits 0 if the game is not running. Bound (110 s) sits inside TimeoutStopSec=120.
PATTERN='[e]nshrouded_server\.exe'
if ! pgrep -f "$PATTERN" >/dev/null 2>&1; then
  echo "stop-game: game not running; nothing to do"
  exit 0
fi
pkill -INT -f "$PATTERN" || true
for _ in $(seq 1 110); do
  if ! pgrep -f "$PATTERN" >/dev/null 2>&1; then
    echo "stop-game: game exited"
    exit 0
  fi
  sleep 1
done
echo "stop-game: game still running after 110s; leaving it to systemd" >&2
exit 1
STOP_EOF

  # BEGIN UNIT: enshrouded.service
  write_if_changed /etc/systemd/system/enshrouded.service 0644 <<'UNIT_EOF'
[Unit]
Description=Enshrouded dedicated server (GE-Proton 10-26)
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
# Proton needs a client install path and a compat-data (Wine prefix) path.
# The prefix MUST be on the retained data volume so it survives instance replacement.
Environment=STEAM_COMPAT_CLIENT_INSTALL_PATH=/opt/steamcmd
Environment=STEAM_COMPAT_DATA_PATH=/srv/enshrouded/compatdata

# Loud failures, never a silent skip: wrong mount or missing binary must be an error.
ExecStartPre=/usr/bin/mountpoint -q /srv/enshrouded
ExecStartPre=/usr/bin/test -f /srv/enshrouded/enshrouded_server.exe
ExecStart=/opt/steamcmd/compatibilitytools.d/GE-Proton10-26/proton run /srv/enshrouded/enshrouded_server.exe

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
  install_steamcmd
  install_ge_proton
  install_units
  configure_firewall
  install_cloudwatch_agent
  log "done. data volume: $(findmnt -n -o SOURCE,FSTYPE "$DATA_MOUNT"); GE-Proton ${GE_PROTON_VERSION} verified"
  log "enshrouded.service is enabled but NOT started (game install/config is WP-06)"
}
main "$@"
