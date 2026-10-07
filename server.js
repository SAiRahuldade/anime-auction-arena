const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

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

function serializeRoom(room, socketId) {
  const players = room.players.map((player, index) => ({
    id: player.socketId,
    slot: index,
    name: player.name,
    budget: player.budget,
    teamCount: player.team.length,
    score: player.score,
    isMe: player.socketId === socketId,
  }));

  return {
    roomCode: room.code,
    players,
    status: room.started ? 'auction' : room.players.length >= 2 ? 'ready' : 'waiting',
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
    const payload = serializeRoom(room, player.socketId);
    io.to(player.socketId).emit('room:state', payload);
  });
}

function resolveAuctionRound(room) {
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
    room.started = false;
    room.auction = null;
    emitRoomState(room);
    return;
  }

  room.auction.currentBid = 0;
  room.auction.currentBidder = null;
  room.auction.playerBids = [0, 0];
  room.auction.passed = [false, false];
  room.auction.timeLeft = room.auction.maxTime;
  emitRoomState(room);
}

function beginAuction(room) {
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

  emitRoomState(room);

  if (room.auction.timer) {
    clearInterval(room.auction.timer);
  }

  room.auction.timer = setInterval(() => {
    if (!room.auction || !room.started) return;
    room.auction.timeLeft -= 1;
    if (room.auction.timeLeft <= 0) {
      resolveAuctionRound(room);
    }
    emitRoomState(room);
  }, 1000);
}

app.use(express.static(path.join(__dirname)));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

io.on('connection', (socket) => {
  socket.on('online:createRoom', ({ name } = {}, acknowledge) => {
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

    socket.join(roomCode);
    room.players.push({
      socketId: socket.id,
      name: (name || 'Player').trim() || 'Player',
      budget: 30,
      team: [],
      score: 0,
    });
    rooms.set(roomCode, room);

    socket.data.roomCode = roomCode;
    socket.data.playerIndex = 0;
    if (typeof acknowledge === 'function') {
      acknowledge({ ok: true, roomCode });
    }
    emitRoomState(room);
  });

  socket.on('online:joinRoom', ({ roomCode, name } = {}, acknowledge) => {
    const reject = (message) => {
      if (typeof acknowledge === 'function') {
        acknowledge({ ok: false, message });
      } else {
        socket.emit('room:error', { message });
      }
    };
    const room = getRoom((roomCode || '').toUpperCase());
    if (!room) {
      reject('Room not found. Check the code and try again.');
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

    socket.join(room.code);
    room.players.push({
      socketId: socket.id,
      name: (name || 'Player 2').trim() || 'Player 2',
      budget: 30,
      team: [],
      score: 0,
    });

    socket.data.roomCode = room.code;
    socket.data.playerIndex = room.players.length - 1;

    if (typeof acknowledge === 'function') {
      acknowledge({ ok: true, roomCode: room.code });
    }
    if (room.players.length === 2) {
      beginAuction(room);
    } else {
      emitRoomState(room);
    }
  });

  socket.on('auction:bid', ({ roomCode, amount, playerIndex }) => {
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
        resolveAuctionRound(room);
      } else if (room.auction.currentBidder !== null && room.auction.currentBidder !== playerIndex) {
        resolveAuctionRound(room);
      }
      emitRoomState(room);
      return;
    }

    const newBid = currentBid + amount;
    if (newBid > targetPlayer.budget) return;

    room.auction.currentBid = newBid;
    room.auction.currentBidder = playerIndex;
    room.auction.playerBids[playerIndex] = newBid;
    room.auction.passed = [false, false];
    room.auction.timeLeft = Math.min(room.auction.timeLeft + 3, room.auction.maxTime);

    emitRoomState(room);
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = getRoom(roomCode);
    if (!room) return;

    room.players = room.players.filter(player => player.socketId !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(roomCode);
      return;
    }

    if (room.started && room.players.length < 2) {
      if (room.auction?.timer) {
        clearInterval(room.auction.timer);
      }
      room.started = false;
      room.auction = null;
    }

    emitRoomState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Anime Auction Arena server running on http://localhost:${PORT}`);
});
