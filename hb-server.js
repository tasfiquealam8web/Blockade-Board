/* Blockade Board: shared "human bot" live lobby.
   ONE simulation runs here on the server, so every device sees exactly the same Live Lobby
   (same rooms, same codes, same player / live-game / open-room counts).
   The browsers only DISPLAY it (GET /api/hb) and claim a room when a player joins (POST /api/hb/join).
   The 175 names live in index.html (fixed seed); the server only deals in ids 0..174.
   If this server is asleep or unreachable the browser falls back to its own local simulation.

   Loaded by server.js:  require('./hb-server')({ app });                                              */
module.exports = function initHB(ctx) {
  const { app } = ctx;
  const TOTAL = 175;
  const CAPM = { classic: 2, race: 2, king: 2, '2v2': 4, '3pt': 4, ffa: 4 };
  /* spread over all modes (classic is no longer 55%) */
  const MODES = [['classic', 28], ['race', 17], ['king', 16], ['2v2', 14], ['ffa', 12], ['3pt', 13]];
  const DUR = { classic: [4, 12], race: [3, 9], king: [6, 14], '2v2': [8, 16], ffa: [8, 16], '3pt': [8, 16] };   /* minutes */

  const rnd = (a, b) => a + Math.random() * (b - a);
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const ids = Array.from({ length: TOTAL }, (_, i) => i);
  const on = new Array(TOTAL).fill(false);
  const inRoom = new Array(TOTAL).fill(null);   /* a room object, or {st:'you'} while playing a real person */
  const rooms = [];

  const online = () => ids.filter(i => on[i]);
  const idle = () => ids.filter(i => on[i] && !inRoom[i]);
  const pickOne = a => a[Math.floor(Math.random() * a.length)];
  function pickMode(avoid) {
    let list = MODES.filter(m => !avoid || !avoid.has(m[0]));
    if (!list.length) list = MODES;
    let t = 0; list.forEach(x => { t += x[1]; });
    let u = Math.random() * t;
    for (const x of list) { if ((u -= x[1]) <= 0) return x[0]; }
    return list[0][0];
  }
  function target(now) {
    const d = new Date(now), h = d.getUTCHours() + d.getUTCMinutes() / 60, day = .5 + .5 * Math.sin((h - 9) / 24 * 2 * Math.PI);
    const f = .52 + .2 * day + .07 * Math.sin(now / 410000) + .05 * Math.sin(now / 97000 + 1.3) + .03 * Math.sin(now / 23000);
    return Math.max(60, Math.min(TOTAL - 8, Math.round(TOTAL * f)));
  }
  function wake() { const off = ids.filter(i => !on[i]); if (!off.length) return -1; const i = pickOne(off); on[i] = true; return i; }
  function takeIdle() { const a = idle(); return a.length ? pickOne(a) : wake(); }
  function code() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c;
    do { c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; } while (rooms.some(r => r.code === c));
    return c;
  }
  function newRoom(st, now, mode) {
    const host = takeIdle(); if (host < 0) return null;
    const avoid = new Set(rooms.filter(r => r.st === 'wait').map(r => r.mode));
    const m = mode || pickMode(avoid), cap = CAPM[m];
    const life = rnd(90000, 240000);                         /* a room stays open 1.5-4 min */
    const r = { code: code(), mode: m, cap, seats: [host], st, made: now, life, end: 0, quit: Math.random() < .06 ? now + life * rnd(.5, .9) : 0, join: [] };
    inRoom[host] = r;
    /* the others walk in one by one while the room is open */
    for (let k = 1; k < cap; k++) r.join.push(cap === 2 ? rnd(.3, .8) : rnd(.22 + (k - 1) * .2, .42 + (k - 1) * .18));
    if (st === 'play') {
      while (r.seats.length < cap) { const g = takeIdle(); if (g < 0) break; inRoom[g] = r; r.seats.push(g); }
      const du = DUR[m]; r.end = now + rnd(.1, 1) * rnd(du[0], du[1]) * 60000;
    }
    rooms.push(r); return r;
  }
  function freeRoom(r) { r.seats.forEach(i => { if (inRoom[i] === r) inRoom[i] = null; }); }
  function sit(r) { const g = takeIdle(); if (g < 0) return false; inRoom[g] = r; r.seats.push(g); return true; }

  function tick() {
    const now = Date.now();
    for (let i = rooms.length - 1; i >= 0; i--) {
      const r = rooms[i];
      if (r.st === 'play' && now >= r.end) { freeRoom(r); rooms.splice(i, 1); continue; }
      if (r.st === 'wait') {
        if (r.quit && now >= r.quit && r.seats.length === 1) { freeRoom(r); rooms.splice(i, 1); continue; }   /* host gives up */
        const age = (now - r.made) / r.life;
        while (r.seats.length < r.cap && age >= (r.join[r.seats.length - 1] || 1)) { if (!sit(r)) break; }
        if (age >= 1) while (r.seats.length < r.cap) { if (!sit(r)) break; }
        if (r.seats.length >= r.cap) { const du = DUR[r.mode]; r.st = 'play'; r.end = now + rnd(du[0], du[1]) * 60000; }
      }
    }
    const want = target(now), n = online().length;
    if (n < want) { for (let k = 0; k < Math.min(3, want - n); k++) wake(); }
    else if (n > want) { const a = shuffle(idle()); for (let k = 0; k < Math.min(3, n - want) && k < a.length; k++) on[a[k]] = false; }
    /* open rooms: always a few, in DIFFERENT modes where possible */
    const wantOpen = Math.max(3, Math.min(8, Math.round(n / 24 + 1.3 * Math.sin(now / 53000))));
    let open = rooms.filter(r => r.st === 'wait').length;
    while (open < wantOpen && newRoom('wait', now)) open++;
    /* about half of the online bots are in a game */
    let busy = rooms.reduce((a, r) => a + (r.st === 'play' ? r.seats.length : 0), 0);
    const wantBusy = Math.round(online().length * .5); let g = 0;
    while (busy < wantBusy && g++ < 6) { const r = newRoom('play', now); if (!r) break; busy += r.seats.length; }
  }
  (function init() {
    const now = Date.now(), want = target(now);
    shuffle(ids.slice()).slice(0, want).forEach(i => { on[i] = true; });
    let busy = 0, g = 0;
    while (busy < Math.round(want * .5) && g++ < 80) { const r = newRoom('play', now); if (!r) break; busy += r.seats.length; }
    for (let k = 0; k < 4; k++) { const r = newRoom('wait', now); if (r) r.made = now - r.life * rnd(0, .4); }
    setInterval(tick, 3000).unref();
  })();

  /* ---------- API ---------- */
  const hits = new Map();
  const limited = ip => { const t = Date.now(), h = hits.get(ip); if (!h || h[1] < t) { hits.set(ip, [1, t + 60000]); return false; } return ++h[0] > 90; };
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v[1] < t) hits.delete(k); }, 60000).unref();

  app.get('/api/hb', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const wait = rooms.filter(r => r.st === 'wait').sort((a, b) => b.made - a.made);
    res.json({
      t: Date.now(), players: online().length, games: rooms.filter(r => r.st === 'play').length, open: wait.length,
      rooms: wait.map(r => ({ code: r.code, mode: r.mode, cap: r.cap, made: r.made, seats: r.seats.slice() }))
    });
  });

  /* a real player took a room: it leaves the lobby for everybody, its bots are busy for a while */
  app.post('/api/hb/join', (req, res) => {
    if (limited(req.ip)) return res.status(429).json({ ok: false });
    const c = String((req.body || {}).code || '').toUpperCase().slice(0, 4);
    const i = rooms.findIndex(r => r.code === c && r.st === 'wait');
    if (i < 0) return res.status(404).json({ ok: false });
    const r = rooms[i]; rooms.splice(i, 1);
    const team = r.seats.slice();
    while (team.length < r.cap - 1) { const g = takeIdle(); if (g < 0) break; team.push(g); }
    team.forEach(g => { inRoom[g] = { st: 'you' }; });
    setTimeout(() => team.forEach(g => { if (inRoom[g] && inRoom[g].st === 'you') inRoom[g] = null; }), 8 * 60000).unref();
    res.json({ ok: true, mode: r.mode, seats: team });
  });
};
