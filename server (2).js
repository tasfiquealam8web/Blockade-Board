/**
 * Blockade Board server v2  (Node.js 18+)
 *
 * What it does
 *  - Serves index.html (the game) at "/", plus optional ads.txt for ad networks.
 *  - Socket.IO relay for online matches (same event protocol as the game: create / join / quick /
 *    start / seat / m / chat / report -> room / start / qstat / m / chat / peer-left).
 *  - Leaderboard API used by the game:  GET /api/leaderboard?id=...   POST /api/leaderboard
 *  - Google / email login: the game signs in with Supabase (Google OAuth happens in the browser).
 *    The game sends the Supabase access token to this server. If SUPABASE_URL + SUPABASE_ANON_KEY
 *    are set, the token is verified here, so logged-in players are real accounts, one active session
 *    per account, and leaderboard updates from them are trusted more than guests.
 *  - Ads (Adsterra Smartlink) are opened by the browser in a new tab, so the server does not touch
 *    them. Nothing here blocks them. An optional CSP (ENABLE_CSP=1) already allows them.
 *
 * Environment variables (all optional)
 *  PORT                    default 3000
 *  CORS_ORIGIN             comma separated list of allowed game origins, default "*"
 *  SUPABASE_URL            e.g. https://abcd1234.supabase.co
 *  SUPABASE_ANON_KEY       the project's public anon key (same one used in index.html)
 *  DATA_DIR                where leaderboard.json / reports.jsonl are stored (default ./data).
 *                          On Render's free plan the disk is wiped on every deploy, mount a Disk and point this at it.
 *  ENABLE_CSP              set to 1 to send a Content-Security-Policy header
 *  ADS_TXT                 optional path to an ads.txt file (default ./ads.txt)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ config */
const PORT = Number(process.env.PORT || 3000);
const ORIGINS = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
const ANY_ORIGIN = ORIGINS.includes('*');
const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_ANON_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');
const REPORT_FILE = path.join(DATA_DIR, 'reports.jsonl');
const INDEX_FILE = path.join(__dirname, 'index.html');
const ADS_FILE = process.env.ADS_TXT || path.join(__dirname, 'ads.txt');

const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const CHAT_MAX = 120;
const MODES = new Set(['classic', 'race', 'king', '2v2', '3pt', 'ffa']);   /* online modes only. Bot Modes (fog, obstacle, blitz, puzzle) are offline */
const CAPACITY = { classic: 2, race: 2, king: 2, '2v2': 4, '3pt': 4, ffa: 4 };

/* ------------------------------------------------------------------ small helpers */
const BAD = new RegExp([
  'f+u+c+k+', 'sh[i1!]+t', 'b[i1!]tch', 'asshole', 'cunt', 'nigg(?:er|a)', 'fagg?ot', 'whore', 'slut', 'retard',
  'madarchod', 'bh?enchod', 'behenchod', 'bokachoda', 'khanki', 'haramjada', 'gandu',
  'খানকি', 'খানকী', 'মাগি', 'মাগী', 'চুদি', 'বোকাচোদা', 'মাদারচোদ', 'ভোদা', 'হারামজাদা', 'গান্ডু'
].join('|'), 'gi');
const mask = t => String(t).replace(BAD, m => '*'.repeat(m.length));
const strip = v => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanName = v => mask(strip(v) || 'Player').slice(0, 18);
const cleanCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const cleanMode = v => (MODES.has(v) ? v : 'classic');
const cleanTag = v => (/^[a-z0-9_-]{1,24}$/i.test(String(v || '')) ? String(v) : '');
const cleanId = v => (/^[a-z0-9_-]{4,40}$/i.test(String(v || '')) ? String(v) : '');

const hits = new Map();   /* fixed-window rate limiter: key -> {n, t} */
function rate(key, max, windowMs) {
  const now = Date.now(), h = hits.get(key);
  if (!h || now - h.t > windowMs) { hits.set(key, { n: 1, t: now }); return true; }
  return ++h.n <= max;
}
setInterval(() => { const cut = Date.now() - 120000; for (const [k, h] of hits) if (h.t < cut) hits.delete(k); }, 60000).unref();

