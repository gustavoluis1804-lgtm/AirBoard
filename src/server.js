'use strict';

/**
 * AirBoard Pro — servidor (Express + Socket.IO)
 * V3: estado autoritativo das salas, sincronização de quadro para novos
 * participantes, presença, validação de eventos, rate-limit simples,
 * healthcheck e QR Code por sala.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const { getLocalIP, getPublicHost, baseUrl } = require('./network');
const { RoomState } = require('./roomState');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PAYLOAD_POINTS = 512; // pontos por traço
const RATE_LIMIT = { windowMs: 1000, maxEvents: 120 }; // por socket

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6, // 1 MB por mensagem
  pingTimeout: 20000,
});

const rooms = new RoomState();

// ---------- Helpers de validação ----------
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validPoint(p) {
  return p && isFiniteNumber(p.x) && isFiniteNumber(p.y) && Math.abs(p.x) < 1e5 && Math.abs(p.y) < 1e5;
}

function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}

function validSize(s) {
  return isFiniteNumber(s) && s >= 0.5 && s <= 100;
}

const TOOLS = new Set(['pen', 'highlighter', 'eraser']);
const SHAPES = new Set(['line', 'rect', 'circle', 'arrow']);

// Rate-limit simples por socket (contador deslizante de 1 janela)
function makeLimiter() {
  let count = 0;
  let windowStart = Date.now();
  return function allow() {
    const now = Date.now();
    if (now - windowStart > RATE_LIMIT.windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= RATE_LIMIT.maxEvents;
  };
}

// ---------- Rotas HTTP ----------
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), rooms: rooms.rooms.size });
});

app.get('/api/ip', (_req, res) => {
  res.json({ ip: getLocalIP() });
});

app.get('/api/room/:room', async (req, res) => {
  try {
    const room = rooms.normalizeRoom(req.params.room);
    if (!room) return res.status(400).json({ error: 'Nome de sala inválido' });
    const url = `${baseUrl(PORT)}/?join=${encodeURIComponent(room)}`;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 460 });
    res.json({ room, url, qr });
  } catch (err) {
    console.error('Erro ao gerar QR:', err);
    res.status(500).json({ error: 'Falha ao gerar QR Code' });
  }
});

app.get('/api/new-room', (_req, res) => {
  const room = Math.random().toString(36).slice(2, 8).toUpperCase();
  res.redirect(`/?join=${room}`);
});

// 404 para rotas /api desconhecidas (o resto cai no static)
app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  const limited = makeLimiter();
  let currentRoom = null;

  function guard(data, cb) {
    if (!limited()) {
      if (typeof cb === 'function') cb({ error: 'rate-limited' });
      return false;
    }
    if (!currentRoom || !data || data.room !== currentRoom) {
      if (typeof cb === 'function') cb({ error: 'not-in-room' });
      return false;
    }
    return true;
  }

  socket.on('join-room', (payload, cb) => {
    const raw = typeof payload === 'object' && payload ? payload.room : payload;
    const nameRaw = typeof payload === 'object' && payload ? payload.name : undefined;
    const room = rooms.normalizeRoom(raw);
    if (!room) {
      if (typeof cb === 'function') cb({ error: 'invalid-room' });
      return;
    }
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = room;
    const name = String(nameRaw || 'Anônimo').slice(0, 24);
    socket.join(room);
    const users = rooms.addUser(room, socket.id, name);
    const snap = rooms.snapshot(room);
    socket.to(room).emit('presence', { users, joined: name });
    if (typeof cb === 'function') cb({ ok: true, room, elements: snap.elements, users: snap.users });
  });

  socket.on('rename', (name, cb) => {
    if (!currentRoom) return;
    const clean = String(name || '').slice(0, 24) || 'Anônimo';
    const users = rooms.addUser(currentRoom, socket.id, clean);
    io.to(currentRoom).emit('presence', { users });
    if (typeof cb === 'function') cb({ ok: true });
  });

  // Traço livre: aceita array de pontos (mais eficiente que segment-by-segment)
  socket.on('stroke', (data, cb) => {
    if (!guard(data, cb)) return;
    const { points, color, size, tool } = data;
    if (!Array.isArray(points) || points.length < 2 || points.length > MAX_PAYLOAD_POINTS) {
      if (typeof cb === 'function') cb({ error: 'invalid-points' });
      return;
    }
    if (!points.every(validPoint) || !validColor(color) || !validSize(size) || !TOOLS.has(tool)) {
      if (typeof cb === 'function') cb({ error: 'invalid-payload' });
      return;
    }
    const el = { type: 'stroke', points, color, size, tool, by: socket.id };
    rooms.addElement(currentRoom, el);
    socket.to(currentRoom).emit('element', el);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('shape', (data, cb) => {
    if (!guard(data, cb)) return;
    const { a, b, shapeType, color, size } = data;
    if (!validPoint(a) || !validPoint(b) || !SHAPES.has(shapeType) || !validColor(color) || !validSize(size)) {
      if (typeof cb === 'function') cb({ error: 'invalid-payload' });
      return;
    }
    const el = { type: 'shape', shapeType, a, b, color, size, by: socket.id };
    rooms.addElement(currentRoom, el);
    socket.to(currentRoom).emit('element', el);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('text', (data, cb) => {
    if (!guard(data, cb)) return;
    const { p, txt, color, size } = data;
    if (!validPoint(p) || typeof txt !== 'string' || txt.length === 0 || txt.length > 500 ||
        !validColor(color) || !validSize(size)) {
      if (typeof cb === 'function') cb({ error: 'invalid-payload' });
      return;
    }
    const el = { type: 'text', p, txt, color, size, by: socket.id };
    rooms.addElement(currentRoom, el);
    socket.to(currentRoom).emit('element', el);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('undo', (cb) => {
    if (!currentRoom) return;
    const state = rooms.getOrCreate(currentRoom);
    const removed = state.elements.pop();
    if (removed) {
      io.to(currentRoom).emit('remove-last', { id: state.elements.length });
    }
    if (typeof cb === 'function') cb({ ok: true, removed: !!removed });
  });

  socket.on('clear', (cb) => {
    if (!currentRoom) return;
    rooms.clear(currentRoom);
    io.to(currentRoom).emit('clear');
    if (typeof cb === 'function') cb({ ok: true });
  });

  // Laser/ponteiro: efêmero, sem persistência e sem rate-limit apertado
  socket.on('laser', (data) => {
    if (!currentRoom || !data || !validPoint(data.p)) return;
    socket.to(currentRoom).emit('laser', { p: data.p, by: socket.id });
  });

  socket.on('cursor', (data) => {
    if (!currentRoom || !data || !validPoint(data.p)) return;
    socket.to(currentRoom).emit('cursor', { p: data.p, by: socket.id });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const users = rooms.removeUser(currentRoom, socket.id);
    socket.to(currentRoom).emit('presence', { users });
  });
});

// Coleta de salas inativas a cada 10 min
setInterval(() => rooms.gc(), 10 * 60 * 1000).unref();

// ---------- Bootstrap ----------
function onListen() {
  const shown = baseUrl(PORT).replace(`:${PORT}`, `:${PORT}`);
  console.log('┌──────────────────────────────────────────┐');
  console.log('│  AirBoard Pro 3.0 — Lousa colaborativa   │');
  console.log('└──────────────────────────────────────────┘');
  console.log(`  PC/TV:     ${shown}`);
  console.log(`  Celular:   http://${getLocalIP()}:${PORT}`);
  console.log('  (PC/TV e celular precisam estar no mesmo Wi-Fi)');
}

if (require.main === module) {
  server.listen(PORT, onListen);
}

module.exports = { app, server, io, rooms };
