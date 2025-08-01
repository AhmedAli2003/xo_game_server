// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ========================= In-memory store =========================
// rooms: Map<roomId, {
//   players: [{ id, playerId, nickname, symbol, points }],
//   board: (null|'X'|'O')[],
//   currentTurn: 'X'|'O',
//   round: number,
//   readySet: Set<socketId>,       // players ready for next round
//   cleanupTimer?: NodeJS.Timeout, // optional idle cleanup
// }>
const rooms = new Map();

// ========================= Helpers =========================
function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase(); // 6 chars
}

function checkWinner(board) {
  const wins = [
    [0,1,2], [3,4,5], [6,7,8],
    [0,3,6], [1,4,7], [2,5,8],
    [0,4,8], [2,4,6],
  ];
  for (const [a,b,c] of wins) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a,b,c] }; // 'X' or 'O'
    }
  }
  return { winner: null, line: null };
}

function roomSnapshot(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    roomId,
    round: room.round,
    currentTurn: room.currentTurn,
    board: room.board,
    players: room.players.map(p => ({
      playerId: p.playerId,
      nickname: p.nickname,
      symbol: p.symbol,
      points: p.points,
      socketId: p.id ?? null, // may be null if temporarily disconnected
    })),
  };
}

function activePlayersCount(room) {
  return room.players.filter(p => !!p.id).length;
}

function scheduleRoomCleanup(roomId, ms = 5 * 60 * 1000) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.cleanupTimer) return; // already scheduled

  room.cleanupTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (activePlayersCount(r) === 0) {
      rooms.delete(roomId);
      console.log(`[CLEANUP] Deleted idle room ${roomId}`);
    } else {
      // still someone inside; do not delete
      clearTimeout(r.cleanupTimer);
      r.cleanupTimer = undefined;
    }
  }, ms);
}

// ========================= Socket.IO =========================
io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);

  // Create room
  socket.on('create-room', ({ nickname, playerId }, cb) => {
    if (!nickname || !playerId) {
      return cb?.({ success: false, message: 'nickname and playerId are required' });
    }

    const roomId = generateRoomId();
    rooms.set(roomId, {
      players: [{ id: socket.id, playerId, nickname, symbol: 'X', points: 0 }],
      board: Array(9).fill(null),
      currentTurn: 'X',
      round: 1,
      readySet: new Set(),
    });

    socket.join(roomId);
    console.log(`[CREATE] ${nickname} (${playerId}) created ${roomId}`);

    cb?.({ success: true, roomId });
  });

  // Join room
  socket.on('join-room', ({ nickname, playerId, roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ success: false, message: 'Room not found' });
    if (!nickname || !playerId) return cb?.({ success: false, message: 'nickname and playerId are required' });
    if (room.players.length >= 2) return cb?.({ success: false, message: 'Room is full' });

    room.players.push({ id: socket.id, playerId, nickname, symbol: 'O', points: 0 });
    socket.join(roomId);

    console.log(`[JOIN] ${nickname} (${playerId}) joined ${roomId}`);

    // Start game snapshot to both players
    io.to(roomId).emit('start-game', roomSnapshot(roomId));
    cb?.({ success: true });
  });

  // Rejoin after app/browser close
  socket.on('rejoin-room', ({ roomId, playerId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ success: false, message: 'Room not found' });

    const player = room.players.find(p => p.playerId === playerId);
    if (!player) return cb?.({ success: false, message: 'Seat not found' });

    player.id = socket.id;
    socket.join(roomId);

    // If there was a cleanup timer and someone rejoined, cancel it
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = undefined;
    }

    console.log(`[REJOIN] player ${playerId} -> ${roomId} as ${player.symbol}`);
    cb?.({ success: true, snapshot: roomSnapshot(roomId) });
  });

  // Player makes a move
  socket.on('make-move', ({ roomId, index }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (typeof index !== 'number' || index < 0 || index > 8) return;
    if (room.board[index] !== null) return;
    if (room.currentTurn !== player.symbol) return;

    room.board[index] = player.symbol;
    room.currentTurn = player.symbol === 'X' ? 'O' : 'X';

    // Update board for all (also include lastMoveIndex)
    io.to(roomId).emit('update-board', {
      board: room.board,
      currentTurn: room.currentTurn,
      lastMoveIndex: index,
    });

    // Check round end
    const { winner, line } = checkWinner(room.board);
    const isDraw = !winner && room.board.every(c => c !== null);

    if (winner || isDraw) {
      if (winner) {
        const w = room.players.find(p => p.symbol === winner);
        if (w) w.points += 1; // scoring rule
      }

      io.to(roomId).emit('round-over', {
        winner: winner ?? null,
        winningLine: line,
        round: room.round,
        players: room.players.map(p => ({
          playerId: p.playerId,
          nickname: p.nickname,
          symbol: p.symbol,
          points: p.points,
          socketId: p.id ?? null,
        })),
        board: room.board,
        lastMoveIndex: index,
      });

      // Prepare next round (wait for both players to be ready)
      room.readySet.clear();
    }
  });

  // Player ready for next round
  socket.on('ready-next-round', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.readySet.add(socket.id);

    // Require both seats to be ready (even if one is currently disconnected,
    // you'll only get to next round when both active sockets pressed ready).
    // If you want to allow "auto-ready" for disconnected seat, adjust logic here.
    if (room.readySet.size >= 2) {
      room.round += 1;
      room.board = Array(9).fill(null);
      // Alternate starter each round
      room.currentTurn = room.round % 2 === 1 ? 'X' : 'O';

      io.to(roomId).emit('new-round', {
        round: room.round,
        board: room.board,
        currentTurn: room.currentTurn,
        players: room.players.map(p => ({
          playerId: p.playerId,
          nickname: p.nickname,
          symbol: p.symbol,
          points: p.points,
          socketId: p.id ?? null,
        })),
      });

      room.readySet.clear();
    }
  });

  // Reset scores (optional)
  socket.on('reset-scores', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.forEach(p => (p.points = 0));
    io.to(roomId).emit('score-reset', room.players.map(p => ({
      playerId: p.playerId,
      nickname: p.nickname,
      symbol: p.symbol,
      points: p.points,
      socketId: p.id ?? null,
    })));
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log('Socket disconnected', socket.id);
    for (const [roomId, room] of rooms.entries()) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        // Mark offline (keep seat for rejoin)
        player.id = null;

        // Inform opponent
        io.to(roomId).emit('player-left', {
          playerId: player.playerId,
          nickname: player.nickname,
          symbol: player.symbol,
        });

        // If no active sockets remain, schedule cleanup
        if (activePlayersCount(room) === 0) {
          scheduleRoomCleanup(roomId);
        }
        break;
      }
    }
  });
});

// ========================= HTTP API =========================
app.get('/game-status/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const snap = roomSnapshot(roomId);
  if (!snap) return res.status(404).json({ success: false, message: 'Room not found' });
  res.json({ success: true, ...snap });
});

app.get('/', (_req, res) => res.send('XO Game Server OK'));

// ========================= Start =========================
server.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${port}`);
});
