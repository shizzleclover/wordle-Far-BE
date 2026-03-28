const MIN_WORD_LENGTH = Math.max(2, parseInt(process.env.WORD_LENGTH_MIN, 10) || 3)
const MAX_WORD_LENGTH = Math.min(32, parseInt(process.env.WORD_LENGTH_MAX, 10) || 20)

/**
 * Any letters-only word is allowed (no dictionary check).
 */
function isAllowedWord(word, length) {
  if (!word || typeof word !== 'string' || word.length !== length) return false
  return /^[a-z]+$/.test(word)
}

function isValidRoomWordLength(n) {
  return Number.isInteger(n) && n >= MIN_WORD_LENGTH && n <= MAX_WORD_LENGTH
}

module.exports = {
  isAllowedWord,
  isValidRoomWordLength,
  MIN_WORD_LENGTH,
  MAX_WORD_LENGTH,
}
