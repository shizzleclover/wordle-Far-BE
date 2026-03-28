const Room = require('./Room');

const DEFAULT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS, 10) || 90_000;

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomCode -> Room
    this.socketToRoom = new Map(); // socketId -> roomCode
    this.forfeitTimers = new Map(); // `${roomCode}:${userId}` -> Timeout
    this.disconnectGraceMs = DEFAULT_GRACE_MS;

    /** @type {{ onPlayingForfeit?: Function, onSetupAbandon?: Function, onOpponentDisconnected?: Function, onOpponentReconnected?: Function } | null} */
    this.socketCallbacks = null;

    this.cleanupInterval = setInterval(() => this.cleanupStaleRooms(), 30 * 60 * 1000);
  }

  setSocketCallbacks(callbacks) {
    this.socketCallbacks = callbacks;
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  /** Find room where this user occupies a seat (connected or in grace disconnect) */
  findSeatForUser(userId) {
    const uid = String(userId);
    for (const room of this.rooms.values()) {
      for (const [socketId, player] of room.players) {
        if (String(player.userId) === uid) {
          return { room, player, socketId };
        }
      }
    }
    return null;
  }

  createRoom(wordLength, socketId, user) {
    const existing = this.findSeatForUser(user.userId);
    if (existing) {
      throw new Error(
        existing.player.disconnected
          ? 'You have a disconnected session; reconnect to resume or wait for it to expire'
          : 'You are already in a room. Leave first.'
      );
    }

    const code = this.generateRoomCode();
    const room = new Room(code, wordLength, socketId, user);
    this.rooms.set(code, room);
    this.socketToRoom.set(socketId, code);
    console.log(`🏠 Room ${code} created by ${user.username} (${wordLength}-letter words)`);
    return room;
  }

  joinRoom(code, socketId, user) {
    const existing = this.findSeatForUser(user.userId);
    if (existing) {
      throw new Error(
        existing.player.disconnected
          ? 'You have a disconnected session; reconnect to resume or wait for it to expire'
          : 'You are already in a room. Leave first.'
      );
    }

    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new Error('Room not found');
    if (room.isFull()) throw new Error('Room is full');
    if (room.phase !== 'waiting') throw new Error('Game already in progress');

    room.addPlayer(socketId, user);
    this.socketToRoom.set(socketId, code.toUpperCase());
    console.log(`👤 ${user.username} joined room ${code}`);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code.toUpperCase());
  }

  getRoomBySocketId(socketId) {
    const code = this.socketToRoom.get(socketId);
    return code ? this.rooms.get(code) : null;
  }

  getRoomCodeBySocketId(socketId) {
    return this.socketToRoom.get(socketId) || null;
  }

  forfeitTimerKey(roomCode, userId) {
    return `${roomCode}:${String(userId)}`;
  }

  clearForfeitTimer(roomCode, userId) {
    const key = this.forfeitTimerKey(roomCode, userId);
    const t = this.forfeitTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.forfeitTimers.delete(key);
    }
  }

  /**
   * Move player to a new socket after reconnect (old socket no longer in socketToRoom).
   */
  migratePlayerSocket(roomCode, oldSocketId, newSocketId) {
    const room = this.rooms.get(roomCode);
    if (!room) return false;

    const player = room.players.get(oldSocketId);
    if (!player) return false;

    room.players.delete(oldSocketId);
    player.socketId = newSocketId;
    player.disconnected = false;
    room.players.set(newSocketId, player);

    if (room.currentTurn === oldSocketId) {
      room.currentTurn = newSocketId;
    }

    this.socketToRoom.set(newSocketId, roomCode);
    return true;
  }

  /**
   * @returns {{ room: Room, oldSocketId: string, opponentSocketId: string | null } | null}
   */
  tryResumeSession(userId, newSocketId) {
    const seat = this.findSeatForUser(userId);
    if (!seat || !seat.player.disconnected) return null;

    const { room, player, socketId: oldSocketId } = seat;
    this.clearForfeitTimer(room.id, player.userId);
    this.migratePlayerSocket(room.id, oldSocketId, newSocketId);

    const opponent = room.getOpponent(newSocketId);
    const opponentSocketId = opponent && !opponent.disconnected ? opponent.socketId : null;

    console.log(`🔁 ${player.username} resumed room ${room.id}`);
    return { room, oldSocketId, opponentSocketId };
  }

  /**
   * Temporary socket loss: keep seat, start forfeit timer; or remove seat.
   * @returns {Promise<
   *   | null
   *   | { grace: true; graceMs: number; graceEndsAt: number }
   *   | { remainingPlayer: object; disconnectedPlayer: object }
   * >}
   */
  async handleTemporaryDisconnect(socketId) {
    const code = this.socketToRoom.get(socketId);
    if (!code) return null;

    const room = this.rooms.get(code);
    if (!room) {
      this.socketToRoom.delete(socketId);
      return null;
    }

    const player = room.getPlayer(socketId);
    const opponent = room.getOpponent(socketId);

    // Solo waiting room — remove and delete
    if (room.getPlayerCount() === 1 && room.phase === 'waiting') {
      room.removePlayer(socketId);
      this.socketToRoom.delete(socketId);
      if (room.getPlayerCount() === 0) {
        this.rooms.delete(code);
        console.log(`🗑️  Room ${code} deleted (empty)`);
      }
      return null;
    }

    // Two-player setup or playing — grace period
    if (
      room.getPlayerCount() === 2 &&
      (room.phase === 'setup' || room.phase === 'playing')
    ) {
      player.disconnected = true;
      this.socketToRoom.delete(socketId);

      const graceEndsAt = Date.now() + this.disconnectGraceMs;
      const timerKey = this.forfeitTimerKey(code, player.userId);

      this.clearForfeitTimer(code, player.userId);
      const timer = setTimeout(() => {
        this.forfeitTimers.delete(timerKey);
        this.finalizeForfeit(code, player.userId);
      }, this.disconnectGraceMs);
      this.forfeitTimers.set(timerKey, timer);

      if (opponent && !opponent.disconnected && this.socketCallbacks?.onOpponentDisconnected) {
        this.socketCallbacks.onOpponentDisconnected({
          room,
          remainingSocketId: opponent.socketId,
          opponentUsername: player.username,
          graceMs: this.disconnectGraceMs,
          graceEndsAt
        });
      }

      return { grace: true, graceMs: this.disconnectGraceMs, graceEndsAt };
    }

    // Post-game: drop the seat without grace
    if (room.phase === 'finished') {
      this.clearForfeitTimer(code, player.userId);
      room.removePlayer(socketId);
      this.socketToRoom.delete(socketId);
      if (room.getPlayerCount() === 0) {
        this.rooms.delete(code);
        console.log(`🗑️  Room ${code} deleted (empty)`);
        return null;
      }
      return {
        remainingPlayer: opponent,
        disconnectedPlayer: player
      };
    }

    return this.removePlayerImmediately(socketId, 'leave');
  }

  finalizeForfeit(roomCode, disconnectedUserId) {
    void this.finalizeForfeitAsync(roomCode, disconnectedUserId);
  }

  async finalizeForfeitAsync(roomCode, disconnectedUserId) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    let disconnectedSocketId = null;
    for (const [sid, p] of room.players) {
      if (String(p.userId) === String(disconnectedUserId) && p.disconnected) {
        disconnectedSocketId = sid;
        break;
      }
    }
    if (!disconnectedSocketId) return;

    const loser = room.getPlayer(disconnectedSocketId);
    const winner = room.getOpponent(disconnectedSocketId);
    if (!loser || !winner) return;

    try {
      if (room.phase === 'playing' && this.socketCallbacks?.onPlayingForfeit) {
        await this.socketCallbacks.onPlayingForfeit({
          room,
          winnerSocketId: winner.socketId,
          loserSocketId: disconnectedSocketId
        });
      } else if (room.phase === 'setup' && this.socketCallbacks?.onSetupAbandon) {
        await this.socketCallbacks.onSetupAbandon({
          room,
          remainingSocketId: winner.socketId,
          abandonedByUsername: loser.username
        });
      }
    } catch (err) {
      console.error('Forfeit callback error:', err);
    }

    room.removePlayer(disconnectedSocketId);
    this.clearForfeitTimer(roomCode, disconnectedUserId);

    if (room.getPlayerCount() === 1) {
      const remaining = [...room.players.keys()][0];
      room.returnToWaiting(remaining);
    }

    if (room.getPlayerCount() === 0) {
      this.rooms.delete(roomCode);
      console.log(`🗑️  Room ${roomCode} deleted (empty after forfeit)`);
    }
  }

  /**
   * Explicit leave or non-grace removal.
   * @returns {object | null} same shape as before for player-left emit
   */
  async removePlayerImmediately(socketId, reason = 'leave') {
    const code = this.socketToRoom.get(socketId);
    if (!code) return null;

    const room = this.rooms.get(code);
    if (!room) {
      this.socketToRoom.delete(socketId);
      return null;
    }

    const player = room.getPlayer(socketId);
    const opponent = room.getOpponent(socketId);

    this.clearForfeitTimer(code, player.userId);
    if (opponent) {
      this.clearForfeitTimer(code, opponent.userId);
    }

    try {
      if (
        reason === 'leave' &&
        room.phase === 'playing' &&
        opponent &&
        this.socketCallbacks?.onPlayingForfeit
      ) {
        await this.socketCallbacks.onPlayingForfeit({
          room,
          winnerSocketId: opponent.socketId,
          loserSocketId: socketId
        });
      } else if (
        reason === 'leave' &&
        room.phase === 'setup' &&
        opponent &&
        this.socketCallbacks?.onSetupAbandon
      ) {
        await this.socketCallbacks.onSetupAbandon({
          room,
          remainingSocketId: opponent.socketId,
          abandonedByUsername: player.username
        });
      }
    } catch (err) {
      console.error('removePlayerImmediately callback error:', err);
    }

    room.removePlayer(socketId);
    this.socketToRoom.delete(socketId);

    if (room.getPlayerCount() === 0) {
      this.rooms.delete(code);
      console.log(`🗑️  Room ${code} deleted (empty)`);
      return null;
    }

    const remaining = [...room.players.keys()][0];
    if (room.phase !== 'finished') {
      room.returnToWaiting(remaining);
    }

    return {
      room,
      disconnectedPlayer: player,
      remainingPlayer: opponent
    };
  }

  updateSocketId(oldSocketId, newSocketId) {
    const code = this.socketToRoom.get(oldSocketId);
    if (!code) return false;
    return this.migratePlayerSocket(code, oldSocketId, newSocketId);
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (room) {
      for (const [, p] of room.players) {
        this.clearForfeitTimer(code, p.userId);
      }
      for (const socketId of room.players.keys()) {
        this.socketToRoom.delete(socketId);
      }
      this.rooms.delete(code);
      console.log(`🗑️  Room ${code} deleted`);
    }
  }

  cleanupStaleRooms() {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    let cleaned = 0;

    for (const [code, room] of this.rooms) {
      if (room.createdAt < twoHoursAgo) {
        this.deleteRoom(code);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} stale rooms`);
    }
  }

  getStats() {
    return {
      totalRooms: this.rooms.size,
      activeConnections: this.socketToRoom.size
    };
  }
}

module.exports = new RoomManager();
