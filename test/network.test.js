'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { getLocalIP } = require('../src/network');

test('getLocalIP retorna IPv4 não-interno', () => {
  const fake = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlan0: [{ address: '192.168.0.55', family: 'IPv4', internal: false }],
  };
  assert.strictEqual(getLocalIP(fake), '192.168.0.55');
});

test('getLocalIP aceita family numérico (Node antigo)', () => {
  const fake = { eth0: [{ address: '10.0.0.9', family: 4, internal: false }] };
  assert.strictEqual(getLocalIP(fake), '10.0.0.9');
});

test('getLocalIP ignora IPv6 e internas', () => {
  const fake = {
    lo: [{ address: '::1', family: 'IPv6', internal: true }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: true }],
  };
  assert.strictEqual(getLocalIP(fake), 'localhost');
});

test('getLocalIP com interfaces vazias faz fallback para localhost', () => {
  assert.strictEqual(getLocalIP({}), 'localhost');
});
