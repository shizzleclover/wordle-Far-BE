const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Match = require('../models/Match');

const router = express.Router();

// GET /api/health — no auth required
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/stats — current user's stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const { stats } = user;
    const winRate = stats.gamesPlayed > 0
      ? Math.round((stats.wins / stats.gamesPlayed) * 1000) / 10
      : 0;
    const avgGuesses = stats.gamesPlayed > 0
      ? Math.round((stats.totalGuesses / stats.gamesPlayed) * 10) / 10
      : 0;

    res.json({
      username: user.username,
      gamesPlayed: stats.gamesPlayed,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      winRate,
      totalGuesses: stats.totalGuesses,
      avgGuessesPerGame: avgGuesses,
      fastestWin: stats.fastestWin,
      winStreak: stats.winStreak,
      bestStreak: stats.bestStreak
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/stats/vs/:opponent — head-to-head stats
router.get('/stats/vs/:opponent', authMiddleware, async (req, res) => {
  try {
    const { opponent } = req.params;
    const myUsername = req.user.username;

    // Find all matches between these two players
    const matches = await Match.find({
      'players.username': { $all: [myUsername, opponent] },
      'result.endReason': 'solved'
    }).sort({ createdAt: -1 });

    let myWins = 0;
    let theirWins = 0;
    let draws = 0;

    matches.forEach(match => {
      if (match.result.isDraw) {
        draws++;
      } else if (match.result.winner === myUsername) {
        myWins++;
      } else if (match.result.winner === opponent) {
        theirWins++;
      }
    });

    const recentMatches = matches.slice(0, 10).map(m => {
      const myPlayer = m.players.find(p => p.username === myUsername);
      const oppPlayer = m.players.find(p => p.username === opponent);
      return {
        id: m._id,
        date: m.createdAt,
        wordLength: m.wordLength,
        myGuesses: myPlayer?.guessCount || 0,
        opponentGuesses: oppPlayer?.guessCount || 0,
        winner: m.result.winner,
        isDraw: m.result.isDraw,
        duration: m.duration
      };
    });

    res.json({
      you: myUsername,
      opponent,
      yourWins: myWins,
      theirWins,
      draws,
      totalGames: matches.length,
      recentMatches
    });
  } catch (error) {
    console.error('Head-to-head stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/history — current user's match history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const matches = await Match.find({
      'players.userId': req.user.userId
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Match.countDocuments({
      'players.userId': req.user.userId
    });

    const history = matches.map(m => {
      const me = m.players.find(p => p.userId.toString() === req.user.userId);
      const opp = m.players.find(p => p.userId.toString() !== req.user.userId);
      return {
        id: m._id,
        date: m.createdAt,
        wordLength: m.wordLength,
        opponent: opp?.username || 'Unknown',
        myWord: me?.secretWord,
        opponentWord: opp?.secretWord,
        myGuesses: me?.guessCount || 0,
        opponentGuesses: opp?.guessCount || 0,
        winner: m.result.winner,
        isDraw: m.result.isDraw,
        duration: m.duration
      };
    });

    res.json({
      history,
      page,
      totalPages: Math.ceil(total / limit),
      totalGames: total
    });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/leaderboard — all players ranked by wins
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const players = await User.find()
      .select('username stats.gamesPlayed stats.wins stats.losses stats.draws stats.bestStreak')
      .sort({ 'stats.wins': -1 })
      .limit(50)
      .lean();

    const leaderboard = players.map((p, index) => ({
      rank: index + 1,
      username: p.username,
      gamesPlayed: p.stats.gamesPlayed,
      wins: p.stats.wins,
      losses: p.stats.losses,
      draws: p.stats.draws,
      winRate: p.stats.gamesPlayed > 0
        ? Math.round((p.stats.wins / p.stats.gamesPlayed) * 1000) / 10
        : 0,
      bestStreak: p.stats.bestStreak
    }));

    res.json({ leaderboard });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
