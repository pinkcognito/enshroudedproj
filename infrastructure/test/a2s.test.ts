// WP-08: the A2S client (lambda/shared/a2s.js) against fixture bytes and a fake UDP server.
import * as dgram from 'dgram';
import * as crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const a2s = require('../lib/enshrouded/lambda/shared/a2s');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { queryInfo, buildInfoRequest, parseResponse, parseInfo, A2S_INFO_QUERY, REASON } = a2s as Record<string, any>;

const HDR = Buffer.from([0xff, 0xff, 0xff, 0xff]);

// Real reply observed on the live server (1 player, max 16). The version tail is "0.0.15.0\0".
function infoReply(players: number): Buffer {
  return Buffer.concat([
    HDR,
    Buffer.from("I\x11Dave's Enshrouded Server\x00\x00Enshrouded\x00Enshrouded\x00\x00\x00", 'latin1'),
    Buffer.from([players, 0x10, 0x00]), // players, max=16, bots=0
    Buffer.from('dl\x01\x000.0.15.0\x00', 'latin1'), // type d, env l, visibility 1, vac 0, version
  ]);
}
const INFO_1 = infoReply(1);
const INFO_0 = infoReply(0);
const challengeReply = (c: Buffer) => Buffer.concat([HDR, Buffer.from('A', 'latin1'), c]);

describe('a2s request building', () => {
  test('bare query is ff ff ff ff "TSource Engine Query" NUL', () => {
    expect(buildInfoRequest().toString('latin1')).toBe('\xff\xff\xff\xffTSource Engine Query\x00');
  });
  test('challenge is appended verbatim to the query', () => {
    const c = Buffer.from([1, 2, 3, 4]);
    expect(buildInfoRequest(c).equals(Buffer.concat([A2S_INFO_QUERY, c]))).toBe(true);
  });
  test('a malformed challenge is rejected', () => {
    expect(() => buildInfoRequest(Buffer.from([1, 2]))).toThrow();
  });
});

describe('a2s parsing fixtures', () => {
  test('fixtures differ only in the players byte', () => {
    const diffs = [...INFO_1.keys()].filter((i) => INFO_1[i] !== INFO_0[i]);
    expect(diffs).toHaveLength(1);
    expect(INFO_1[diffs[0]]).toBe(1);
    expect(INFO_0[diffs[0]]).toBe(0);
  });
  test('1-player INFO parses to players=1 max=16 with the observed fields', () => {
    const r = parseResponse(INFO_1);
    expect(r.kind).toBe('info');
    expect(r.info).toMatchObject({
      protocol: 17, name: "Dave's Enshrouded Server", map: '', folder: 'Enshrouded', game: 'Enshrouded',
      appId: 0, players: 1, maxPlayers: 16, bots: 0, serverType: 'd', environment: 'l', visibility: 1, vac: 0,
      version: '0.0.15.0',
    });
  });
  test('0-player INFO parses to players=0', () => {
    expect(parseResponse(INFO_0).info.players).toBe(0);
  });
  test('challenge reply yields the 4 challenge bytes', () => {
    const r = parseResponse(challengeReply(Buffer.from([0xde, 0xad, 0xbe, 0xef])));
    expect(r.kind).toBe('challenge');
    expect(r.challenge.toString('hex')).toBe('deadbeef');
  });
  test('truncated replies are malformed, never a players value', () => {
    for (const n of [0, 3, 5, 6, 20, INFO_1.length - 12, INFO_1.length - 1]) {
      const r = parseResponse(INFO_1.subarray(0, n));
      expect(r.kind).toBe('error');
      expect(r.info).toBeUndefined();
    }
    expect(parseInfo(INFO_1.subarray(0, 30))).toBeNull();
    expect(parseResponse(challengeReply(Buffer.from([1, 2, 3, 4])).subarray(0, 7)).kind).toBe('error');
  });
  test('garbage never throws and is never an info result', () => {
    const garbage = [Buffer.from('hello world'), crypto.randomBytes(64), Buffer.alloc(40, 0xff), Buffer.concat([HDR, Buffer.from('Z1234')])];
    for (const g of garbage) {
      expect(parseResponse(g).kind).toBe('error');
    }
  });
});

