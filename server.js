require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/db');
const { socketAuthMiddleware } = require('./middleware/auth');
const setupSocketHandler = require('./game/socketHandler');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);

// CORS — comma-separated for multiple fronts (e.g. Vercel prod + preview)
function parseClientOrigins() {
  const raw = process.env.CLIENT_URL || 'http://localhost:5173';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ['http://localhost:5173'];
}

const clientOrigins = parseClientOrigins();
const corsOrigin = clientOrigins.length === 1 ? clientOrigins[0] : clientOrigins;

app.use(cors({
  origin: corsOrigin,
  credentials: true
}));

// Body parsing
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', apiRoutes);

// Socket.IO
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Socket auth middleware
io.use(socketAuthMiddleware);

// Setup socket event handlers
setupSocketHandler(io);

// Start server
const PORT = process.env.PORT || 3001;

async function start() {
  await connectDB();

  server.listen(PORT, () => {
    console.log(`\n🎮 Wordle Duel server running on port ${PORT}`);
    console.log(`🌐 Client URL(s): ${clientOrigins.join(', ')}`);
    console.log(`📡 Socket.IO ready\n`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
