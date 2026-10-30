'use strict';

/**
 * Teste de integração: sobe o servidor real em porta efêmera e valida
 * HTTP (health, QR) e Socket.IO (join, sync, broadcast, undo, clear, validação).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');

let server, baseUrlStr;
const sockets = [];

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(baseUrlStr, { transports: ['polling'], timeout: 5000 });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

before(async () => {
  delete process.env.PUBLIC_HOST;
  const mod = require('../src/server');
  await new Promise((resolve) => mod.server.listen(0, resolve));
  const port = mod.server.address().port;
  baseUrlStr = `http://127.0.0.1:${port}`;
  server = mod.server;
});

after(() => {
  for (const s of sockets) s.close();
  if (server) server.close();
});

test('GET /api/health responde ok', async () => {
  const res = await fetch(`${baseUrlStr}/api/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.ok, true);
});

test('GET /api/room/:room gera QR válido', async () => {
  const res = await fetch(`${baseUrlStr}/api/room/prova`);
  const body = await res.json();
  assert.strictEqual(body.room, 'PROVA');
  assert.ok(body.qr.startsWith('data:image/png;base64,'));
  assert.ok(body.url.includes('join=PROVA'));
});

test('GET /api/room com nome inválido retorna 400', async () => {
  const res = await fetch(`${baseUrlStr}/api/room/%21%21`);
  assert.strictEqual(res.status, 400);
});

test('index.html é servido', async () => {
  const res = await fetch(`${baseUrlStr}/`);
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('AirBoard Pro'));
});

test('fluxo colaborativo: join, element, undo, clear', async () => {
  const a = await connect();
  const b = await connect();

  const joinA = await new Promise((r) => a.emit('join-room', { room: 'sync1', name: 'Ana' }, r));
  assert.strictEqual(joinA.ok, true);
  assert.strictEqual(joinA.room, 'SYNC1');

  const joinB = await new Promise((r) => b.emit('join-room', { room: 'sync1', name: 'Beto' }, r));
  assert.strictEqual(joinB.ok, true);
  assert.deepStrictEqual(joinB.users.sort(), ['Ana', 'Beto']);

  // B recebe elemento de A
  const got = new Promise((r) => b.once('element', r));
  a.emit('stroke', {
    room: 'SYNC1',
    points: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
    color: '#ff0000', size: 3, tool: 'pen',
  });
  const el = await got;
  assert.strictEqual(el.type, 'stroke');
  assert.strictEqual(el.points.length, 2);

  // Undo remove o último para todos
  const removed = new Promise((r) => b.once('remove-last', r));
  const undoRes = await new Promise((r) => a.emit('undo', r));
  assert.strictEqual(undoRes.ok, true);
  await removed;

  // Clear limpa para todos
  const cleared = new Promise((r) => b.once('clear', r));
  a.emit('clear');
  await cleared;
});

test('payloads inválidos são rejeitados', async () => {
  const c = await connect();
  const joinRes = await new Promise((r) => c.emit('join-room', { room: 'val2' }, r));
  assert.strictEqual(joinRes.ok, true);

  const badPoints = await new Promise((r) => c.emit('stroke', {
    room: 'VAL2', points: [{ x: NaN, y: 0 }, { x: 1, y: 1 }], color: '#000000', size: 2, tool: 'pen',
  }, r));
  assert.strictEqual(badPoints.error, 'invalid-payload');

  const badColor = await new Promise((r) => c.emit('stroke', {
    room: 'VAL2', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: 'red', size: 2, tool: 'pen',
  }, r));
  assert.strictEqual(badColor.error, 'invalid-payload');

  const wrongRoom = await new Promise((r) => c.emit('stroke', {
    room: 'OUTRA', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: '#000000', size: 2, tool: 'pen',
  }, r));
  assert.strictEqual(wrongRoom.error, 'not-in-room');

  const notJoined = await new Promise((resolve) => {
    const d = io(baseUrlStr, { transports: ['polling'] });
    sockets.push(d);
    const finish = (v) => { clearTimeout(to); resolve(v); };
    const to = setTimeout(() => finish('timeout'), 5000);
    d.on('connect', () => d.emit('clear', finish));
  });
  assert.ok(notJoined === 'timeout' || !notJoined || notJoined === undefined);
});

test('rate-limit protege o servidor contra flood', async () => {
  const g = await connect();
  const joinRes = await new Promise((r) => g.emit('join-room', { room: 'flood' }, r));
  assert.strictEqual(joinRes.ok, true);
  const results = [];
  for (let i = 0; i < 260; i++) {
    results.push(await new Promise((r) =>
      g.emit('stroke', {
        room: 'FLOOD', points: [{ x: i, y: 0 }, { x: i, y: 1 }],
        color: '#000000', size: 2, tool: 'pen',
      }, r)));
  }
  // A janela de 1s permite ~120 eventos; depois deve bloquear com rate-limited
  assert.ok(results.some((x) => x && x.error === 'rate-limited'), 'esperava rate-limited em algum momento');
  assert.ok(results[0] && results[0].ok, 'primeiros eventos devem passar');
});

test('reconexão recebe snapshot do quadro', async () => {
  const e = await connect();
  await new Promise((r) => e.emit('join-room', { room: 'snap' }, r));
  e.emit('text', { room: 'SNAP', p: { x: 5, y: 5 }, txt: 'olá', color: '#111111', size: 4 });
  await new Promise((r) => setTimeout(r, 100));

  const f = await connect();
  const snap = await new Promise((r) => f.emit('join-room', { room: 'snap' }, r));
  assert.strictEqual(snap.elements.length, 1);
  assert.strictEqual(snap.elements[0].txt, 'olá');
});