// ---------------------------------------------------------------------------
// Fake A2S server on a loopback UDP port. `onQuery` decides what to send.
// ---------------------------------------------------------------------------
interface Fake { port: number; received: Buffer[]; close: () => Promise<void>; }
async function fakeServer(onQuery: (msg: Buffer, reply: (b: Buffer) => void, state: { challenges: Buffer[] }) => void): Promise<Fake> {
  const sock = dgram.createSocket('udp4');
  const received: Buffer[] = [];
  const state = { challenges: [] as Buffer[] };
  sock.on('message', (msg, rinfo) => {
    received.push(msg);
    onQuery(msg, (b) => sock.send(b, rinfo.port, rinfo.address), state);
  });
  await new Promise<void>((res) => sock.bind(0, '127.0.0.1', res));
  return { port: sock.address().port, received, close: () => new Promise<void>((res) => sock.close(() => res())) };
}

/** Behaves like the real game: bare query -> fresh random challenge; query + correct challenge -> INFO. */
const honest = (info: Buffer) => (msg: Buffer, reply: (b: Buffer) => void, state: { challenges: Buffer[] }) => {
  if (msg.length === A2S_INFO_QUERY.length) {
    const c = crypto.randomBytes(4);
    state.challenges.push(c);
    reply(challengeReply(c));
  } else if (msg.length === A2S_INFO_QUERY.length + 4 && state.challenges.some((c) => msg.subarray(A2S_INFO_QUERY.length).equals(c))) {
    reply(info);
  } // else: silence, exactly like a server that ignores a bad/skipped challenge
};

describe('queryInfo against a fake server', () => {
  let srv: Fake | undefined;
  afterEach(async () => { if (srv) await srv.close(); srv = undefined; });

  test('both legs: bare query, then re-send with the challenge, returns players=1', async () => {
    srv = await fakeServer(honest(INFO_1));
    const r = await queryInfo({ host: '127.0.0.1', port: srv.port, timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: true, players: 1, maxPlayers: 16 });
    expect(srv.received).toHaveLength(2);
    expect(srv.received[0].equals(A2S_INFO_QUERY)).toBe(true);
    expect(srv.received[1].length).toBe(A2S_INFO_QUERY.length + 4);
  });

  test('0 players is a successful parse (ok:true, players:0)', async () => {
    srv = await fakeServer(honest(INFO_0));
    const r = await queryInfo({ port: srv.port, timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: true, players: 0 });
  });

  test('the challenge differs per request and is never cached', async () => {
    srv = await fakeServer(honest(INFO_1));
    await queryInfo({ port: srv.port, timeoutMs: 2000 });
    await queryInfo({ port: srv.port, timeoutMs: 2000 });
    const sent = srv.received.filter((m) => m.length === A2S_INFO_QUERY.length + 4).map((m) => m.subarray(A2S_INFO_QUERY.length).toString('hex'));
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]); // each call echoed its own fresh challenge
  });

  test('a server that never answers is a timeout, NOT players=0', async () => {
    srv = await fakeServer(() => undefined);
    const t0 = Date.now();
    const r = await queryInfo({ port: srv.port, timeoutMs: 300 });
    expect(r).toEqual({ ok: false, reason: REASON.TIMEOUT });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test('nothing listening is unreachable/timeout (ok:false), never ok', async () => {
    const s = dgram.createSocket('udp4');
    await new Promise<void>((res) => s.bind(0, '127.0.0.1', res));
    const port = s.address().port;
    await new Promise<void>((res) => s.close(() => res()));
    const r = await queryInfo({ port, timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect([REASON.UNREACHABLE, REASON.TIMEOUT]).toContain(r.reason);
  });

  test('garbage reply is ok:false/malformed', async () => {
    srv = await fakeServer((_m, reply) => reply(Buffer.from('not a source reply')));
    const r = await queryInfo({ port: srv.port, timeoutMs: 1000 });
    expect(r).toEqual({ ok: false, reason: REASON.MALFORMED });
  });

  test('truncated INFO after a good challenge is ok:false/malformed', async () => {
    srv = await fakeServer((msg, reply) => {
      if (msg.length === A2S_INFO_QUERY.length) reply(challengeReply(Buffer.from([9, 9, 9, 9])));
      else reply(INFO_1.subarray(0, 40));
    });
    const r = await queryInfo({ port: srv.port, timeoutMs: 1000 });
    expect(r).toEqual({ ok: false, reason: REASON.MALFORMED });
  });

  test('a server that keeps challenging is abandoned, not looped', async () => {
    srv = await fakeServer((_m, reply) => reply(challengeReply(crypto.randomBytes(4))));
    const r = await queryInfo({ port: srv.port, timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(srv.received.length).toBeLessThanOrEqual(2);
  });
});
