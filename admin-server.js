/* Blockade Board: Dev Panel server side (admin API).
   Loaded by server.js:  const admin = require('./admin-server')({ ... });
   The SERVER is the only place that decides who is an admin. Every /api/admin request carries the
   player's Supabase access token; it is verified against Supabase and the (confirmed) e-mail must be
   in ADMIN_EMAILS.

   Env (Render > Environment):
     SUPABASE_URL, SUPABASE_ANON_KEY    required (same ones server.js already uses)
     ADMIN_EMAILS                       optional, comma separated. Default = the 3 developer e-mails below.
     ADMIN_USER_IDS                     optional, comma separated Supabase user ids (extra admins)
     DATA_DIR                           optional (bans are saved to DATA_DIR/bans.json; Render's free disk is wiped on restart)

   Endpoints
     public : GET  /api/health          GET /api/announcements        POST /api/presence (text/plain JSON)
     admin  : GET  /api/admin/health    /rooms    /bans    /live    /announcements
              POST /api/admin/room/reset  /room/close  /kick  /ban  /unban  /announce  /announce/clear          */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');

const DEFAULT_ADMINS = ['ffmacro79@gmail.com', 'shayon.shayonee16@gmail.com', 'tasfiquealam8@gmail.com'];

module.exports = function initAdmin(ctx) {
  const { app, io, express, rooms, leave, count, clean, verifyUser, SB_URL, SB_KEY } = ctx;
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  const list = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  /* the built-in developer e-mails are ALWAYS admins; ADMIN_EMAILS on Render only ADDS more (so a stale env value can no longer lock the developers out) */
  const ADMIN_EMAILS = new Set(DEFAULT_ADMINS.concat(list(process.env.ADMIN_EMAILS)));
  const ADMIN_IDS = new Set(list(process.env.ADMIN_USER_IDS));
  const SALT = process.env.IP_SALT || 'bb-salt-v1';
  const now = () => Date.now();
  const median = a => { a = a.filter(x => x > 0).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : 0; };

  /* ---------- request counters (for Server Health) ---------- */
  const B = Array.from({ length: 60 }, () => ({ s: 0, req: 0, err: 0 }));
  function bump(err) {
    const s = Math.floor(now() / 1000), b = B[s % 60];
    if (b.s !== s) { b.s = s; b.req = 0; b.err = 0; }
    b.req++; if (err) b.err++;
  }
  const sumB = () => { const s = Math.floor(now() / 1000); let req = 0, err = 0; B.forEach(b => { if (s - b.s < 60) { req += b.req; err += b.err; } }); return { req, err }; };
  app.use((req, res, next) => { res.on('finish', () => bump(res.statusCode >= 500)); next(); });
  app.use(express.text({ type: 'text/plain', limit: '4kb' }));

  /* ---------- helpers ---------- */
  const ipOf = req => String(req.ip || req.socket.remoteAddress || '');
  const ipHash = ip => crypto.createHash('sha1').update(SALT + ip).digest('hex').slice(0, 10);
  const socketIp = s => {
    const h = s.handshake.headers['x-forwarded-for'];
    return String((h ? String(h).split(',')[0] : s.handshake.address) || '').trim();
  };
  const rateMap = new Map();
  const rate = (key, max) => {
    const t = now(), h = rateMap.get(key);
    if (!h || h[1] < t) { rateMap.set(key, [1, t + 60000]); return false; }
    return ++h[0] > max;
  };
  setInterval(() => { const t = now(); for (const [k, v] of rateMap) if (v[1] < t) rateMap.delete(k); }, 60000).unref();

  /* ---------- admin check (server decides) ---------- */
  const adminCache = new Map(); // token -> {ok, email, exp}
  async function adminOf(req) {
    const h = String(req.headers.authorization || '');
    const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!tok) { req.adminWhy = 'request had no login token (sign in again)'; console.warn('[admin] 403: request had no Bearer token'); return null; }
    if (!SB_URL || !SB_KEY) { req.adminWhy = 'server has no SUPABASE_URL / SUPABASE_ANON_KEY (SB_URL=' + (SB_URL ? 'set' : 'EMPTY') + ', SB_KEY=' + (SB_KEY ? 'set' : 'EMPTY') + ')'; console.warn('[admin] 403: SB_URL / SB_KEY are empty (set SUPABASE_URL and SUPABASE_ANON_KEY on Render)'); return null; }
    if (typeof fetch !== 'function') { req.adminWhy = 'server Node version too old (no fetch)'; console.warn('[admin] 403: global fetch missing - Node 18+ is required (set NODE_VERSION=20 on Render)'); return null; }
    const c = adminCache.get(tok);
    if (c && c.exp > now()) { if (!c.ok) req.adminWhy = c.why || 'not an admin'; return c.ok ? c : null; }
    let rec = { ok: false, email: '', uid: '', exp: now() + 5 * 60 * 1000 };
    try {
      const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + tok } });
      if (r.ok) {
        const u = await r.json();
        const email = String(u.email || '').toLowerCase();
        const confirmed = !!(u.email_confirmed_at || u.confirmed_at);
        rec = { ok: confirmed && (ADMIN_EMAILS.has(email) || ADMIN_IDS.has(String(u.id).toLowerCase())), email, uid: u.id, exp: now() + 5 * 60 * 1000 };
        if (!rec.ok) { rec.why = (email || '(no email)') + (confirmed ? ' is signed in but is NOT in the server admin list' : ' has NOT confirmed its e-mail in Supabase'); console.warn('[admin] 403: ' + rec.why); }
      } else { rec.exp = now() + 15 * 1000; rec.why = 'Supabase rejected the login token (HTTP ' + r.status + ') - the server SUPABASE_URL / SUPABASE_ANON_KEY are not from the same project as the game'; console.warn('[admin] 403: Supabase rejected the token (HTTP ' + r.status + ') - check SUPABASE_URL / SUPABASE_ANON_KEY belong to the same project as the game'); }
    } catch (e) { rec.exp = now() + 5 * 1000; rec.why = 'server could not reach Supabase: ' + (e && e.message); console.warn('[admin] 403: could not reach Supabase: ' + (e && e.message)); }
    adminCache.set(tok, rec);
    if (!rec.ok) req.adminWhy = rec.why || 'not an admin';
    if (adminCache.size > 500) adminCache.clear();
    return rec.ok ? rec : null;
  }
  const guard = handler => async (req, res) => {
    if (rate('adm:' + ipOf(req), 600)) return res.status(429).json({ ok: false, error: 'Too many requests' });
    const a = await adminOf(req);
    if (!a) return res.status(403).json({ ok: false, error: 'Not an admin: ' + (req.adminWhy || 'unknown reason') });
    try { await handler(req, res, a); }
    catch (e) { console.warn('[admin]', req.path, e && e.message); res.status(500).json({ ok: false, error: 'Server error' }); }
  };
  const A = (method, p, h) => app[method]('/api/admin' + p, guard(h));
  const log = (a, what) => console.log('[admin]', a.email, what);

  /* ---------- bans ---------- */
  const BAN_FILE = path.join(DATA_DIR, 'bans.json');
  let bans = {};      // key -> {name, reason, until, by, at}
  let banCount = {};  // key -> how many times banned (kept)
  try { const j = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8')); bans = j.bans || {}; banCount = j.count || {}; } catch (e) {}
  const saveBans = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFile(BAN_FILE, JSON.stringify({ bans, count: banCount }), () => {}); } catch (e) {} };
  const activeBan = key => {
    const b = key && bans[key];
    if (!b) return null;
    if (b.until && b.until <= now()) { delete bans[key]; saveBans(); return null; }
    return b;
  };

  /* ---------- per-player stats (rage quits, reports) ---------- */
  const stats = new Map(); // key -> {leaves:[t], reports, chat}
  const statOf = k => { let s = stats.get(k); if (!s) { s = { leaves: [], reports: 0, chat: 0 }; stats.set(k, s); } return s; };
  const keyOfSeat = s => (s && (s.uid || (s.ip ? 'ip:' + s.ip : ''))) || '';
  setInterval(() => { const cut = now() - 864e5; for (const [k, s] of stats) { s.leaves = s.leaves.filter(t => t > cut); if (!s.leaves.length && !s.reports && !s.chat) stats.delete(k); } }, 600000).unref();

  /* ---------- hooks used by server.js ---------- */
  const hooks = {
    /* io.use(...): identify the player, refuse banned ones */
    async gate(socket, next) {
      const a = socket.handshake.auth || {};
      let uid = '';
      try { if (a.userId && a.token && await verifyUser(String(a.userId), String(a.token))) uid = String(a.userId); } catch (e) {}
      socket.data.uid = uid;
      socket.data.ip = ipHash(socketIp(socket));
      const b = activeBan(uid) || (!uid && activeBan('ip:' + socket.data.ip));
      if (b) { const err = new Error('banned'); err.data = { reason: b.reason || '', until: b.until || 0 }; return next(err); }
      next();
    },
    noteLeave(seat) { const k = keyOfSeat(seat); if (k) statOf(k).leaves.push(now()); },
    noteReport(room, role) {
      const r = rooms.get(room), s = r && r.seats[(+role || 0) - 1], k = keyOfSeat(s);
      if (k) statOf(k).reports++;
    },
    noteChatFlag(seat) { const k = keyOfSeat(seat); if (k) statOf(k).chat++; }
  };

  /* ---------- public: health, announcements, presence ---------- */
  app.get('/api/health', (req, res) => res.json({ ok: true, up: Math.round(process.uptime()), rooms: rooms.size }));

  const ann = []; // newest first
  const annActive = () => ann.filter(a => !a.cleared && (!a.exp || a.exp > now()));
  app.get('/api/announcements', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ now: now(), list: annActive().map(a => ({ id: a.id, level: a.level, text: a.text, at: a.at || 0, exp: a.exp || 0 })) });
  });

  const live = new Map(); // key -> player entry
  app.post('/api/presence', (req, res) => {
    if (rate('prs:' + ipOf(req), 240)) return res.status(429).end();
    let d = req.body;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    if (!d || typeof d !== 'object') return res.status(400).end();
    const key = clean(d.k || d.sid || d.uid, 40);
    if (!key) return res.status(400).end();
    if (d.x) { live.delete(key); return res.status(204).end(); }
    const g = Math.max(0, Math.min(1e9, Math.round(+d.g) || 0));
    const old = live.get(key);
    const jump = old && g > old.g ? g - old.g : 0;
    live.set(key, {
      id: key, uid: /^[0-9a-f-]{36}$/i.test(String(d.uid || '')) ? String(d.uid) : '', sid: clean(d.sid, 40),
      n: clean(d.n, 24), c: clean(d.c, 2).toLowerCase(), s: clean(d.s, 8), gm: clean(d.gm, 10),
      rtt: Math.max(0, Math.min(60000, Math.round(+d.rtt) || 0)), g, e: Math.max(0, Math.round(+d.e) || 0),
      up: Math.max(0, Math.round(+d.up) || 0), pt: Math.max(0, Math.round(+d.pt) || 0), pl: d.pl === 'm' ? 'm' : 'd',
      ip: ipHash(ipOf(req)), mj: jump, mjT: jump ? now() : (old ? old.mjT : 0), t: now()
    });
    if (live.size > 5000) for (const [k, v] of live) if (v.t < now() - 60000) live.delete(k);
    res.status(204).end();
  });
  const livePlayers = () => {
    const cut = now() - 45000, out = [];
    for (const [k, p] of live) {
      if (p.t < cut) { if (p.t < now() - 300000) live.delete(k); continue; }
      const so = p.sid && io.sockets.sockets.get(p.sid), code = so && so.data.room, r = code && rooms.get(code);
      out.push({ id: p.id, uid: p.uid, n: p.n, c: p.c, s: p.s, gm: p.gm, rtt: p.rtt, g: p.g, e: p.e, up: p.up, pt: p.pt, pl: p.pl, ip: p.ip,
        mj: p.mjT > now() - 60000 ? p.mj : 0, room: r ? r.code : '', rm: r ? r.mode : '' });
    }
    return out;
  };

  /* ---------- samplers: server health + players online history ---------- */
  const cores = (() => {
    try { const [q, p] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/); if (q !== 'max' && +q > 0 && +p > 0) return Math.max(0.1, +q / +p); } catch (e) {}
    return os.cpus().length || 1;
  })();
  const memLimitMB = (() => {
    const tryRead = f => { try { const v = fs.readFileSync(f, 'utf8').trim(); return v === 'max' ? 0 : +v; } catch (e) { return 0; } };
    const v = tryRead('/sys/fs/cgroup/memory.max') || tryRead('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    return v && v < os.totalmem() * 2 ? v / 1048576 : os.totalmem() / 1048576;
  })();
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  let hist = [], lastCpu = process.cpuUsage(), lastT = process.hrtime.bigint(), cur = null;
  setInterval(() => {
    const t = process.hrtime.bigint(), cpu = process.cpuUsage();
    const used = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system), wall = Number(t - lastT) / 1000;
    lastCpu = cpu; lastT = t;
    const rss = process.memoryUsage().rss / 1048576, sb = sumB();
    let players = 0; rooms.forEach(r => { players += count(r); });
    cur = {
      t: now(), cpu: Math.max(0, Math.min(100, used / wall / cores * 100)), cores: Math.round(cores * 100) / 100, load: os.loadavg()[0],
      memMB: rss, memLimit: memLimitMB, memPct: Math.min(100, rss / memLimitMB * 100),
      lag: loop.percentile(95) / 1e6, sockets: io.engine ? io.engine.clientsCount : 0, rooms: rooms.size, players,
      reqMin: sb.req, err5: sb.err, up: Math.round(process.uptime())
    };
    loop.reset();
    hist.push(cur); if (hist.length > 360) hist.shift();
  }, 10000).unref();
  const pop = []; // players online history, every 30 s
  setInterval(() => {
    const P = livePlayers();
    pop.push({ t: now(), n: P.length, m: P.filter(p => p.s === 'match').length, p: median(P.map(p => p.rtt)) });
    if (pop.length > 120) pop.shift();
  }, 30000).unref();

  /* ---------- admin: health / live ---------- */
  A('get', '/health', (req, res) => res.json({ ok: true, cur, hist, meta: { host: os.hostname(), node: process.version } }));
  A('get', '/live', (req, res) => res.json({ ok: true, players: livePlayers(), rooms: roomList(), hist: pop }));

  /* ---------- admin: rooms ---------- */
  function roomList() {
    const t = now(), out = [];
    for (const r of rooms.values()) {
      const h = r.seats[r.host], bots = r.bots || [];
      out.push({
        code: r.code, mode: r.mode, pub: !!(r.pub || r.q), q: !!r.q, started: !!r.started,
        host: h ? h.n : '', n: count(r), cap: r.cap, ageSec: Math.round((t - r.createdAt) / 1000), idleSec: Math.round((t - (r.lastMove || r.createdAt)) / 1000),
        seats: r.seats.map((s, i) => {
          if (!s) return bots.includes(i + 1) ? { role: i + 1, bot: true, name: 'Bot ' + (i + 1) } : { role: i + 1 };
          const k = keyOfSeat(s), st = k ? statOf(k) : null;
          const cut = t - 864e5;
          return { role: i + 1, name: s.n, uid: s.uid || '', ipHash: s.ip || '', leaves24h: st ? st.leaves.filter(x => x > cut).length : 0,
            reports: st ? st.reports : 0, chatFlags: st ? st.chat : 0, prevBans: (k && banCount[k]) || 0 };
        })
      });
    }
    return out;
  }
  A('get', '/rooms', (req, res) => res.json({ ok: true, rooms: roomList() }));

  A('post', '/room/reset', (req, res, a) => {
    const r = rooms.get(clean((req.body || {}).code, 4).toUpperCase());
    if (!r) return res.status(404).json({ ok: false, error: 'Room not found' });
    /* every seat "asks for a rematch" -> the clients start a fresh game together */
    for (let i = 1; i <= r.cap; i++) io.to(r.code).emit('m', { k: 'rr', p: i });
    r.lastMove = now();
    log(a, 'reset room ' + r.code); res.json({ ok: true });
  });
  A('post', '/room/close', (req, res, a) => {
    const r = rooms.get(clean((req.body || {}).code, 4).toUpperCase());
    if (!r) return res.status(404).json({ ok: false, error: 'Room not found' });
    io.to(r.code).emit('room-closed', { by: 'admin' });
    r.seats.forEach(s => { const so = s && io.sockets.sockets.get(s.id); if (so) { so.leave(r.code); so.data.room = null; so.data.seat = -1; } });
    rooms.delete(r.code);
    log(a, 'closed room ' + r.code); res.json({ ok: true });
  });

  const seatOf = b => {
    const r = rooms.get(clean(b.code, 4).toUpperCase()), role = Math.round(+b.role);
    const s = r && role >= 1 && role <= r.cap ? r.seats[role - 1] : null;
    return { r, s, so: s && io.sockets.sockets.get(s.id) };
  };
  A('post', '/kick', (req, res, a) => {
    const b = req.body || {}, { s, so } = seatOf(b);
    if (!s) return res.status(404).json({ ok: false, error: 'Player not in that seat any more' });
    if (so) { so.emit('kicked', { reason: clean(b.reason, 120) }); leave(so); }
    log(a, 'kicked ' + s.n + ' from ' + b.code); res.json({ ok: true });
  });
  A('post', '/ban', (req, res, a) => {
    const b = req.body || {}, { s, so } = seatOf(b);
    const key = s ? keyOfSeat(s) : (/^[0-9a-f-]{36}$/i.test(String(b.uid || '')) ? String(b.uid) : '');
    if (!key) return res.status(404).json({ ok: false, error: 'Player not found' });
    if (s && s.uid && s.uid === a.uid) return res.status(400).json({ ok: false, error: 'You cannot ban yourself' });
    const hours = Math.max(0, Math.min(24 * 365, +b.hours || 0));
    const until = hours ? now() + hours * 3600000 : 0;
    const reason = clean(b.reason, 120);
    bans[key] = { name: clean((s && s.n) || b.name, 24) || key, reason, until, by: a.email, at: now() };
    banCount[key] = (banCount[key] || 0) + 1; saveBans();
    if (so) { so.emit('banned', { reason, until }); leave(so); setTimeout(() => { try { so.disconnect(true); } catch (e) {} }, 300); }
    log(a, 'banned ' + key + (hours ? ' for ' + hours + 'h' : ' permanently')); res.json({ ok: true });
  });
  A('get', '/bans', (req, res) => {
    const out = [];
    for (const k of Object.keys(bans)) { const b = activeBan(k); if (b) out.push({ uid: k, name: b.name, reason: b.reason, until: b.until, by: b.by, at: b.at }); }
    res.json({ ok: true, bans: out.sort((x, y) => y.at - x.at) });
  });
  A('post', '/unban', (req, res, a) => {
    const key = clean((req.body || {}).uid, 64);
    if (bans[key]) { delete bans[key]; saveBans(); }
    log(a, 'unbanned ' + key); res.json({ ok: true });
  });

  /* ---------- admin: announcements ---------- */
  const LEVELS = ['info', 'warn', 'urgent', 'event'];
  A('get', '/announcements', (req, res) => res.json({ ok: true, list: ann.slice(0, 30).map(a => ({ id: a.id, level: a.level, text: a.text, created: a.created, exp: a.exp, cleared: !!a.cleared, by: a.by })) }));
  A('post', '/announce', (req, res, a) => {
    const b = req.body || {}, text = {};
    ['en', 'bn', 'hi', 'es'].forEach(c => { const v = clean(b.text && b.text[c], 300); if (v) text[c] = v; });
    if (!text.en) return res.status(400).json({ ok: false, error: 'English text is required' });
    const level = LEVELS.includes(b.level) ? b.level : 'info', mins = Math.max(0, Math.min(240, +b.mins || 0));
    const ttl = Math.max(1, Math.min(240, +b.ttl || 20)), t = now();
    const at = mins ? t + mins * 60000 : 0;
    const exp = b.sticky ? (at || t) + 60 * 60000 : (at || t) + ttl * 60000;
    const x = { id: crypto.randomBytes(6).toString('hex'), level, text, at, exp, created: t, by: a.email };
    ann.unshift(x); if (ann.length > 50) ann.pop();
    io.emit('announce', { id: x.id, level, text, at, exp, now: t });
    log(a, 'announcement ' + x.id); res.json({ ok: true, id: x.id });
  });
  A('post', '/announce/clear', (req, res, a) => {
    const b = req.body || {};
    if (b.all) { ann.forEach(x => { x.cleared = true; }); io.emit('announce-clear', { all: true }); }
    else { const x = ann.find(y => y.id === clean(b.id, 20)); if (x) x.cleared = true; io.emit('announce-clear', { id: clean(b.id, 20) }); }
    log(a, 'cleared announcements'); res.json({ ok: true });
  });

  return hooks;
};
