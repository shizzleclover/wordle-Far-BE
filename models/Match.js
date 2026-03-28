const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  roomCode: {
    type: String,
    required: true
  },
  wordLength: {
    type: Number,
    required: true
  },
  players: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    username: {
      type: String,
      required: true
    },
    secretWord: String,
    guesses: [{
      word: String,
      feedback: [{ type: String, enum: ['correct', 'present', 'absent'] }]
    }],
    guessCount: {
      type: Number,
      default: 0
    }
  }],
  result: {
    winner: {
      type: String,
      default: null
    },
    winnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    isDraw: {
      type: Boolean,
      default: false
    },
    endReason: {
      type: String,
      enum: ['solved', 'disconnect'],
      default: 'solved'
    }
  },
  duration: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for fast lookups by player
matchSchema.index({ 'players.userId': 1, createdAt: -1 });
matchSchema.index({ 'players.username': 1 });

module.exports = mongoose.model('Match', matchSchema);
