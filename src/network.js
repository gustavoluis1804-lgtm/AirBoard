'use strict';

/**
 * Utilitários de rede — descoberta do IP local e montagem da URL pública.
 */

const os = require('os');

/**
 * Retorna o primeiro IPv4 não-interno encontrado nas interfaces do SO.
 * Aceita tanto `family: "IPv4"` (Node >= 18) quanto `family: 4` (Node antigo).
 * @param {object} [interfaces] opcional, para testes (formato de os.networkInterfaces())
 * @returns {string} endereço IP ou "localhost" como fallback
 */
function getLocalIP(interfaces) {
  const nets = interfaces || os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

/**
 * Host anunciado publicamente (variável de ambiente PUBLIC_HOST tem prioridade).
 */
function getPublicHost() {
  return process.env.PUBLIC_HOST || getLocalIP();
}

/**
 * Monta a URL base do servidor.
 */
function baseUrl(port) {
  return `http://${getPublicHost()}:${port}`;
}

module.exports = { getLocalIP, getPublicHost, baseUrl };
