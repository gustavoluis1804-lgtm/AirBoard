'use strict';

/**
 * Estado autoritativo das salas no servidor.
 *
 * Cada sala guarda:
 *  - elements: lista de elementos desenhados (traços, formas, textos)
 *  - users: mapa socketId -> apelido
 *
 * Isso permite que um participante que entra (ou reconecta) receba o quadro
 * completo ("state sync") sem depender apenas do histórico do Socket.IO.
 */

const MAX_ELEMENTS_PER_ROOM = 5000;

class RoomState {
  constructor() {
    /** @type {Map<string, {elements: Array<object>, users: Map<string,string>, createdAt: number}>} */
    this.rooms = new Map();
  }

  normalizeRoom(room) {
    const r = String(room || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
    return r || null;
  }

  getOrCreate(room) {
    const r = this.normalizeRoom(room);
    if (!r) throw new Error('Nome de sala inválido');
    if (!this.rooms.has(r)) {
      this.rooms.set(r, { elements: [], users: new Map(), createdAt: Date.now() });
    }
    return this.rooms.get(r);
  }

  addElement(room, element) {
    const state = this.getOrCreate(room);
    state.elements.push(element);
    // Evita crescimento infinito de memória em salas muito usadas.
    if (state.elements.length > MAX_ELEMENTS_PER_ROOM) {
      state.elements.splice(0, state.elements.length - MAX_ELEMENTS_PER_ROOM);
    }
    return state.elements.length;
  }

  clear(room) {
    const state = this.getOrCreate(room);
    state.elements = [];
  }

  addUser(room, socketId, name) {
    const state = this.getOrCreate(room);
    state.users.set(socketId, name);
    return Array.from(state.users.values());
  }

  removeUser(room, socketId) {
    const state = this.rooms.get(this.normalizeRoom(room));
    if (!state) return [];
    state.users.delete(socketId);
    return Array.from(state.users.values());
  }

  snapshot(room) {
    const state = this.getOrCreate(room);
    return { elements: state.elements, users: Array.from(state.users.values()) };
  }

  /** Remove salas vazias criadas há mais de `maxAgeMs`. */
  gc(maxAgeMs = 60 * 60 * 1000) {
    const now = Date.now();
    for (const [room, state] of this.rooms) {
      if (state.users.size === 0 && now - state.createdAt > maxAgeMs) {
        this.rooms.delete(room);
      }
    }
  }
}

module.exports = { RoomState, MAX_ELEMENTS_PER_ROOM };
