const roomManager = require('./RoomManager');
const {
  isAllowedWord,
  isValidRoomWordLength,
  MIN_WORD_LENGTH,
  MAX_WORD_LENGTH,
} = require('./wordValidator')
const User = require('../models/User');
const Match = require('../models/Match');

module.exports = function setupSocketHandler(io) {
  roomManager.setSocketCallbacks({
    onOpponentDisconnected: ({
      remainingSocketId,
      opponentUsername,
      graceMs,
      graceEndsAt
    }) => {
      io.to(remainingSocketId).emit('opponent-disconnected', {
        username: opponentUsername,
        graceMs,
        graceEndsAt
      });
    },

    onPlayingForfeit: async ({ room, winnerSocketId, loserSocketId }) => {
      await persistDisconnectResult(room, winnerSocketId, loserSocketId);

      const winnerP = room.getPlayer(winnerSocketId);
      const loserP = room.getPlayer(loserSocketId);
      const duration = room.startedAt
        ? Math.round((Date.now() - room.startedAt.getTime()) / 1000)
        : 0;

      io.to(winnerSocketId).emit('game-over', {
        result: 'win',
        winner: winnerP.username,
        opponentWord: loserP.secretWord?.toUpperCase(),
        yourWord: winnerP.secretWord?.toUpperCase(),
        yourGuesses: winnerP.guesses.length,
        opponentGuesses: loserP.guesses.length,
        duration,
        endReason: 'disconnect'
      });
    },

    onSetupAbandon: async ({ room, remainingSocketId, abandonedByUsername }) => {
      io.to(remainingSocketId).emit('setup-abandoned', {
        by: abandonedByUsername,
        wordLength: room.wordLength,
        roomCode: room.id
      });
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 ${socket.user.username} connected (${socket.id})`);

    void handleReconnect(socket, io);

    socket.on('request-room-state', () => {
      try {
        const room = roomManager.getRoomBySocketId(socket.id);
        if (!room) {
          return socket.emit('error', { message: 'You are not in a room' });
        }
        const state = buildRoomState(room, socket.id);
        if (state) socket.emit('room-state', state);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // ─── CREATE ROOM ────────────────────────────────────
    socket.on('create-room', ({ wordLength }) => {
      try {
        const wl = parseInt(wordLength, 10) || 5;
        if (!isValidRoomWordLength(wl)) {
          return socket.emit('error', {
            message: `Word length must be ${MIN_WORD_LENGTH}-${MAX_WORD_LENGTH}`,
          });
        }

        const existing = roomManager.getRoomBySocketId(socket.id);
        if (existing) {
          return socket.emit('error', { message: 'You are already in a room. Leave first.' });
        }

        const room = roomManager.createRoom(wl, socket.id, socket.user);
        socket.join(room.id);

        socket.emit('room-created', {
          code: room.id,
          wordLength: room.wordLength
        });
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // ─── JOIN ROOM ──────────────────────────────────────
    socket.on('join-room', ({ code }) => {
      try {
        if (!code || code.length !== 6) {
          return socket.emit('error', { message: 'Invalid room code' });
        }

        const existing = roomManager.getRoomBySocketId(socket.id);
        if (existing) {
          return socket.emit('error', { message: 'You are already in a room. Leave first.' });
        }

        const room = roomManager.joinRoom(code, socket.id, socket.user);
        socket.join(room.id);

        const players = [...room.players.values()].map(p => ({
          username: p.username,
          ready: p.ready,
          disconnected: p.disconnected
        }));

        io.to(room.id).emit('player-joined', {
          players,
          playerCount: room.getPlayerCount(),
          wordLength: room.wordLength,
          phase: room.phase
        });
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // ─── SET WORD ───────────────────────────────────────
    socket.on('set-word', ({ word }) => {
      try {
        const room = roomManager.getRoomBySocketId(socket.id);
        if (!room) {
          return socket.emit('error', { message: 'You are not in a room' });
        }

        if (!word || typeof word !== 'string') {
          return socket.emit('error', { message: 'Invalid word' });
        }

        const cleanWord = word.trim().toLowerCase();

        if (!isAllowedWord(cleanWord, room.wordLength)) {
          return socket.emit('error', {
            message: `Use exactly ${room.wordLength} letters (A-Z only)`,
          });
        }

        const allReady = room.setWord(socket.id, cleanWord);

        socket.emit('word-set', { success: true });

        const opponent = room.getOpponent(socket.id);
        if (opponent && !opponent.disconnected) {
          io.to(opponent.socketId).emit('opponent-ready');
        }

        if (allReady) {
          for (const [socketId, player] of room.players) {
            const isFirstTurn = room.currentTurn === socketId;
            const opp = room.getOpponent(socketId);

            io.to(socketId).emit('game-start', {
              yourTurn: isFirstTurn,
              opponentName: opp.username,
              wordLength: room.wordLength
            });
          }
        }
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // ─── MAKE GUESS ─────────────────────────────────────
    socket.on('make-guess', async ({ word }) => {
      try {
        const room = roomManager.getRoomBySocketId(socket.id);
        if (!room) {
          return socket.emit('error', { message: 'You are not in a room' });
        }

        if (!word || typeof word !== 'string') {
          return socket.emit('error', { message: 'Invalid word' });
        }

        const cleanWord = word.trim().toLowerCase();

        if (!isAllowedWord(cleanWord, room.wordLength)) {
          return socket.emit('error', {
            message: `Guess must be exactly ${room.wordLength} letters (A-Z only)`,
          });
        }

        const result = room.makeGuess(socket.id, cleanWord);

        socket.emit('guess-result', {
          word: cleanWord,
          feedback: result.feedback,
          guessNumber: result.guessNumber
        });

        if (result.gameOver) {
          await persistGameResult(room, result);

          for (const [socketId, player] of room.players) {
            const opp = room.getOpponent(socketId);
            const isWinner = socketId === room.winner;

            const payload = {
              result: isWinner ? 'win' : 'loss',
              winner: result.winner,
              opponentWord: opp?.secretWord?.toUpperCase(),
              yourWord: player.secretWord?.toUpperCase(),
              yourGuesses: player.guesses.length,
              opponentGuesses: opp?.guesses.length || 0,
              duration: result.duration,
              endReason: 'solved'
            };

            if (!player.disconnected) {
              io.to(socketId).emit('game-over', payload);
            }
          }
        } else {
          const opponent = room.getOpponent(socket.id);
          if (opponent && !opponent.disconnected) {
            const player = room.getPlayer(socket.id);
            io.to(opponent.socketId).emit('turn-update', {
              yourTurn: true,
              opponentGuessCount: player.guesses.length
            });
          }

          socket.emit('turn-update', {
            yourTurn: false,
            opponentGuessCount: room.getOpponent(socket.id)?.guesses.length || 0
          });
        }
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // ─── REQUEST REMATCH ────────────────────────────────
    socket.on('request-rematch', () => {
      try {
        const room = roomManager.getRoomBySocketId(socket.id);
        if (!room) {
          return socket.emit('error', { message: 'You are not in a room' });
        }

        const player = room.getPlayer(socket.id);
        const opponent = room.getOpponent(socket.id);

        if (!opponent) {
          return socket.emit('error', { message: 'Opponent has left' });
        }

        player.wantsRematch = true;

        if (opponent.wantsRematch) {
          room.resetForRematch();
          for (const [, p] of room.players) {
            p.wantsRematch = false;
          }

          io.to(room.id).emit('rematch-start', {
            wordLength: room.wordLength,
            phase: 'setup'
          });
        } else if (!opponent.disconnected) {
          io.to(opponent.socketId).emit('rematch-requested', {
            by: player.username
          });
        }
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // ─── LEAVE ROOM ─────────────────────────────────────
    socket.on('leave-room', () => {
      void handleExplicitLeave(socket, io);
    });

    // ─── DISCONNECT ─────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`🔌 ${socket.user.username} disconnected (${socket.id})`);
      void handleSocketDisconnect(socket, io);
    });
  });
};

// ─── HELPERS ──────────────────────────────────────────

function buildRoomState(room, socketId) {
  const player = room.getPlayer(socketId);
  const opponent = room.getOpponent(socketId);
  if (!player) return null;

  const players = [...room.players.values()].map(p => ({
    username: p.username,
    ready: p.ready,
    disconnected: p.disconnected
  }));

  return {
    roomCode: room.id,
    wordLength: room.wordLength,
    phase: room.phase,
    players,
    you: {
      ready: player.ready,
      hasSetWord: Boolean(player.secretWord),
      guesses: player.guesses,
      yourWord:
        room.phase === 'playing' || room.phase === 'finished'
          ? player.secretWord?.toUpperCase() ?? null
          : null
    },
    opponent: opponent
      ? {
          username: opponent.username,
          ready: opponent.ready,
          disconnected: opponent.disconnected,
          guessCount: opponent.guesses.length
        }
      : null,
    yourTurn: room.phase === 'playing' && room.currentTurn === socketId,
    turnNumber: room.turnNumber
  };
}

async function handleReconnect(socket, io) {
  const resumed = roomManager.tryResumeSession(socket.user.userId, socket.id);
  if (!resumed) return;

  const { room, opponentSocketId } = resumed;
  socket.join(room.id);

  const state = buildRoomState(room, socket.id);
  if (state) socket.emit('room-state', state);

  if (opponentSocketId) {
    io.to(opponentSocketId).emit('opponent-reconnected', {
      username: socket.user.username
    });
  }
}

async function handleExplicitLeave(socket, io) {
  const roomBefore = roomManager.getRoomBySocketId(socket.id);
  const phaseBefore = roomBefore?.phase;

  const result = await roomManager.removePlayerImmediately(socket.id, 'leave');
  if (!result?.remainingPlayer || result.remainingPlayer.disconnected) return;

  if (phaseBefore === 'playing' || phaseBefore === 'setup') return;

  io.to(result.remainingPlayer.socketId).emit('player-left', {
    name: result.disconnectedPlayer?.username || 'Opponent'
  });
}

async function handleSocketDisconnect(socket, io) {
  const roomBefore = roomManager.getRoomBySocketId(socket.id);
  const phaseBefore = roomBefore?.phase;

  const outcome = await roomManager.handleTemporaryDisconnect(socket.id);
  if (!outcome || outcome.grace) return;
  if (!outcome.remainingPlayer || outcome.remainingPlayer.disconnected) return;

  if (phaseBefore === 'playing' || phaseBefore === 'setup') return;

  io.to(outcome.remainingPlayer.socketId).emit('player-left', {
    name: outcome.disconnectedPlayer?.username || 'Opponent'
  });
}

async function persistGameResult(room, result) {
  try {
    const matchDoc = room.toMatchDocument();
    await Match.create(matchDoc);

    const winner = await User.findById(result.winnerId);
    if (winner) {
      winner.stats.gamesPlayed++;
      winner.stats.wins++;
      winner.stats.totalGuesses += result.guessNumber;
      winner.stats.winStreak++;
      if (winner.stats.winStreak > winner.stats.bestStreak) {
        winner.stats.bestStreak = winner.stats.winStreak;
      }
      if (!winner.stats.fastestWin || result.guessNumber < winner.stats.fastestWin) {
        winner.stats.fastestWin = result.guessNumber;
      }
      await winner.save();
    }

    const loser = await User.findById(result.loserId);
    if (loser) {
      const loserPlayer = room.getPlayerByUserId(result.loserId);
      loser.stats.gamesPlayed++;
      loser.stats.losses++;
      loser.stats.totalGuesses += loserPlayer ? loserPlayer.guesses.length : 0;
      loser.stats.winStreak = 0;
      await loser.save();
    }

    console.log(`💾 Match saved: ${result.winner} wins in room ${room.id}`);
  } catch (error) {
    console.error('Failed to persist game result:', error);
  }
}

async function persistDisconnectResult(room, winnerSocketId, loserSocketId) {
  try {
    const matchDoc = room.toDisconnectMatchDocument(winnerSocketId, loserSocketId);
    await Match.create(matchDoc);

    const winnerPlayer = room.getPlayer(winnerSocketId);
    const loserPlayer = room.getPlayer(loserSocketId);

    const winner = await User.findById(winnerPlayer.userId);
    if (winner) {
      winner.stats.gamesPlayed++;
      winner.stats.wins++;
      winner.stats.totalGuesses += winnerPlayer.guesses.length;
      winner.stats.winStreak++;
      if (winner.stats.winStreak > winner.stats.bestStreak) {
        winner.stats.bestStreak = winner.stats.winStreak;
      }
      await winner.save();
    }

    const loser = await User.findById(loserPlayer.userId);
    if (loser) {
      loser.stats.gamesPlayed++;
      loser.stats.losses++;
      loser.stats.totalGuesses += loserPlayer.guesses.length;
      loser.stats.winStreak = 0;
      await loser.save();
    }

    console.log(`💾 Match saved (disconnect): ${winnerPlayer.username} wins in room ${room.id}`);
  } catch (error) {
    console.error('Failed to persist disconnect result:', error);
  }
}