/* ------------------------------------------------------------------ Supabase token check (Google / email login) */
const tokenCache = new Map();   /* sha1(token) -> {u, exp} */
async function verifyToken(token) {
  if (!SUPA_URL || !SUPA_KEY || typeof token !== 'string') return null;
  if (token.length > 4000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
  const key = crypto.createHash('sha1').update(token).digest('hex'), now = Date.now(), hit = tokenCache.get(key);
  if (hit && hit.exp > now) return hit.u;
  let u = null;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', {
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) { const j = await r.json(); if (j && j.id) u = { id: String(j.id) }; }
  } catch (e) { return null; }   /* Supabase unreachable: treat as guest, do not cache */
  if (tokenCache.size > 2000) tokenCache.clear();
  tokenCache.set(key, { u, exp: now + (u ? 5 * 60000 : 60000) });
  return u;
}

/* ------------------------------------------------------------------ leaderboard store */
const LB = new Map();   /* playerId -> {n: name, p: points, u: supabase user id or '', t: last update} */
let lbDirty = false, lbTimer = null, lbMemo = null;
try {
  const j = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
  for (const [id, v] of Object.entries(j)) if (v && Number.isFinite(v.p)) LB.set(id, v);
  console.log(`[lb] loaded ${LB.size} players`);
} catch (e) { /* first run */ }
function lbSave() {
  if (!lbDirty) return;
  lbDirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = LB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(LB)));
    fs.renameSync(tmp, LB_FILE);
  } catch (e) { lbDirty = true; console.warn('[lb] save failed:', e.message); }
}
function lbTouch() {
  lbDirty = true; lbMemo = null;
  if (!lbTimer) lbTimer = setTimeout(() => { lbTimer = null; lbSave(); }, 5000);
}
function lbBoard() {   /* best entry per account (guests count by their own id), highest first */
  if (lbMemo && Date.now() - lbMemo.t < 5000) return lbMemo.b;
  const best = new Map();
  for (const [id, v] of LB) { const k = v.u || id, b = best.get(k); if (!b || v.p > b.v.p) best.set(k, { id, k, v }); }
  const b = [...best.values()].sort((x, y) => y.v.p - x.v.p || x.v.t - y.v.t);
  lbMemo = { t: Date.now(), b };
  return b;
}
setInterval(() => {   /* drop players untouched for 180 days and keep the file small */
  const cut = Date.now() - 180 * 86400000;
  for (const [id, v] of LB) if (v.t < cut) LB.delete(id);
  if (LB.size > 20000) [...LB.entries()].sort((a, b) => b[1].p - a[1].p).slice(20000).forEach(([id]) => LB.delete(id));
  lbTouch();
}, 6 * 3600 * 1000).unref();

/* ------------------------------------------------------------------ HTTP */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   /* Render / most hosts sit behind a proxy, so req.ip is the real client */

app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.ENABLE_CSP === '1') {
    res.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: wss:",   /* Supabase, this server's websocket */
      "frame-ancestors *"
    ].join('; '));   /* the Adsterra Smartlink opens as a normal new tab, CSP does not restrict that */
  }
  next();
});

