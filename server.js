const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

require('./characters.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;
const MAX_AUCTION_ROUNDS = 20;
const rooms = new Map();
const roomStore = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  : null;

const tierWeights = { X: 8, SSS: 12, S: 15, A: 18, B: 24, C: 28 };

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createUniquePool() {
  const weightedPool = [];
  CHARACTER_DB.forEach((char) => {
    const weight = tierWeights[char.tier] || 15;
    for (let i = 0; i < weight; i++) {
      weightedPool.push({ ...char });
    }
  });

  const pool = [];
  for (let i = 0; i < MAX_AUCTION_ROUNDS; i++) {
    let selected = null;
    let attempts = 0;
    while (!selected && attempts < 60) {
      attempts += 1;
      const candidate = weightedPool[Math.floor(Math.random() * weightedPool.length)];
      if (!pool.some(item => item.id === candidate.id)) {
        selected = candidate;
      }
    }
    if (!selected) {
      selected = weightedPool[Math.floor(Math.random() * weightedPool.length)];
    }
    pool.push(selected);
  }
  return pool;
}

function getRoom(roomCode) {
  return rooms.get(roomCode);
}

function acknowledge(ack, response) {
  if (typeof ack === 'function') {
    ack(response);
  }
}

function serializeStoredRoom(room) {
  return {
    code: room.code,
    players: room.players.map(({ playerId, name, budget, team, score }) => ({
      playerId,
      name,
      budget,
      team,
      score,
    })),
    started: room.started,
    auction: room.auction ? {
      pool: room.auction.pool,
      currentIndex: room.auction.currentIndex,
      currentBid: room.auction.currentBid,
      currentBidder: room.auction.currentBidder,
      playerBids: room.auction.playerBids,
      timeLeft: room.auction.timeLeft,
      maxTime: room.auction.maxTime,
      passed: room.auction.passed,
    } : null,
  };
}

async function persistRoom(room) {
  if (!roomStore) return;
  await roomStore.query(
    `INSERT INTO game_rooms (code, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (code) DO UPDATE
     SET state = EXCLUDED.state, updated_at = NOW()`,
    [room.code, JSON.stringify(serializeStoredRoom(room))]
  );
}

async function deleteStoredRoom(roomCode) {
  if (!roomStore) return;
  await roomStore.query('DELETE FROM game_rooms WHERE code = $1', [roomCode]);
}

function logRoomStoreError(error) {
  console.error('Room persistence operation failed:', error);
}

async function expireDisconnectedPlayer(room, player) {
  if (player.socketId) return;
  player.reconnectTimer = null;
  room.players = room.players.filter(candidate => candidate !== player);
  if (room.started && room.players.length < 2) {
    if (room.auction?.timer) {
      clearInterval(room.auction.timer);
    }
    room.started = false;
    room.auction = null;
  }
  if (room.players.length === 0) {
    rooms.delete(room.code);
    await deleteStoredRoom(room.code);
  } else {
    await persistRoom(room);
    emitRoomState(room);
  }
}

function schedulePlayerExpiry(room, player) {
  player.reconnectTimer = setTimeout(() => {
    expireDisconnectedPlayer(room, player).catch(logRoomStoreError);
  }, 5 * 60 * 1000);
}

async function reserveDisconnectedPlayer(room, player) {
  player.socketId = null;
  if (room.started && room.auction?.timer) {
    clearInterval(room.auction.timer);
    room.auction.timer = null;
  }
  if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
  schedulePlayerExpiry(room, player);
  await persistRoom(room);
  emitRoomState(room);
}

async function attachPlayer(room, player, socket) {
  const previousRoomCode = socket.data.roomCode;
  if (previousRoomCode && previousRoomCode !== room.code) {
    const previousRoom = getRoom(previousRoomCode);
    const previousPlayer = previousRoom?.players.find(candidate => candidate.socketId === socket.id);
    if (previousRoom && previousPlayer) {
      socket.leave(previousRoom.code);
      await reserveDisconnectedPlayer(previousRoom, previousPlayer);
    }
  }
  if (player.reconnectTimer) {
    clearTimeout(player.reconnectTimer);
    player.reconnectTimer = null;
  }
  player.socketId = socket.id;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerIndex = room.players.indexOf(player);
}

async function initializeRoomStore() {
  if (!roomStore) {
    console.warn('DATABASE_URL is not configured; room data will not survive server restarts.');
    return;
  }

  await roomStore.query(
    `CREATE TABLE IF NOT EXISTS game_rooms (
       code TEXT PRIMARY KEY,
       state JSONB NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  const { rows } = await roomStore.query(
    `SELECT state FROM game_rooms
     WHERE updated_at > NOW() - INTERVAL '24 hours'`
  );

  rows.forEach(({ state }) => {
    const room = {
      ...state,
      players: state.players.map(player => ({
        ...player,
        socketId: null,
        reconnectTimer: null,
      })),
      auction: state.auction ? { ...state.auction, timer: null } : null,
    };
    rooms.set(room.code, room);
    room.players.forEach(player => schedulePlayerExpiry(room, player));
  });
  console.log(`Loaded ${rooms.size} persisted room(s).`);
}

function serializeRoom(room, socketId) {
  const players = room.players.map((player, index) => ({
    id: player.socketId,
    slot: index,
    name: player.name,
    budget: player.budget,
    teamCount: player.team.length,
    score: player.score,
    isMe: player.socketId === socketId,
    isConnected: !!player.socketId,
  }));
  const connectedPlayers = room.players.filter(player => player.socketId).length;

  return {
    roomCode: room.code,
    players,
    status: room.started ? 'auction' : connectedPlayers >= 2 ? 'ready' : 'waiting',
    started: !!room.started,
    myPlayerIndex: room.players.findIndex(player => player.socketId === socketId),
    auction: room.auction ? {
      currentIndex: room.auction.currentIndex,
      currentBid: room.auction.currentBid,
      currentBidder: room.auction.currentBidder,
      playerBids: room.auction.playerBids,
      timeLeft: room.auction.timeLeft,
      maxTime: room.auction.maxTime,
      passed: room.auction.passed,
      currentChar: room.auction.pool[room.auction.currentIndex] || null,
      poolSize: room.auction.pool.length,
    } : null,
  };
}

function emitRoomState(room) {
  room.players.forEach((player) => {
    if (!player.socketId) return;
    const payload = serializeRoom(room, player.socketId);
    io.to(player.socketId).emit('room:state', payload);
  });
}

async function resolveAuctionRound(room) {
  if (!room.auction) return;

  const char = room.auction.pool[room.auction.currentIndex];
  if (room.auction.currentBidder !== null && room.auction.currentBidder >= 0) {
    const winner = room.players[room.auction.currentBidder];
    if (winner && char) {
      winner.budget -= room.auction.currentBid;
      winner.team.push({ ...char });
    }
  }

  room.auction.currentIndex += 1;
  if (room.auction.currentIndex >= room.auction.pool.length) {
    clearInterval(room.auction.timer);
    room.started = false;
    room.auction = null;
    await persistRoom(room);
    emitRoomState(room);
    return;
  }

  room.auction.currentBid = 0;
  room.auction.currentBidder = null;
  room.auction.playerBids = [0, 0];
  room.auction.passed = [false, false];
  room.auction.timeLeft = room.auction.maxTime;
  await persistRoom(room);
  emitRoomState(room);
}

async function beginAuction(room) {
  room.started = true;
  room.auction = {
    pool: createUniquePool(),
    currentIndex: 0,
    currentBid: 0,
    currentBidder: null,
    playerBids: [0, 0],
    timeLeft: 10,
    maxTime: 10,
    passed: [false, false],
    timer: null,
  };

  room.players.forEach((player) => {
    player.budget = 30;
    player.team = [];
    player.score = 0;
  });

  await persistRoom(room);
  emitRoomState(room);

  startAuctionTimer(room);
}

function startAuctionTimer(room) {
  if (!room.auction || room.auction.timer) return;

  room.auction.timer = setInterval(() => {
    if (!room.auction || !room.started) return;
    room.auction.timeLeft -= 1;
    if (room.auction.timeLeft <= 0) {
      resolveAuctionRound(room).catch((error) => {
        logRoomStoreError(error);
        if (room.auction?.timer) {
          clearInterval(room.auction.timer);
          room.auction.timer = null;
        }
      });
      return;
    }
    emitRoomState(room);
  }, 1000);
}

app.use(express.static(path.join(__dirname)));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, storage: roomStore ? 'postgres' : 'memory' });
});

io.on('connection', (socket) => {
  socket.on('online:createRoom', async ({ name, playerId } = {}, ack) => {
    if (!playerId) {
      acknowledge(ack, { ok: false, message: 'Player identity is missing. Refresh and try again.' });
      return;
    }

    let roomCode = randomCode();
    while (rooms.has(roomCode)) {
      roomCode = randomCode();
    }
    const room = {
      code: roomCode,
      players: [],
      started: false,
      auction: null,
    };

    const player = {
      playerId,
      socketId: null,
      name: (name || 'Player').trim() || 'Player',
      budget: 30,
      team: [],
      score: 0,
      reconnectTimer: null,
    };
    room.players.push(player);
    rooms.set(roomCode, room);

    try {
      await persistRoom(room);
      await attachPlayer(room, player, socket);
    } catch (error) {
      rooms.delete(roomCode);
      logRoomStoreError(error);
      acknowledge(ack, { ok: false, message: 'Could not save the room. Please try again.' });
      return;
    }
    acknowledge(ack, { ok: true, roomCode });
    emitRoomState(room);
  });

  socket.on('online:reconnect', async ({ roomCode, playerId } = {}, ack) => {
    const room = getRoom((roomCode || '').toUpperCase());
    const player = room?.players.find(candidate => candidate.playerId === playerId);
    if (!room || !player) {
      acknowledge(ack, { ok: false, message: 'This room is no longer available. Create a new room or ask your friend for a new code.' });
      return;
    }
    if (player.socketId && player.socketId !== socket.id) {
      acknowledge(ack, { ok: false, message: 'This player is already connected to the room.' });
      return;
    }

    try {
      await attachPlayer(room, player, socket);
      await persistRoom(room);
      if (room.started && room.players.every(candidate => candidate.socketId)) {
        startAuctionTimer(room);
      }
    } catch (error) {
      logRoomStoreError(error);
      acknowledge(ack, { ok: false, message: 'Could not restore the room. Please reconnect.' });
      return;
    }
    acknowledge(ack, { ok: true, roomCode: room.code });
    emitRoomState(room);
  });

  socket.on('online:joinRoom', async ({ roomCode, name, playerId } = {}, ack) => {
    const reject = (message) => {
      if (typeof ack === 'function') {
        acknowledge(ack, { ok: false, message });
      } else {
        socket.emit('room:error', { message });
      }
    };
    const room = getRoom((roomCode || '').toUpperCase());
    if (!room) {
      reject('Room not found. Check the code and try again.');
      return;
    }

    const existingPlayer = room.players.find(player => player.playerId === playerId);
    if (existingPlayer) {
      if (existingPlayer.socketId && existingPlayer.socketId !== socket.id) {
        reject('This player is already connected to the room.');
        return;
      }
      try {
        await attachPlayer(room, existingPlayer, socket);
        await persistRoom(room);
      } catch (error) {
        logRoomStoreError(error);
        reject('Could not restore the room. Please reconnect.');
        return;
      }
      acknowledge(ack, { ok: true, roomCode: room.code });
      if (room.started && room.players.every(player => player.socketId)) startAuctionTimer(room);
      emitRoomState(room);
      return;
    }

    if (!playerId) {
      reject('Player identity is missing. Refresh and try again.');
      return;
    }

    if (room.players.length >= 2) {
      reject('This room is already full.');
      return;
    }

    if (room.players.some(player => player.socketId === socket.id)) {
      reject('You are already in this room.');
      return;
    }

    const player = {
      playerId,
      socketId: null,
      name: (name || 'Player 2').trim() || 'Player 2',
      budget: 30,
      team: [],
      score: 0,
      reconnectTimer: null,
    };
    room.players.push(player);
    try {
      await persistRoom(room);
      await attachPlayer(room, player, socket);
      if (room.players.length === 2 && room.players.every(candidate => candidate.socketId)) {
        await beginAuction(room);
      }
    } catch (error) {
      logRoomStoreError(error);
      reject('Could not save the room. Please try again.');
      return;
    }

    acknowledge(ack, { ok: true, roomCode: room.code });
    if (!room.started) {
      emitRoomState(room);
    }
  });

  socket.on('auction:bid', async ({ roomCode, amount, playerIndex }) => {
    try {
      const room = getRoom((roomCode || '').toUpperCase());
      if (!room || !room.auction) return;
      if (!room.players[playerIndex] || room.players[playerIndex].socketId !== socket.id) {
        return;
      }

      const currentBid = room.auction.currentBid || 0;
      const targetPlayer = room.players[playerIndex];

      if (amount === 0) {
        room.auction.passed[playerIndex] = true;
        if (room.auction.passed[0] && room.auction.passed[1]) {
          await resolveAuctionRound(room);
        } else if (room.auction.currentBidder !== null && room.auction.currentBidder !== playerIndex) {
          await resolveAuctionRound(room);
        } else {
          await persistRoom(room);
        }
        if (room.auction) emitRoomState(room);
        return;
      }

      const newBid = currentBid + amount;
      if (newBid > targetPlayer.budget) return;

      room.auction.currentBid = newBid;
      room.auction.currentBidder = playerIndex;
      room.auction.playerBids[playerIndex] = newBid;
      room.auction.passed = [false, false];
      room.auction.timeLeft = Math.min(room.auction.timeLeft + 3, room.auction.maxTime);

      await persistRoom(room);
      emitRoomState(room);
    } catch (error) {
      logRoomStoreError(error);
      socket.emit('room:error', { message: 'Could not save the auction state. Please try again.' });
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = getRoom(roomCode);
    if (!room) return;

    const player = room.players.find(candidate => candidate.socketId === socket.id);
    if (!player) return;
    reserveDisconnectedPlayer(room, player).catch(logRoomStoreError);
  });
});

initializeRoomStore().then(() => {
  server.listen(PORT, () => {
    console.log(`Anime Auction Arena server running on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Could not initialize persistent room storage:', error);
  process.exitCode = 1;
});
