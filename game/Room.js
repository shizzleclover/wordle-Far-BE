class Room {
  constructor(id, wordLength, creatorSocketId, creatorUser) {
    this.id = id;
    this.wordLength = wordLength;
    this.players = new Map();
    this.phase = 'waiting'; // waiting | setup | playing | finished
    this.currentTurn = null;
    this.turnNumber = 0;
    this.winner = null;
    this.startedAt = null;
    this.createdAt = new Date();

    // Add creator as first player
    this.addPlayer(creatorSocketId, creatorUser);
  }

  addPlayer(socketId, user) {
    if (this.players.size >= 2) {
      throw new Error('Room is full');
    }

    if ([...this.players.values()].some(p => p.userId === user.userId)) {
      throw new Error('You are already in this room');
    }

    this.players.set(socketId, {
      socketId,
      userId: user.userId,
      username: user.username,
      secretWord: null,
      guesses: [],
      ready: false,
      disconnected: false
    });

    if (this.players.size === 2) {
      this.phase = 'setup';
    }

    return this.players.get(socketId);
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    return this.players.size;
  }

  getPlayer(socketId) {
    return this.players.get(socketId);
  }

  getOpponent(socketId) {
    for (const [id, player] of this.players) {
      if (id !== socketId) return player;
    }
    return null;
  }

  getPlayerByUserId(userId) {
    for (const [, player] of this.players) {
      if (player.userId === userId) return player;
    }
    return null;
  }

  setWord(socketId, word) {
    if (this.phase !== 'setup') {
      throw new Error('Cannot set word in current phase');
    }

    const player = this.players.get(socketId);
    if (!player) throw new Error('Player not found');

    if (word.length !== this.wordLength) {
      throw new Error(`Word must be ${this.wordLength} letters`);
    }

    player.secretWord = word.toLowerCase();
    player.ready = true;

    // Check if both players are ready
    const allReady = [...this.players.values()].every(p => p.ready);
    if (allReady) {
      this.phase = 'playing';
      this.startedAt = new Date();
      // First player to join goes first
      const playerIds = [...this.players.keys()];
      this.currentTurn = playerIds[0];
      this.turnNumber = 1;
    }

    return allReady;
  }

  makeGuess(socketId, word) {
    if (this.phase !== 'playing') {
      throw new Error('Game is not in playing phase');
    }

    if (this.currentTurn !== socketId) {
      throw new Error('It is not your turn');
    }

    if (word.length !== this.wordLength) {
      throw new Error(`Guess must be ${this.wordLength} letters`);
    }

    const player = this.players.get(socketId);
    const opponent = this.getOpponent(socketId);

    if (!player || !opponent) {
      throw new Error('Player or opponent not found');
    }

    const guess = word.toLowerCase();
    const feedback = this.computeFeedback(guess, opponent.secretWord);

    player.guesses.push({ word: guess, feedback });

    const isCorrect = feedback.every(f => f === 'correct');

    if (isCorrect) {
      return this.handleCorrectGuess(socketId, player, opponent);
    }

    // Switch turns
    this.switchTurn();

    return {
      correct: false,
      feedback,
      guessNumber: player.guesses.length,
      gameOver: false
    };
  }

  handleCorrectGuess(socketId, player, opponent) {
    // Check if opponent also solved in the same number of guesses
    // (draw condition: if opponent guessed correctly with the same count)
    // Since it's turn-based, opponent always has either same or one fewer guess
    // Draw: Player A solves on guess N, Player B already solved on guess N
    // But in our turn-based system, the first correct guess wins immediately
    
    this.phase = 'finished';
    this.winner = socketId;

    const duration = this.startedAt
      ? Math.round((Date.now() - this.startedAt.getTime()) / 1000)
      : 0;

    return {
      correct: true,
      feedback: Array(this.wordLength).fill('correct'),
      guessNumber: player.guesses.length,
      gameOver: true,
      winner: player.username,
      winnerId: player.userId,
      loser: opponent.username,
      loserId: opponent.userId,
      duration
    };
  }

  computeFeedback(guess, secret) {
    const feedback = new Array(guess.length).fill('absent');
    const secretArr = secret.split('');
    const guessArr = guess.split('');
    const secretUsed = new Array(secret.length).fill(false);
    const guessUsed = new Array(guess.length).fill(false);

    // Pass 1: Mark exact matches (correct)
    for (let i = 0; i < guessArr.length; i++) {
      if (guessArr[i] === secretArr[i]) {
        feedback[i] = 'correct';
        secretUsed[i] = true;
        guessUsed[i] = true;
      }
    }

    // Pass 2: Mark present (correct letter, wrong position)
    for (let i = 0; i < guessArr.length; i++) {
      if (guessUsed[i]) continue;

      for (let j = 0; j < secretArr.length; j++) {
        if (secretUsed[j]) continue;

        if (guessArr[i] === secretArr[j]) {
          feedback[i] = 'present';
          secretUsed[j] = true;
          break;
        }
      }
    }

    return feedback;
  }

  switchTurn() {
    const playerIds = [...this.players.keys()];
    const currentIndex = playerIds.indexOf(this.currentTurn);
    this.currentTurn = playerIds[(currentIndex + 1) % 2];

    // Increment turn number when it cycles back to first player
    if (this.currentTurn === playerIds[0]) {
      this.turnNumber++;
    }
  }

  resetForRematch() {
    this.phase = 'setup';
    this.currentTurn = null;
    this.turnNumber = 0;
    this.winner = null;
    this.startedAt = null;

    for (const [, player] of this.players) {
      player.secretWord = null;
      player.guesses = [];
      player.ready = false;
      player.disconnected = false;
    }
  }

  /** After opponent leaves mid-setup or post-forfeit: host waits for a new joiner */
  returnToWaiting(remainingSocketId) {
    this.phase = 'waiting';
    this.currentTurn = null;
    this.turnNumber = 0;
    this.winner = null;
    this.startedAt = null;

    const p = this.players.get(remainingSocketId);
    if (p) {
      p.secretWord = null;
      p.guesses = [];
      p.ready = false;
      p.disconnected = false;
    }
  }

  toDisconnectMatchDocument(winnerSocketId, loserSocketId) {
    const winnerP = this.players.get(winnerSocketId);
    const loserP = this.players.get(loserSocketId);
    if (!winnerP || !loserP) {
      throw new Error('Invalid players for disconnect match document');
    }

    const players = [...this.players.values()].map(p => ({
      userId: p.userId,
      username: p.username,
      secretWord: p.secretWord,
      guesses: p.guesses,
      guessCount: p.guesses.length
    }));

    const duration = this.startedAt
      ? Math.round((Date.now() - this.startedAt.getTime()) / 1000)
      : 0;

    return {
      roomCode: this.id,
      wordLength: this.wordLength,
      players,
      result: {
        winner: winnerP.username,
        winnerId: winnerP.userId,
        isDraw: false,
        endReason: 'disconnect'
      },
      duration
    };
  }

  toMatchDocument() {
    const players = [...this.players.values()].map(p => ({
      userId: p.userId,
      username: p.username,
      secretWord: p.secretWord,
      guesses: p.guesses,
      guessCount: p.guesses.length
    }));

    const winnerPlayer = this.winner ? this.players.get(this.winner) : null;

    const duration = this.startedAt
      ? Math.round((Date.now() - this.startedAt.getTime()) / 1000)
      : 0;

    return {
      roomCode: this.id,
      wordLength: this.wordLength,
      players,
      result: {
        winner: winnerPlayer?.username || null,
        winnerId: winnerPlayer?.userId || null,
        isDraw: false,
        endReason: 'solved'
      },
      duration
    };
  }

  getPlayerCount() {
    return this.players.size;
  }

  isFull() {
    return this.players.size >= 2;
  }
}

module.exports = Room;