app.use('/api', (req, res, next) => {   /* CORS, needed when the game page lives on another domain than this server */
  const o = req.headers.origin;
  if (o && (ANY_ORIGIN || ORIGINS.includes(o))) { res.set('Access-Control-Allow-Origin', ANY_ORIGIN ? '*' : o); res.set('Vary', 'Origin'); }
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const sendIfExists = (file, type) => (_req, res) => {
  if (!fs.existsSync(file)) return res.status(404).type('text/plain').send('Not found');
  if (type) res.type(type);
  res.sendFile(file);
};
app.get(['/', '/index.html'], sendIfExists(INDEX_FILE));   /* ?room=ABCD invite links keep working */
app.get('/ads.txt', sendIfExists(ADS_FILE, 'text/plain'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, rooms: rooms.size, players: LB.size, auth: !!(SUPA_URL && SUPA_KEY) }));

app.get('/api/rooms', (_req, res) => {
  const list = [...rooms.values()]
    .filter(r => r.pub && !r.started && r.seats.some(Boolean) && r.seats.filter(Boolean).length < r.cap)
    .slice(0, 50)
    .map(r => ({
      code: r.code, mode: r.mode, q: r.q, n: r.seats.filter(Boolean).length, cap: r.cap,
      host: (r.seats[r.host] && r.seats[r.host].n) || 'Host', hc: '',
      seats: r.seats.map(s => (s ? { n: s.n } : null))
    }));
  res.status(200).json({ rooms: list });
});

app.get('/api/leaderboard', (req, res) => {
  if (!rate('lbg:' + req.ip, 60, 60000)) return res.status(429).json({ error: 'slow-down' });
  const id = cleanId(req.query.id), board = lbBoard(), mine = id ? LB.get(id) : null, myKey = mine ? (mine.u || id) : '';
  const top = board.slice(0, 100).map(x => ({ n: x.v.n, p: x.v.p, me: !!myKey && x.k === myKey }));
  const idx = myKey ? board.findIndex(x => x.k === myKey) : -1;
  res.status(200).json({ top, rank: idx >= 0 ? idx + 1 : board.length + 1 });
});

app.post('/api/leaderboard', express.json({ limit: '4kb' }), async (req, res) => {
  if (!rate('lbp:' + req.ip, 40, 60000)) return res.status(429).json({ ok: false, error: 'slow-down' });
  const b = req.body || {}, id = cleanId(b.id), pts = Math.trunc(Number(b.points));
  if (!id || !Number.isFinite(pts) || pts < 0 || pts > 1e6) return res.status(400).json({ ok: false, error: 'bad-request' });
  const user = await verifyToken(b.token), now = Date.now(), prev = LB.get(id);
  /* Points come from the browser, so keep them believable: a game is worth at most 80 points, plus a little
     allowance for games played offline. A fully cheat-proof board needs server-side match results. */
  if (prev) {
    const allowed = 150 + Math.min(5000, ((now - prev.t) / 60000) * 3);
    if (pts > prev.p + allowed || pts < prev.p - 100) return res.status(200).json({ ok: false, error: 'rejected' });
  } else if (pts > (user ? 100000 : 2000)) {
    return res.status(200).json({ ok: false, error: 'rejected' });
  }
  LB.set(id, { n: cleanName(b.name), p: pts, u: user ? user.id : (prev && prev.u) || '', t: now });
  lbTouch();
  res.status(200).json({ ok: true, verified: !!user });
});

/* ------------------------------------------------------------------ Socket.IO */
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ANY_ORIGIN ? '*' : ORIGINS, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});

