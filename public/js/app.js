/* AirBoard Pro — cliente (V3)
 * Modelo de elementos + renderização incremental, com redraw completo
 * em resize/undo. Colaboração via Socket.IO com estado no servidor.
 */
(() => {
  'use strict';

  // ---------- Setup básico ----------
  const qs = new URLSearchParams(location.search);
  const isMobile = qs.has('join');
  if (isMobile) document.body.classList.add('mobile');

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d', { alpha: false });
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const netDot = $('netDot');
  const usersEl = $('users');

  // Mesma sanitização do servidor (A-Z0-9, máx. 12 chars) — evita divergência de código de sala
  function roomsanitize(r) {
    const clean = String(r || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
    return clean || Math.random().toString(36).slice(2, 8).toUpperCase();
  }
  let room = roomsanitize(qs.get('join') || Math.random().toString(36).slice(2, 8));
  let tool = 'pen';
  let elements = [];          // lista autoritativa local (igual ao servidor)
  let drawing = false;
  let currentStroke = null;   // traço em andamento
  let shapeStart = null;      // início de forma geométrica
  let pendingPreview = null;  // preview de forma arrastada
  let dpr = 1;

  // ---------- Persistência local ----------
  const saved = (() => { try { return JSON.parse(localStorage.getItem('airboard') || '{}'); } catch { return {}; } })();
  const colorInput = $('color');
  const sizeInput = $('size');
  colorInput.value = /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : '#111827';
  sizeInput.value = saved.size || 4;

  function persistPrefs() {
    localStorage.setItem('airboard', JSON.stringify({ color: colorInput.value, size: sizeInput.value }));
  }

  // ---------- Canvas / coordenadas ----------
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    redraw();
  }

  function pt(e) {
    const r = canvas.getBoundingClientRect();
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }

  // ---------- Renderização ----------
  function applyStyle(el) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = el.color;
    ctx.fillStyle = el.color;
    ctx.lineWidth = el.size;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (el.tool === 'highlighter') { ctx.globalAlpha = 0.25; ctx.lineWidth = el.size * 3; }
    if (el.tool === 'eraser') ctx.globalCompositeOperation = 'destination-out';
  }

  function drawElement(el) {
    applyStyle(el);
    if (el.type === 'stroke') {
      ctx.beginPath();
      ctx.moveTo(el.points[0].x, el.points[0].y);
      for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
      ctx.stroke();
    } else if (el.type === 'shape') {
      const { a, b } = el;
      ctx.beginPath();
      if (el.shapeType === 'line') {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      } else if (el.shapeType === 'arrow') {
        drawArrowPath(a, b, el.size);
      } else if (el.shapeType === 'rect') {
        ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else { // circle
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
          Math.max(1, Math.abs(b.x - a.x) / 2), Math.max(1, Math.abs(b.y - a.y) / 2), 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    } else if (el.type === 'text') {
      ctx.font = `${Math.max(18, el.size * 5)}px system-ui, Arial`;
      ctx.fillText(el.txt, el.p.x, el.p.y);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawArrowPath(a, b, size) {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(10, size * 3);
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
  }

  function redraw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const el of elements) drawElement(el);
    if (currentStroke) drawElement(currentStroke);
    if (pendingPreview) drawElement(pendingPreview);
  }

  function appendElement(el) {
    elements.push(el);
    drawElement(el);
  }

  // ---------- Conexão ----------
  const socket = io();
  let joined = false;

  function setStatus(text, online = true) {
    statusEl.textContent = text;
    netDot.classList.toggle('offline', !online);
  }

  function updateUsers(users) {
    usersEl.textContent = users && users.length > 1 ? `👥 ${users.length}` : '';
  }

  socket.on('connect', () => {
    const name = saved.name || (isMobile ? 'Celular' : 'PC');
    socket.emit('join-room', { room, name }, (res) => {
      if (!res || res.error) { setStatus('Erro ao entrar na sala', false); return; }
      joined = true;
      elements = res.elements || [];
      // Se o servidor aceitar um código sanitizado diferente do digitado, adotamos o dele.
      if (res.room && res.room !== room) {
        room = res.room;
        history.replaceState(null, '', `/?join=${encodeURIComponent(room)}`);
      }
      redraw();
      setStatus(isMobile ? `Celular • Sala ${room}` : `Sala ${room}`);
      updateUsers(res.users);
      $('roomPill').textContent = 'Sala ' + room;
      $('roomCode').textContent = room;
    });
  });

  socket.on('disconnect', () => setStatus('Sem conexão…', false));
  socket.on('connect_error', () => setStatus('Servidor indisponível', false));

  socket.on('element', (el) => appendElement(el));
  socket.on('remove-last', () => { elements.pop(); redraw(); });
  socket.on('clear', () => { elements = []; redraw(); toast('Quadro limpo por um participante'); });
  socket.on('presence', ({ users }) => updateUsers(users));

  // Laser/ponteiro remoto (desvanecido)
  const lasers = new Map();
  socket.on('laser', ({ p }) => {
    lasers.set(Date.now() + 900, p);
    scheduleLaserFrame();
  });
  let laserRaf = null;
  function scheduleLaserFrame() {
    if (laserRaf) return;
    laserRaf = requestAnimationFrame(() => {
      laserRaf = null;
      const now = Date.now();
      redraw();
      for (const [exp, p] of lasers) {
        if (now > exp) { lasers.delete(exp); continue; }
        ctx.save();
        ctx.fillStyle = 'rgba(255,40,40,.85)';
        ctx.shadowBlur = 18; ctx.shadowColor = 'red';
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      if (lasers.size) setTimeout(scheduleLaserFrame, 60);
    });
  }

  // Cursor colaborativo remoto
  socket.on('cursor', ({ p }) => {
    redraw();
    ctx.save();
    ctx.fillStyle = 'rgba(109,93,252,.6)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });

  // ---------- Desenho (pointer events unificam mouse/touch/caneta) ----------
  const MAX_POINTS = 512; // mesmo limite do servidor

  function emitStroke(points) {
    const payload = {
      room, points,
      color: colorInput.value,
      size: +sizeInput.value,
      tool,
    };
    socket.emit('stroke', payload, (res) => {
      if (res && res.error) toast('Não foi possível enviar o traço (' + res.error + ')');
    });
  }

  function flushStroke(finished) {
    if (!currentStroke || currentStroke.points.length < 2) {
      if (finished) currentStroke = null;
      return;
    }
    const pts = currentStroke.points.slice(0, MAX_POINTS);
    appendElement({ ...currentStroke, points: pts });
    emitStroke(pts);
    if (finished) {
      currentStroke = null;
    } else {
      // continua desenhando a partir do último ponto enviado
      currentStroke.points = [currentStroke.points[currentStroke.points.length - 1]];
    }
  }

  function onDown(e) {
    if (e.cancelable && e.pointerType === 'touch') e.preventDefault();
    if (!joined) { toast('Aguarde conectar à sala'); return; }
    const p = pt(e);

    if (tool === 'text') {
      const txt = prompt('Digite o texto:');
      if (!txt) return;
      const el = { type: 'text', p, txt: txt.slice(0, 500), color: colorInput.value, size: +sizeInput.value };
      appendElement(el);
      socket.emit('text', { room, ...el });
      return;
    }
    if (tool === 'laser') {
      socket.emit('laser', { room, p });
      drawing = false;
      return;
    }
    drawing = true;
    if (['pen', 'highlighter', 'eraser'].includes(tool)) {
      currentStroke = { type: 'stroke', points: [p], color: colorInput.value, size: +sizeInput.value, tool };
    } else {
      shapeStart = p;
      pendingPreview = { type: 'shape', shapeType: tool, a: p, b: p, color: colorInput.value, size: +sizeInput.value };
    }
  }

  function onMove(e) {
    const p = pt(e);
    if (tool === 'laser' && (e.buttons || e.touches)) { socket.emit('laser', { room, p }); return; }
    if (!drawing) return;
    if (e.cancelable && e.pointerType === 'touch') e.preventDefault();

    if (currentStroke) {
      const lastPt = currentStroke.points[currentStroke.points.length - 1];
      if (Math.hypot(p.x - lastPt.x, p.y - lastPt.y) < 1.2) return; // suaviza jitter
      currentStroke.points.push(p);
      // desenha só o segmento novo (incremental)
      applyStyle(currentStroke);
      ctx.beginPath(); ctx.moveTo(lastPt.x, lastPt.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (currentStroke.points.length >= MAX_POINTS) flushStroke(false); // envia em lotes
    } else if (pendingPreview) {
      pendingPreview.b = p;
      redraw();
    }
  }

  function onUp(e) {
    if (!drawing) return;
    drawing = false;
    const p = pt(e);

    if (currentStroke) {
      flushStroke(true);
    } else if (pendingPreview) {
      pendingPreview.b = p;
      const moved = Math.hypot(p.x - shapeStart.x, p.y - shapeStart.y) > 3;
      const el = { ...pendingPreview };
      pendingPreview = null;
      if (moved) {
        appendElement(el);
        socket.emit('shape', { room, a: el.a, b: el.b, shapeType: el.shapeType, color: el.color, size: el.size });
      } else {
        redraw();
      }
    }
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', () => { drawing = false; currentStroke = null; pendingPreview = null; redraw(); });

  // ---------- UI: ferramentas, cores, tamanho ----------
  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
  });

  function setTool(t) {
    tool = t;
    document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x.dataset.tool === t));
  }

  const SWATCHES = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#9333ea'];
  const swWrap = $('swatches');
  SWATCHES.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.title = c;
    b.onclick = () => { colorInput.value = c; syncSwatches(); persistPrefs(); updateSizeDot(); };
    swWrap.appendChild(b);
  });
  function syncSwatches() {
    swWrap.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.title === colorInput.value));
  }

  const sizeDot = $('sizePreview');
  function updateSizeDot() {
    const s = Math.max(4, Math.min(24, +sizeInput.value));
    sizeDot.style.width = s + 'px';
    sizeDot.style.height = s + 'px';
    sizeDot.style.background = colorInput.value;
  }
  colorInput.oninput = () => { syncSwatches(); persistPrefs(); updateSizeDot(); };
  sizeInput.oninput = () => { persistPrefs(); updateSizeDot(); };
  syncSwatches();
  updateSizeDot();

  // ---------- Ações ----------
  $('undoBtn').onclick = doUndo;
  function doUndo() {
    socket.emit('undo', (res) => {
      if (res && res.ok && !res.removed) toast('Nada para desfazer');
    });
  }

  $('clear').onclick = () => {
    if (!confirm('Limpar todo o quadro para todos os participantes?')) return;
    socket.emit('clear');
  };

  $('save').onclick = () => {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width; tmp.height = canvas.height;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, tmp.width, tmp.height);
    tctx.drawImage(canvas, 0, 0);
    const a = document.createElement('a');
    a.download = `airboard-${room}-${new Date().toISOString().slice(0, 10)}.png`;
    a.href = tmp.toDataURL('image/png');
    a.click();
    toast('Imagem salva ✓');
  };

  $('present').onclick = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  };

  $('connect').onclick = async () => {
    try {
      const d = await fetch('/api/room/' + room).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      $('qr').src = d.qr;
      $('roomCode').textContent = d.room;
      $('network').textContent = d.url;
      $('modal').style.display = 'flex';
    } catch {
      toast('Falha ao gerar QR Code');
    }
  };
  $('close').onclick = () => { $('modal').style.display = 'none'; };
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').style.display = 'none'; });

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2200);
  }

  // ---------- Atalhos de teclado ----------
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea')) return;
    const map = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', c: 'circle', t: 'text', v: 'laser' };
    if (!e.ctrlKey && !e.metaKey && map[e.key.toLowerCase()] && e.key.length === 1) {
      setTool(map[e.key.toLowerCase()]);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('save').click(); }
    else if (e.key === 'f') $('present').click();
    else if (e.key === 'q') $('connect').click();
    else if (e.key === 'Escape') $('modal').style.display = 'none';
  });

  // ---------- Bootstrap ----------
  resize();
  window.addEventListener('resize', resize);
  $('roomPill').textContent = 'Sala ' + room;
  if (isMobile) toast('Conectado à sala ' + room);
})();
