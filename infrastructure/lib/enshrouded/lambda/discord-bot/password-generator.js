const { randomInt } = require('node:crypto');
// User ruling: 16 alphanumeric characters for every tier (~95 bits each).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD_LENGTH = 16;

function passwordEntropyBits() {
  return PASSWORD_LENGTH * Math.log2(ALPHABET.length);
}

function draw() {
  const picked = [];
  // randomInt is rejection-sampled, hence unbiased. Repeats are allowed on purpose.
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) picked.push(ALPHABET[randomInt(ALPHABET.length)]);
  return picked.join('');
}

function generatePasswords() {
  return {
    admin: draw(),
    friend: draw(),
    guest: draw(),
    visitor: draw(),
  };
}

module.exports = { generatePasswords, ALPHABET, PASSWORD_LENGTH, passwordEntropyBits };