const rooms = new Map();
const socketRoom = new Map();
const uidSocket = new Map();   /* verified account -> its one live socket */

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 100; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to allocate a room code');
}
const getRoomFor = socket => { const c = socketRoom.get(socket.id); return c ? rooms.get(c) : null; };
const seatsOf = room => room.seats.map(s => (s ? { n: s.n, c: s.c, s: s.s, id: s.id } : null));
const roomInfo = (room, socket) => ({
  code: room.code, mode: room.mode, pub: room.pub, q: room.q, cap: room.cap, host: room.host,
  you: room.seats.findIndex(s => s && s.id === socket.id), seats: seatsOf(room)
});
function broadcastRoom(room) {
  for (const seat of room.seats) {
    const s = seat && io.sockets.sockets.get(seat.id);
    if (s) s.emit('room', roomInfo(room, s));
  }
}
function setProfile(socket, d) {
  socket.data.playerName = cleanName(d.name);
  socket.data.colour = cleanTag(d.c);
  socket.data.skin = cleanTag(d.s);
}
function detachSocket(socket, { announce = true } = {}) {
  const code = socketRoom.get(socket.id);
  socketRoom.delete(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const index = room.seats.findIndex(s => s && s.id === socket.id);
  if (index < 0) return;
  const wasStarted = room.started;
  room.seats[index] = null;
  socket.leave(code);
  if (room.host === index) room.host = room.seats.findIndex(Boolean);
  if (announce && wasStarted) for (const seat of room.seats) if (seat) io.to(seat.id).emit('peer-left', { role: index + 1 });
  if (!room.seats.some(Boolean)) rooms.delete(code);
  else broadcastRoom(room);
}
function joinSeat(socket, room, index) {
  if (index < 0 || index >= room.cap || room.seats[index]) return false;
  const old = socketRoom.get(socket.id);
  if (old && old !== room.code) detachSocket(socket, { announce: false });
  room.seats[index] = {
    id: socket.id, uid: socket.data.uid || '',
    n: socket.data.playerName, c: socket.data.colour, s: socket.data.skin, joinedAt: Date.now()
  };
  socketRoom.set(socket.id, room.code);
  socket.join(room.code);
  return true;
}
function createRoom(socket, data, isQuick) {
  const mode = cleanMode(data.mode), cap = CAPACITY[mode], code = roomCode();
  const room = {
    code, mode, cap, pub: !!data.pub, q: !!isQuick, host: 0,
    seats: Array(cap).fill(null), started: false, createdAt: Date.now(), lastActivity: Date.now()
  };
  rooms.set(code, room);
  setProfile(socket, data);
  joinSeat(socket, room, 0);
  return room;
}
function startMatch(room) {
  if (!room || room.started) return false;
  /* Online matches start only when every seat holds a real player. No bot fill. */
  if (room.seats.filter(Boolean).length < room.cap) return false;
  room.started = true;
  room.lastActivity = Date.now();
  const names = room.seats.map(s => (s ? s.n : '')), cs = room.seats.map(s => (s ? s.c : '')), ss = room.seats.map(s => (s ? s.s : ''));
  console.log(`[match] ${room.mode} ${room.code} (${room.q ? 'quick' : room.pub ? 'public' : 'private'})`);
  room.seats.forEach((seat, i) => {
    if (seat) io.to(seat.id).emit('start', { mode: room.mode, pub: room.pub, q: room.q, role: i + 1, bots: [], names, cs, ss });
  });
  broadcastRoom(room);
  return true;
}
function queueQuick(socket, data) {
  const mode = cleanMode(data.mode);
  setProfile(socket, data);
  let room = [...rooms.values()].find(r => r.q && r.mode === mode && !r.started && r.seats.filter(Boolean).length < r.cap);
  if (!room) room = createRoom(socket, data, true);
  else joinSeat(socket, room, room.seats.findIndex(s => !s));
  const n = room.seats.filter(Boolean).length;
  for (const seat of room.seats) if (seat) io.to(seat.id).emit('qstat', { n, cap: room.cap, mode: room.mode });
  broadcastRoom(room);
  if (n >= room.cap) startMatch(room);
}

/* Login: the game sends its Supabase token in the handshake. Valid token = signed-in account, anything else = guest. */
io.use(async (socket, next) => {
  try { const u = await verifyToken((socket.handshake.auth || {}).token); socket.data.uid = u ? u.id : ''; }
  catch (e) { socket.data.uid = ''; }
  next();
});

io.on('connection', socket => {
  const uid = socket.data.uid;
  if (uid) {   /* one live session per account: a new tab / device replaces the old one */
    const old = uidSocket.get(uid), o = old && old !== socket.id && io.sockets.sockets.get(old);
    if (o) { o.emit('server-error', { message: 'You signed in somewhere else.' }); o.disconnect(true); }
    uidSocket.set(uid, socket.id);
  }
  socket.data.bucket = { n: 60, t: Date.now() };
  const allow = () => {   /* token bucket: 60 burst, 25 messages / second */
    const b = socket.data.bucket, now = Date.now();
    b.n = Math.min(60, b.n + ((now - b.t) / 1000) * 25); b.t = now;
    if (b.n < 1) return false;
    b.n -= 1; return true;
  };

  socket.on('create', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    try {
      detachSocket(socket, { announce: false });
      const room = createRoom(socket, data || {}, false);
      ack({ ok: true, code: room.code });
      broadcastRoom(room);
    } catch (e) { ack({ ok: false, error: 'server-error' }); }
  });

  socket.on('join', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    data = data || {};
    const room = rooms.get(cleanCode(data.code));
    if (!room) return ack({ ok: false, error: 'not-found' });
    if (getRoomFor(socket) === room) return ack({ ok: true });
    if (room.started) return ack({ ok: false, error: 'full' });
    const index = room.seats.findIndex(s => !s);
    if (index < 0) return ack({ ok: false, error: 'full' });
    detachSocket(socket, { announce: false });
    setProfile(socket, data);
    if (!joinSeat(socket, room, index)) return ack({ ok: false, error: 'full' });
    room.lastActivity = Date.now();
    ack({ ok: true });
    broadcastRoom(room);
    if (room.pub && room.seats.filter(Boolean).length >= room.cap) startMatch(room);
  });

  socket.on('quick', data => {
    try { detachSocket(socket, { announce: false }); queueQuick(socket, data || {}); }
    catch (e) { socket.emit('server-error', { message: 'Could not join quick match' }); }
  });

  socket.on('start', () => {
    const room = getRoomFor(socket);
    if (!room || room.started || room.pub || room.q) return;   /* public / quick rooms start by themselves when full */
    if (room.seats.findIndex(s => s && s.id === socket.id) !== room.host) return;   /* only the host of a private room */
    startMatch(room);
  });

  socket.on('seat', data => {
    const room = getRoomFor(socket);
    if (!room || room.started) return;
    const from = room.seats.findIndex(s => s && s.id === socket.id), to = Number(data && data.to);
    if (from < 0 || !Number.isInteger(to) || to < 0 || to >= room.cap || room.seats[to]) return;
    room.seats[to] = room.seats[from];
    room.seats[from] = null;
    if (room.host === from) room.host = to;
    broadcastRoom(room);
  });

  socket.on('m', data => {   /* game messages (moves, walls, ready, timeouts, rematch...) are relayed to the other seats */
    if (!allow()) return;
    const room = getRoomFor(socket);
    if (!room || !room.started || !data || typeof data !== 'object' || Array.isArray(data)) return;
    if (typeof data.k !== 'string' || data.k.length > 12) return;
    let size = 0; try { size = JSON.stringify(data).length; } catch (e) { return; }
    if (size > 4000) return;
    const index = room.seats.findIndex(s => s && s.id === socket.id);
    if (index < 0) return;
    const payload = { ...data, p: index + 1 };
    room.lastActivity = Date.now();
    for (const seat of room.seats) if (seat && seat.id !== socket.id) io.to(seat.id).emit('m', payload);
  });

  socket.on('chat', data => {
    if (!allow() || !rate('chat:' + socket.id, 6, 5000)) return;
    const room = getRoomFor(socket);
    if (!room || !data || typeof data !== 'object') return;
    const index = room.seats.findIndex(s => s && s.id === socket.id);
    if (index < 0) return;
    const t = mask(strip(data.t)).slice(0, CHAT_MAX);
    if (!t) return;
    const msg = { p: index + 1, n: room.seats[index].n, t, ts: Date.now() };
    room.lastActivity = Date.now();
    for (const other of room.seats) if (other) io.to(other.id).emit('chat', msg);
  });

  socket.on('report', data => {   /* chat reports are saved to DATA_DIR/reports.jsonl for you to review */
    if (!data || typeof data !== 'object' || !rate('rep:' + socket.id, 3, 60000)) return;
    const room = getRoomFor(socket), index = room ? room.seats.findIndex(s => s && s.id === socket.id) : -1;
    const row = {
      at: new Date().toISOString(), room: cleanCode(data.room), reporter: cleanName(data.by), reporterUid: socket.data.uid || '',
      seat: Number(data.p) || 0, name: cleanName(data.n), text: strip(data.t).slice(0, CHAT_MAX), reporterSeat: index + 1
    };
    console.log('[report]', JSON.stringify(row));
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(REPORT_FILE, JSON.stringify(row) + '\n'); } catch (e) { /* log only */ }
  });

  socket.on('disconnect', () => {
    detachSocket(socket);
    if (uid && uidSocket.get(uid) === socket.id) uidSocket.delete(uid);
  });
});

setInterval(() => {   /* remove abandoned rooms */
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.lastActivity >= cutoff) continue;
    for (const seat of room.seats) if (seat) { socketRoom.delete(seat.id); const s = io.sockets.sockets.get(seat.id); if (s) s.leave(code); }
    rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ start / stop */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Blockade Board server listening on 0.0.0.0:${PORT}`);
  console.log(SUPA_URL && SUPA_KEY ? '[auth] Supabase token check ON' : '[auth] Supabase token check OFF (set SUPABASE_URL + SUPABASE_ANON_KEY to turn it on)');
});
function shutdown() { lbSave(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => console.warn('[unhandledRejection]', e));
