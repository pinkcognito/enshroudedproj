const { randomInt } = require('node:crypto');
const WORDS = require('./eff-large-wordlist');

// ARCHITECTURE.md 7.4.1 / 7.4.2. Three words for friend/guest/visitor, four for admin.
// Uniform draws WITH replacement from the vendored list; the four passwords are
// four independent draws and nothing is derived from, or shared between, them.
const WORD_COUNTS = Object.freeze({ admin: 4, friend: 3, guest: 3, visitor: 3 });

function passwordEntropyBits(wordCount, listLength = WORDS.length) {
  return wordCount * Math.log2(listLength);
}

function draw(wordCount) {
  const picked = [];
  // randomInt is rejection-sampled, hence unbiased. Repeats are allowed on purpose.
  for (let i = 0; i < wordCount; i += 1) picked.push(WORDS[randomInt(WORDS.length)]);
  return picked.join('-');
}

function generatePasswords() {
  return {
    admin: draw(WORD_COUNTS.admin),
    friend: draw(WORD_COUNTS.friend),
    guest: draw(WORD_COUNTS.guest),
    visitor: draw(WORD_COUNTS.visitor),
  };
}

module.exports = { generatePasswords, WORDS, passwordEntropyBits };
