/* Blockade Board server (Socket.io relay + rooms + leaderboard + Dev Panel admin API)
   Run on Render:  Build: npm install   Start: npm start
   Files:  server.js, admin-server.js, hb-server.js, index.html, package.json
   Env:   PORT (set by Render), DATA_DIR (default ./data, fallback only)
          SUPABASE_URL + SUPABASE_ANON_KEY   (verify logged-in users + admins)
          SUPABASE_SERVICE_KEY               (service_role key: stores the leaderboard permanently; NEVER put it in index.html)
          ADMIN_EMAILS                       (optional, comma separated; default = the 3 developer e-mails in admin-server.js) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_ANON_KEY || '';
const SB_SVC = process.env.SUPABASE_SERVICE_KEY || '';
const useDB = !!(SB_URL && SB_SVC);

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy: use the real client IP for rate limiting
app.use(cors());
app.use(express.json({ limit: '10kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});

/* ---------- Mode table (ids shared with the client) ---------- */
const CAP = { classic: 2, race: 2, king: 2, '2v2': 4, '3pt': 4, ffa: 4 };
const clean = (t, n) => String(t == null ? '' : t).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

/* ---------- Rooms ---------- */
const rooms = new Map(); // code -> room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let k = 0; k < 200; k++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const count = r => r.seats.filter(Boolean).length;
const seatInfo = s => (s ? { n: s.n, c: s.c, s: s.s } : null);

function makeRoom(mode, pub, q) {
  const code = newCode();
  if (!code) return null;
  const r = { code, mode, cap: CAP[mode], pub: !!pub, q: !!q, host: -1, seats: Array(CAP[mode]).fill(null), started: false, createdAt: Date.now(), lastMove: Date.now(), bots: [] };
  rooms.set(code, r);
  return r;
}
function sit(r, socket, p, i) {
  r.seats[i] = { id: socket.id, n: clean(p.name, 14) || 'Player', c: clean(p.c, 2).toLowerCase(), s: clean(p.s, 12), uid: socket.data.uid || '', ip: socket.data.ip || '' };
  if (r.host < 0) r.host = i;
  socket.join(r.code);
  socket.data.room = r.code;
  socket.data.seat = i;
}
function broadcastRoom(r) {
  r.seats.forEach((s, i) => {
    if (!s) return;
    io.to(s.id).emit('room', { seats: r.seats.map(seatInfo), cap: r.cap, you: i, host: r.host, mode: r.mode, pub: r.pub, q: r.q, code: r.code });
    if (r.q) io.to(s.id).emit('qstat', { n: count(r), cap: r.cap, mode: r.mode });
  });
}
function startGame(r, fillBots) {
  if (r.started) return;
  const bots = [];
  if (fillBots) r.seats.forEach((s, i) => { if (!s) bots.push(i + 1); });
  else if (count(r) < r.cap) return;
  r.started = true;
  r.bots = bots;
  r.lastMove = Date.now();
  const names = r.seats.map(s => (s ? s.n : 'Bot'));
  const cs = r.seats.map(s => (s ? s.c : ''));
  const ss = r.seats.map(s => (s ? s.s : ''));
  r.seats.forEach((s, i) => {
    if (s) io.to(s.id).emit('start', { mode: r.mode, role: i + 1, pub: r.pub, q: r.q, names, cs, ss, bots });
  });
}
function leave(socket) {
  const code = socket.data.room, i = socket.data.seat;
  socket.data.room = null; socket.data.seat = -1;
  const r = rooms.get(code);
  if (!r) return;
  socket.leave(code);
  if (!r.seats[i] || r.seats[i].id !== socket.id) return;
  if (r.started) admin.noteLeave(r.seats[i]);   /* rage-quit statistics for the Dev Panel AI Guard */
  r.seats[i] = null;
  if (count(r) === 0) { rooms.delete(code); return; }
  if (r.started) {
    io.to(code).emit('peer-left', { role: i + 1 });
    return;
  }
  if (i === r.host) {
    if (r.pub || r.q) r.host = r.seats.findIndex(Boolean);
    else {
      io.to(code).emit('room-closed');
      r.seats.forEach(s => { if (s) { const so = io.sockets.sockets.get(s.id); if (so) { so.leave(code); so.data.room = null; so.data.seat = -1; } } });
      rooms.delete(code);
      return;
    }
  }
  broadcastRoom(r);
}
/* remove empty / stale rooms */
setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) if (count(r) === 0 || now - r.createdAt > 6 * 3600 * 1000) rooms.delete(c);
}, 60000);

/* ---------- Dev Panel admin API (see admin-server.js) ---------- */
const admin = require('./admin-server')({ app, io, express, rooms, leave, count, clean, verifyUser: (u, t) => verifyUser(u, t), SB_URL, SB_KEY });
io.use((socket, next) => admin.gate(socket, next));   /* identifies the player + refuses banned players */
require('./hb-server')({ app });   /* shared human-bot Live Lobby: every device sees the same rooms */

