import * as fs from 'fs';
import * as path from 'path';

const dir = path.join(__dirname, '..', 'lib', 'enshrouded', 'lambda', 'discord-bot');
const { generatePasswords, WORDS, passwordEntropyBits } =
  jest.requireActual('../lib/enshrouded/lambda/discord-bot/password-generator');

const TIERS = ['admin', 'friend', 'guest', 'visitor'] as const;
const wordSet = new Set<string>(WORDS);

// Floors are ARCHITECTURE.md 1.14 / 7.4.1. They are literals on purpose: the thing under
// test is the shipped list, never a constant derived from it.
const PLAYER_FLOOR_BITS = 38;
const ADMIN_FLOOR_BITS = 50;
const MIN_LIST_LENGTH = 6502; // 2^(38/3)

describe('entropy floor, computed from the shipped list', () => {
  // Why: a later trim of the wordlist (homophones, length, taste) loses entropy silently and every
  // functional test still passes. These recompute words x log2(len) from the real list every run.
  test('three words clear 38 bits', () => {
    expect(3 * Math.log2(WORDS.length)).toBeGreaterThanOrEqual(PLAYER_FLOOR_BITS);
  });
  test('four words clear 50 bits', () => {
    expect(4 * Math.log2(WORDS.length)).toBeGreaterThanOrEqual(ADMIN_FLOOR_BITS);
  });
  test('passwordEntropyBits agrees with the direct computation', () => {
    expect(passwordEntropyBits(3)).toBeCloseTo(3 * Math.log2(WORDS.length), 9);
    expect(passwordEntropyBits(4)).toBeCloseTo(4 * Math.log2(WORDS.length), 9);
  });
  // Why: a shrinking list should be a loud, named failure rather than only a bits failure.
  test('the list has at least 6,502 words', () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(MIN_LIST_LENGTH);
  });
});

