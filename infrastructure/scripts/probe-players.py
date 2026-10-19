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