/* ---------- Socket events ---------- */
io.on('connection', socket => {
  socket.data.room = null; socket.data.seat = -1;

  socket.on('quick', p => {
    p = p || {};
    const mode = CAP[p.mode] ? p.mode : 'classic';
    leave(socket);
    let best = null;
    for (const r of rooms.values()) {
      if (r.q && r.mode === mode && !r.started && count(r) < r.cap && (!best || count(r) > count(best))) best = r;
    }
    const r = best || makeRoom(mode, true, true);
    if (!r) return socket.emit('room-closed');
    sit(r, socket, p, r.seats.findIndex(s => !s));
    broadcastRoom(r);
    if (count(r) >= r.cap) startGame(r, false);
  });

  socket.on('create', (p, ack) => {
    p = p || {};
    const mode = CAP[p.mode] ? p.mode : 'classic';
    leave(socket);
    const r = makeRoom(mode, !!p.pub, false);
    if (!r) return typeof ack === 'function' && ack({ ok: false });
    sit(r, socket, p, 0);
    if (typeof ack === 'function') ack({ ok: true, code: r.code });
    broadcastRoom(r);
  });

  socket.on('join', (p, ack) => {
    p = p || {};
    const code = clean(p.code, 4).toUpperCase();
    const r = rooms.get(code);
    const reply = x => typeof ack === 'function' && ack(x);
    if (!r) return reply({ ok: false, error: 'not-found' });
    if (r.started || count(r) >= r.cap) return reply({ ok: false, error: 'full' });
    leave(socket);
    sit(r, socket, p, r.seats.findIndex(s => !s));
    reply({ ok: true, code: r.code });
    broadcastRoom(r);
    if ((r.pub || r.q) && count(r) >= r.cap) startGame(r, false);
  });

  socket.on('seat', p => {
    const r = rooms.get(socket.data.room);
    const to = p && Math.round(+p.to);
    if (!r || r.started || !(to >= 0 && to < r.cap) || r.seats[to]) return;
    const from = socket.data.seat;
    r.seats[to] = r.seats[from]; r.seats[from] = null;
    if (r.host === from) r.host = to;
    socket.data.seat = to;
    broadcastRoom(r);
  });

  socket.on('start', p => {
    const r = rooms.get(socket.data.room);
    if (!r || r.started || r.pub || r.q || socket.data.seat !== r.host) return;
    startGame(r, !!(p && p.bots));
  });

  /* in-game relay: moves, walls, heartbeats, snapshots, rematch, etc. */
  socket.on('m', d => {
    const r = rooms.get(socket.data.room);
    if (r && d && d.k !== 'hb') r.lastMove = Date.now();   /* heartbeats do not count as activity */
    if (socket.data.room) socket.to(socket.data.room).emit('m', d);
  });

  socket.on('chat', d => {
    if (!socket.data.room || !d) return;
    const t = clean(d.t, 120);
    if (!t) return;
    socket.to(socket.data.room).emit('chat', { p: Math.round(+d.p) || 0, n: clean(d.n, 14), t });
  });

  const reports = [];
  socket.on('report', d => {
    if (!d || reports.length > 20) return;
    reports.push(1);
    admin.noteReport(socket.data.room, d.p);
    console.log('[report]', JSON.stringify({ p: d.p, n: clean(d.n, 14), t: clean(d.t, 120), room: clean(d.room, 4), by: clean(d.by, 14) }));
  });

  socket.on('disconnect', () => leave(socket));
});

/* ---------- REST: public room list ---------- */
app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.pub && !r.q) continue;
    if (r.started || count(r) === 0 || count(r) >= r.cap) continue;
    const h = r.seats[r.host];
    list.push({ code: r.code, mode: r.mode, q: r.q, cap: r.cap, age: Math.round((Date.now() - r.createdAt) / 1000), n: count(r), host: h ? h.n : 'Player', hc: h ? h.c : '', seats: r.seats.map(s => (s ? { n: s.n } : null)) });
  }
  res.json({ rooms: list.slice(0, 30) });
});

