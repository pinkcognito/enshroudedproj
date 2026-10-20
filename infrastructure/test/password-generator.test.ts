export {};

const generatorPath = '../lib/enshrouded/lambda/discord-bot/password-generator';
const { generatePasswords, ALPHABET, PASSWORD_LENGTH, passwordEntropyBits } = jest.requireActual(generatorPath);
const crypto = jest.requireActual('node:crypto');
const TIERS = ['admin', 'friend', 'guest', 'visitor'] as const;
const EXPECTED_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

afterEach(() => jest.restoreAllMocks());

test('every tier has exactly 16 ASCII alphanumeric characters', () => {
  for (let sample = 0; sample < 8; sample++) {
    const passwords = generatePasswords();
    expect(Object.keys(passwords)).toEqual(TIERS);
    for (const tier of TIERS) expect(passwords[tier]).toMatch(/^[A-Za-z0-9]{16}$/);
  }
});

test('the shipped alphabet and length provide at least 95 bits, exceeding all tier floors', () => {
  expect(ALPHABET).toBe(EXPECTED_ALPHABET);
  expect(new Set(ALPHABET).size).toBe(62);
  expect(PASSWORD_LENGTH).toBe(16);
  const bits = PASSWORD_LENGTH * Math.log2(ALPHABET.length);
  expect(bits).toBeGreaterThanOrEqual(95);
  expect(bits).toBeGreaterThanOrEqual(50); // Existing admin floor.
  expect(bits).toBeGreaterThanOrEqual(38); // Existing player floor.
  expect(passwordEntropyBits()).toBeCloseTo(bits, 10);
});

test('64 separate CSPRNG draws use the whole alphabet with exclusive bound 62', () => {
  // Synthetic sequential indices cover every character and both bounds, not stored secrets.
  let next = 0;
  const randomInt = jest.spyOn(crypto, 'randomInt').mockImplementation(() => next++ % 62);
  jest.isolateModules(() => {
    const generator = jest.requireActual(generatorPath);
    const passwords = generator.generatePasswords();
    expect(randomInt).toHaveBeenCalledTimes(64);
    for (const args of randomInt.mock.calls) expect(args).toEqual([62]);
    expect(passwords).toEqual({
      admin: EXPECTED_ALPHABET.slice(0, 16),
      friend: EXPECTED_ALPHABET.slice(16, 32),
      guest: EXPECTED_ALPHABET.slice(32, 48),
      visitor: EXPECTED_ALPHABET.slice(48) + EXPECTED_ALPHABET.slice(0, 2),
    });
    generator.generatePasswords();
    expect(randomInt).toHaveBeenCalledTimes(128); // No reuse between invocations.
  });
});

test('repeated draws are allowed without retries or deriving another tier', () => {
  const randomInt = jest.spyOn(crypto, 'randomInt').mockReturnValue(61);
  jest.isolateModules(() => {
    const passwords = jest.requireActual(generatorPath).generatePasswords();
    for (const tier of TIERS) expect(passwords[tier]).toBe('9'.repeat(16));
    expect(randomInt).toHaveBeenCalledTimes(64);
  });
});

test('CSPRNG failure propagates without falling back to weaker randomness', () => {
  jest.spyOn(crypto, 'randomInt').mockImplementation(() => { throw new Error('synthetic-rng-failure'); });
  const weakRandom = jest.spyOn(Math, 'random');
  jest.isolateModules(() => {
    expect(() => jest.requireActual(generatorPath).generatePasswords()).toThrow('synthetic-rng-failure');
    expect(weakRandom).not.toHaveBeenCalled();
  });
});

test('generation does not log', () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    jest.spyOn(console, method).mockImplementation(() => {}));
  generatePasswords();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
