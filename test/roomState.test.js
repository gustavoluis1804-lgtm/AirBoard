'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { RoomState, MAX_ELEMENTS_PER_ROOM } = require('../src/roomState');

test('normalizeRoom sanitiza nomes de sala', () => {
  const r = new RoomState();
  assert.strictEqual(r.normalizeRoom('abc123'), 'ABC123');
  assert.strictEqual(r.normalizeRoom(' a/b!c '), 'ABC');
  assert.strictEqual(r.normalizeRoom('../../etc'), 'ETC');
  assert.strictEqual(r.normalizeRoom(''), null);
  assert.strictEqual(r.normalizeRoom(null), null);
  assert.strictEqual(r.normalizeRoom('A'.repeat(50)), 'A'.repeat(12));
});

test('addElement e snapshot', () => {
  const r = new RoomState();
  r.addElement('sala1', { type: 'text', txt: 'oi' });
  r.addElement('sala1', { type: 'shape' });
  const snap = r.snapshot('SALA1'); // case-insensitive
  assert.strictEqual(snap.elements.length, 2);
});

test('clear esvazia a sala', () => {
  const r = new RoomState();
  r.addElement('x', { a: 1 });
  r.clear('x');
  assert.strictEqual(r.snapshot('x').elements.length, 0);
});

test('limite máximo de elementos é aplicado (FIFO)', () => {
  const r = new RoomState();
  for (let i = 0; i < MAX_ELEMENTS_PER_ROOM + 10; i++) r.addElement('big', { i });
  const els = r.snapshot('big').elements;
  assert.strictEqual(els.length, MAX_ELEMENTS_PER_ROOM);
  assert.strictEqual(els[0].i, 10); // os primeiros foram descartados
});

test('presença: addUser/removeUser', () => {
  const r = new RoomState();
  r.addUser('p', 'sock1', 'Ana');
  const users = r.addUser('p', 'sock2', 'Beto');
  assert.deepStrictEqual(users.slice().sort(), ['Ana', 'Beto']);
  const after = r.removeUser('p', 'sock1');
  assert.deepStrictEqual(after, ['Beto']);
});

test('sala inválida lança erro', () => {
  const r = new RoomState();
  assert.throws(() => r.getOrCreate('!!!'));
});

test('gc remove salas vazias antigas', () => {
  const r = new RoomState();
  r.getOrCreate('old');
  r.rooms.get('OLD').createdAt = Date.now() - 2 * 3600 * 1000;
  r.gc();
  assert.strictEqual(r.rooms.has('OLD'), false);
});