describe('wordlist hygiene', () => {
  test('every word is unique lowercase ASCII letters (no hyphen: it is the separator)', () => {
    expect(wordSet.size).toBe(WORDS.length);
    for (const word of WORDS) expect(word).toMatch(/^[a-z]+$/);
  });
  // Why: spoken over voice chat; two words one letter apart are misheard as each other.
  test('no two words differ by exactly one substituted letter', () => {
    const clashes: string[] = [];
    for (const word of WORDS as string[]) {
      for (let i = 0; i < word.length; i += 1) {
        for (let c = 97; c <= 122; c += 1) {
          const other = word.slice(0, i) + String.fromCharCode(c) + word.slice(i + 1);
          if (other !== word && wordSet.has(other)) clashes.push(`${word}/${other}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });
  // Why: CC-BY is a legal obligation that travels with the vendored data.
  test('the vendored list carries its CC-BY attribution', () => {
    const source = fs.readFileSync(path.join(dir, 'eff-large-wordlist.js'), 'utf8');
    expect(source).toMatch(/Electronic Frontier Foundation/);
    expect(source).toMatch(/CC BY 3\.0/);
    expect(source).toMatch(/Changes:/);
  });
  test('words that read as credential-hostile are absent', () => {
    for (const word of ['password', 'passcode', 'badass', 'handgun', 'enslave']) {
      expect(wordSet.has(word)).toBe(false);
    }
  });
});

describe('password shape', () => {
  test('three words for friend/guest/visitor, four for admin, hyphenated lowercase ASCII from the list', () => {
    for (let n = 0; n < 200; n += 1) {
      const passwords = generatePasswords();
      expect(Object.keys(passwords).sort()).toEqual([...TIERS].sort());
      for (const tier of TIERS) {
        const value: string = passwords[tier];
        expect(value).toMatch(/^[a-z]+(-[a-z]+)*$/);
        const parts = value.split('-');
        expect(parts).toHaveLength(tier === 'admin' ? 4 : 3);
        for (const part of parts) expect(wordSet.has(part)).toBe(true);
      }
    }
  });
});

describe('independence', () => {
  // Why: the tier cascade hands a Visitor the visitor password, so any derivation between
  // values would turn that into a path toward the admin one (7.4.2).
  test('the four values are distinct and no value is a prefix or suffix of another', () => {
    for (let n = 0; n < 2000; n += 1) {
      const p = generatePasswords();
      expect(new Set(TIERS.map((t) => p[t])).size).toBe(4);
      for (const a of TIERS) {
        for (const b of TIERS) {
          if (a === b) continue;
          expect(p[a].startsWith(p[b])).toBe(false);
          expect(p[a].endsWith(p[b])).toBe(false);
        }
      }
    }
  });
  test('no word position is shared by construction between tiers', () => {
    // A shared draw would make same-index words equal in every sample. By chance the rate is
    // ~1/6.6k per comparison (about 1 per 3000 samples x 3 positions); 30 is far beyond that.
    const equal = { fg: 0, gv: 0, af: 0 };
    for (let n = 0; n < 3000; n += 1) {
      const p = generatePasswords();
      const [f, g, v, a] = [p.friend, p.guest, p.visitor, p.admin].map((s: string) => s.split('-'));
      for (let i = 0; i < 3; i += 1) {
        if (f[i] === g[i]) equal.fg += 1;
        if (g[i] === v[i]) equal.gv += 1;
        if (a[i] === f[i]) equal.af += 1;
      }
    }
    expect(equal.fg).toBeLessThan(30);
    expect(equal.gv).toBeLessThan(30);
    expect(equal.af).toBeLessThan(30);
  });
});

describe('randomness source', () => {
  const source = fs.readFileSync(path.join(dir, 'password-generator.js'), 'utf8');
  const code = source.replace(/\/\/.*$/gm, '');
  // Why: modulo bias and Math.random are silent entropy losses that pass every functional test.
  test('no % operator and no Math.random in the module', () => {
    expect(code).not.toContain('%');
    expect(code).not.toContain('Math.random');
  });
  test('draws come from crypto.randomInt over the whole list', () => {
    expect(code).toMatch(/randomInt\(WORDS\.length\)/);
  });
});

describe('distribution sanity', () => {
  // Statistical but non-flaky: bounds sit many standard deviations from the expectation of a
  // correct uniform draw, and no seed is involved.
  test('every position produces many distinct words and none dominates', () => {
    const N = 12000;
    const positions: Array<Map<string, number>> = [0, 1, 2, 3].map(() => new Map());
    for (let n = 0; n < N; n += 1) {
      const parts: string[] = generatePasswords().admin.split('-');
      parts.forEach((w, i) => positions[i].set(w, (positions[i].get(w) ?? 0) + 1));
    }
    for (const counts of positions) {
      // Expected distinct is ~5.2k of 6.6k; a stuck or tiny pool fails hard.
      expect(counts.size).toBeGreaterThan(3500);
      // Expected per-word count ~1.8, the max over 6.6k words is about 9; 40 is unreachable by chance.
      expect(Math.max(...counts.values())).toBeLessThan(40);
    }
  });
  test('first-letter frequencies follow the list within 6 sigma', () => {
    const N = 20000;
    const seen = new Map<string, number>();
    for (let n = 0; n < N; n += 1) {
      const c = generatePasswords().friend[0];
      seen.set(c, (seen.get(c) ?? 0) + 1);
    }
    const inList = new Map<string, number>();
    for (const w of WORDS as string[]) inList.set(w[0], (inList.get(w[0]) ?? 0) + 1);
    for (const [letter, count] of inList) {
      const p = count / WORDS.length;
      const sigma = Math.sqrt(N * p * (1 - p));
      expect(Math.abs((seen.get(letter) ?? 0) - N * p)).toBeLessThan(6 * sigma + 1);
    }
  });
});

describe('no secret logging', () => {
  test('generating passwords writes nothing to the console', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => {}));
    generatePasswords();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
  test('the module source has no console calls', () => {
    const source = fs.readFileSync(path.join(dir, 'password-generator.js'), 'utf8');
    expect(source).not.toContain('console.');
  });
});
