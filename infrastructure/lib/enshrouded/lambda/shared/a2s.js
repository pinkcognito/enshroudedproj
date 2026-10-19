// Dependency-free Valve A2S_INFO client (WP-08, ARCHITECTURE 5.6). Plain CommonJS.
//
// Rules that matter (all measured on the live server, see 5.6):
//  - The two-leg challenge handshake is MANDATORY. A bare query returns header 'A' + a 4-byte
//    challenge that CHANGES PER REQUEST; the query must be re-sent with it appended to get
//    S2A_INFO_SRC (header 'I'). Skipping it looks like "no response" == "empty server", which is
//    the dangerous direction. The challenge is never cached.
//  - A2S_PLAYER is deliberately NOT implemented: it returns the count with empty names.
//  - A failed probe is NOT a zero. queryInfo() never rejects and never returns players=0 for a
//    failure: callers must check `ok` before trusting `players`.
const dgram = require('dgram');

const HEADER_SIMPLE = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const A2S_INFO_QUERY = Buffer.concat([HEADER_SIMPLE, Buffer.from('TSource Engine Query\0', 'latin1')]);
const RESP_CHALLENGE = 0x41; // 'A'
const RESP_INFO = 0x49; // 'I'

const REASON = {
  TIMEOUT: 'timeout',
  UNREACHABLE: 'unreachable',
  MALFORMED: 'malformed',
  UNEXPECTED: 'unexpected-header',
};

/** The query, optionally with a challenge appended. */
function buildInfoRequest(challenge) {
  if (challenge === undefined || challenge === null) return Buffer.from(A2S_INFO_QUERY);
  if (!Buffer.isBuffer(challenge) || challenge.length !== 4) throw new Error('challenge must be a 4-byte Buffer');
  return Buffer.concat([A2S_INFO_QUERY, challenge]);
}

/**
 * Classify a datagram. Returns
 *   { kind: 'challenge', challenge: Buffer(4) } | { kind: 'info', info } | { kind: 'error', reason }
 * Never throws.
 */
function parseResponse(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 5) return { kind: 'error', reason: REASON.MALFORMED };
    if (buf.compare(HEADER_SIMPLE, 0, 4, 0, 4) !== 0) return { kind: 'error', reason: REASON.MALFORMED };
    const header = buf[4];
    if (header === RESP_CHALLENGE) {
      if (buf.length < 9) return { kind: 'error', reason: REASON.MALFORMED };
      return { kind: 'challenge', challenge: Buffer.from(buf.subarray(5, 9)) };
    }
    if (header === RESP_INFO) {
      const info = parseInfo(buf);
      return info ? { kind: 'info', info } : { kind: 'error', reason: REASON.MALFORMED };
    }
    return { kind: 'error', reason: REASON.UNEXPECTED };
  } catch {
    return { kind: 'error', reason: REASON.MALFORMED };
  }
}

/** Parse S2A_INFO_SRC. Returns null if truncated/garbage. Never throws. */
function parseInfo(buf) {
  let off = 5; // past ff ff ff ff 'I'
  const u8 = () => {
    if (off >= buf.length) throw new RangeError('truncated');
    return buf[off++];
  };
  const str = () => {
    const end = buf.indexOf(0, off);
    if (end < 0) throw new RangeError('truncated');
    const s = buf.toString('utf8', off, end);
    off = end + 1;
    return s;
  };
  try {
    const protocol = u8();
    const name = str();
    const map = str();
    const folder = str();
    const game = str();
    const appId = u8() | (u8() << 8);
    const players = u8();
    const maxPlayers = u8();
    const bots = u8();
    const serverType = String.fromCharCode(u8());
    const environment = String.fromCharCode(u8());
    const visibility = u8();
    const vac = u8();
    const version = str();
    return { protocol, name, map, folder, game, appId, players, maxPlayers, bots, serverType, environment, visibility, vac, version };
  } catch {
    return null;
  }
}

/**
 * Query A2S_INFO with the mandatory challenge handshake. Resolves (never rejects) to
 *   { ok: true, players, maxPlayers, info }
 *   { ok: false, reason: 'timeout' | 'unreachable' | 'malformed' | 'unexpected-header' }
 * `timeoutMs` bounds the WHOLE exchange (both legs). A fresh socket is used per call and the
 * challenge only ever lives inside one call.
 */
function queryInfo({ host = '127.0.0.1', port = 15637, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let sock = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        if (sock) sock.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const fail = (reason) => finish({ ok: false, reason });
    try {
      sock = dgram.createSocket('udp4');
      timer = setTimeout(() => fail(REASON.TIMEOUT), timeoutMs);
      sock.on('error', () => fail(REASON.UNREACHABLE)); // e.g. ICMP port unreachable -> ECONNREFUSED
      let challenged = false;
      sock.on('message', (msg) => {
        const r = parseResponse(msg);
        if (r.kind === 'error') return fail(r.reason);
        if (r.kind === 'info') {
          return finish({ ok: true, players: r.info.players, maxPlayers: r.info.maxPlayers, info: r.info });
        }
        // challenge: answer once, with THIS reply's bytes. A second challenge means the server is
        // not honouring the handshake - give up rather than loop.
        if (challenged) return fail(REASON.UNEXPECTED);
        challenged = true;
        sock.send(buildInfoRequest(r.challenge), (err) => {
          if (err) fail(REASON.UNREACHABLE);
        });
      });
      sock.connect(port, host, () => {
        sock.send(buildInfoRequest(), (err) => {
          if (err) fail(REASON.UNREACHABLE);
        });
      });
    } catch {
      fail(REASON.UNREACHABLE);
    }
  });
}

module.exports = { queryInfo, buildInfoRequest, parseResponse, parseInfo, A2S_INFO_QUERY, REASON };