/* ---------- Leaderboard ----------
   Permanent storage = Supabase table public.leaderboard (see leaderboard.sql), written with the service key.
   Render's free disk is wiped on every restart / redeploy / spin-down, so the JSON file is only a fallback
   (used when SUPABASE_SERVICE_KEY is not set, or Supabase is briefly unreachable). */
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');
let LB = {}; // key -> {n,p,gid,uid,t}   (fallback store)
try { fs.mkdirSync(DATA_DIR, { recursive: true }); LB = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); } catch (e) { LB = {}; }
let saveT = null;
const saveLB = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => fs.writeFile(LB_FILE, JSON.stringify(LB), () => {}), 3000);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = encodeURIComponent;
const svcHeaders = extra => Object.assign({ apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC, 'Content-Type': 'application/json' }, extra || {});
async function sbRest(method, pathq, body, extra) {
  const r = await fetch(SB_URL + '/rest/v1/' + pathq, { method, headers: svcHeaders(extra), body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}

const tokCache = new Map(); // token -> {uid, exp}
async function verifyUser(userId, token) {
  if (!userId || !token || !SB_URL || !SB_KEY) return false;
  const c = tokCache.get(token);
  if (c && c.exp > Date.now()) return c.uid === userId;
  try {
    const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return false;
    const u = await r.json();
    tokCache.set(token, { uid: u.id, exp: Date.now() + 10 * 60 * 1000 });
    return u.id === userId;
  } catch (e) { return false; }
}

const hits = new Map(); // ip -> [count, resetAt]
const limited = ip => {
  const now = Date.now(), h = hits.get(ip);
  if (!h || h[1] < now) { hits.set(ip, [1, now + 60000]); return false; }
  return ++h[0] > 30;
};

app.post('/api/leaderboard', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ ok: false });
  const b = req.body || {};
  const gid = clean(b.id, 24);
  const name = clean(b.name, 14);
  const points = Math.max(0, Math.min(1000000, Math.round(+b.points) || 0));
  if (!gid || !name) return res.status(400).json({ ok: false });
  const userId = clean(b.userId, 64);
  const verified = UUID_RE.test(userId) && await verifyUser(userId, String(b.token || ''));
  const key = verified ? 'u:' + userId : 'g:' + gid;

  /* fallback copy (always kept, cheap) */
  if (verified) delete LB['g:' + gid]; // upgrade a guest entry to the account
  LB[key] = { n: name, p: points, gid, uid: verified ? userId : null, t: Date.now() };
  saveLB();

  if (useDB) {
    try {
      await sbRest('POST', 'leaderboard?on_conflict=key', { key, name, points, gid, uid: verified ? userId : null, updated_at: new Date().toISOString() },
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (verified) {
        await sbRest('DELETE', 'leaderboard?key=eq.' + enc('g:' + gid), null, { Prefer: 'return=minimal' }).catch(() => {});
        /* so the client's acctSync() can restore the points on any device after sign-in */
        await sbRest('PATCH', 'profiles?id=eq.' + userId, { points }, { Prefer: 'return=minimal' }).catch(e => console.warn('[profiles.points]', e.message));
      }
      lbCacheT = 0; // next GET reloads
    } catch (e) { console.warn('[leaderboard save]', e.message); }
  }
  res.json({ ok: true });
});

let lbCache = null, lbCacheT = 0;
async function dbTop() {
  if (lbCache && Date.now() - lbCacheT < 8000) return lbCache;
  const r = await sbRest('GET', 'leaderboard?select=name,points,gid,uid&order=points.desc,updated_at.asc&limit=100');
  lbCache = await r.json(); lbCacheT = Date.now();
  return lbCache;
}
async function dbRank(id, uid) {
  let filter = null;
  if (uid && UUID_RE.test(uid)) filter = 'uid=eq.' + uid; else if (id) filter = 'gid=eq.' + enc(id);
  if (!filter) return null;
  const me = await (await sbRest('GET', 'leaderboard?select=points&' + filter + '&limit=1')).json();
  if (!me.length) return null;
  const r = await sbRest('GET', 'leaderboard?select=key&points=gt.' + me[0].points + '&limit=1', null, { Prefer: 'count=exact' });
  const total = +(String(r.headers.get('content-range') || '').split('/')[1]) || 0;
  return total + 1;
}

app.get('/api/leaderboard', async (req, res) => {
  const id = clean(req.query.id, 24);
  const uid = clean(req.query.userId, 64);
  if (useDB) {
    try {
      const rows = await dbTop();
      const top = rows.map(x => ({ n: x.name, p: x.points, me: (!!id && x.gid === id) || (!!uid && x.uid === uid) }));
      let rank = top.findIndex(x => x.me) + 1;
      if (!rank) rank = (await dbRank(id, uid)) || (await dbCount()) + 1;
      return res.json({ top, rank });
    } catch (e) { console.warn('[leaderboard read]', e.message); /* fall through to the fallback copy */ }
  }
  const all = Object.values(LB).sort((a, b) => b.p - a.p || a.t - b.t);
  const top = all.slice(0, 100).map(x => ({ n: x.n, p: x.p, me: (!!id && x.gid === id) || (!!uid && x.uid === uid) }));
  const idx = all.findIndex(x => (!!id && x.gid === id) || (!!uid && x.uid === uid));
  res.json({ top, rank: idx >= 0 ? idx + 1 : all.length + 1 });
});
async function dbCount() {
  const r = await sbRest('GET', 'leaderboard?select=key&limit=1', null, { Prefer: 'count=exact' });
  return +(String(r.headers.get('content-range') || '').split('/')[1]) || 0;
}

/* ---------- Game page + Health ---------- */
/* The game page itself (only index.html is exposed, never server.js / package.json) */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, lbStore: useDB ? 'supabase' : 'file (temporary)' }));
/* (the richer /api/health used by the Dev Panel is defined in admin-server.js) */

server.listen(PORT, () => console.log('Blockade Board server listening on ' + PORT + ' — leaderboard store: ' + (useDB ? 'supabase' : 'file (temporary)')));
