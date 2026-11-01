/*!
 * agent-network.js · the 21K hero network · v3.1 · 1 Nov 2026 (defaults: Kyu's settings)
 *
 * A few agents drift in space and begin to exchange. Each agent that is consulted four times
 * gives birth to new agents; growth compounds until the network is a small city: busy agents
 * swell into hubs, the paths used most thicken into roads, districts are joined by trunks.
 * While it lives, information rises at the hubs and flows out to the small agents at the edge.
 * Then the outskirts go dark first and a few agents at the centre start the next cycle.
 * Canvas 2D, no dependencies.
 *
 *   const net = AgentNetwork.mount(document.querySelector('.field'), { color: '#141414' });
 *   net.set({ reach: 0.4 });   // change parameters live
 *   net.restart(); net.pause(); net.resume(); net.destroy(); net.stats();
 *
 * Pass a sized box: the animation fills it and never changes its size, so the page never
 * shifts. All tuning values are in AgentNetwork.defaults.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------------------
  // Parameters: every tuning value in one place
  // ---------------------------------------------------------------------------------------
  const DEFAULTS = Object.freeze({
    // Size of the network
    maxAgents: 720,             // agent limit when the box is at least mobileWidth wide
    maxAgentsMobile: 230,       // agent limit below mobileWidth
    mobileWidth: 640,           // CSS px
    seedMin: 2,                 // agents at the start of each cycle
    seedMax: 5,
    // Growth rules
    spawnThreshold: 2,          // completed incoming connections that make an agent spawn
    spawnMin: 3,                // agents born per spawn
    spawnMax: 6,
    maxConcurrentSpawns: 3,     // spawns at once while the network is small
    spawnShare: 0.25,           // share of agents that may be spawning at once as it grows
    settleTime: 0.6,            // s after landing before a new agent may spawn
    // Connections
    burstMin: 1,                // connections per burst
    burstMax: 3,
    connectionFrequency: 2,     // multiplier on how often bursts come
    reach: 0.3,                 // share of connections that join busy agents across the whole city
    hubStrength: 0,             // how strongly connections favour busy agents: 0 not at all, 1.5 strongly
    bridgeChance: 0.12,         // share of connections that join neighbouring districts, hub to hub
    linesPerAgent: 3,           // visible lines allowed per agent; thin, idle, old ones fade first
    // Space and motion
    spacing: 0.7,               // multiplier on distances between agents
    speed: 1.2,                 // multiplier on drift, glide, drawing and signal speed
    // Phase durations in seconds; a [min, max] pair picks a value each cycle
    phaseScale: 1,
    phases: Object.freeze({ emergence: 2, connection: 5, expansion: [30, 44], living: [6, 8], renewal: [3.5, 4.5] }),
    // Look
    color: '#141414',           // one colour for agents, lines and signals
    lineOpacity: 0.2,
    pulseIntensity: 2,
    dotSize: 1,
    // Behaviour
    reducedMotion: 'auto',      // 'auto' follows prefers-reduced-motion; true or false forces it
    maxDpr: 2,
    seed: null                  // a number repeats the same sequence; null gives a new one each load
  });

  const PHASES = ['emergence', 'connection', 'expansion', 'living', 'renewal'];
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));
  const glideEase = (t) => easeInOut(Math.pow(clamp(t, 0, 1), 0.7)); // soft start, long landing
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const bez = (p0, p1, p2, t) => { const m = 1 - t; return m * m * p0 + 2 * m * t * p1 + t * t * p2; };
  const blossom = (p0, p1, p2, a, b) => (1 - a) * (1 - b) * p0 + ((1 - a) * b + a * (1 - b)) * p1 + a * b * p2;
  const pairKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  const removeFrom = (arr, x) => { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function parseColor(c) {
    const s = String(c || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) return [m[1], m[2], m[3]].map((v) => clamp(Math.round(+v), 0, 255));
    return [20, 20, 20];
  }

  function haloSprite(rgb) {
    const s = 64, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    [[0, 1], [0.2, 0.6], [0.42, 0.24], [0.7, 0.06], [1, 0]].forEach(([o, a]) =>
      grd.addColorStop(o, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'));
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return cv;
  }

  // Critically damped spring, solved exactly, so it is smooth at any frame rate.
  function spring(s, target, omega, dt) {
    const x = s.x - target, v = s.v, e = Math.exp(-omega * dt), k = v + omega * x;
    s.x = target + (x + k * dt) * e;
    s.v = (v - k * omega * dt) * e;
  }

  function mergeParams(base, o) {
    const out = Object.assign({}, base, o || {});
    out.phases = Object.assign({}, base.phases, (o && o.phases) || {});
    return out;
  }

  // ---------------------------------------------------------------------------------------
  function create(host, options) {
    if (typeof host === 'string') host = document.querySelector(host);
    if (!host) throw new Error('AgentNetwork: no element to mount on');
    const P = mergeParams(DEFAULTS, options);

    let canvas = host, owned = false;
    if (!(host instanceof HTMLCanvasElement)) {
      canvas = document.createElement('canvas');
      owned = true;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'block' });
      canvas.setAttribute('aria-hidden', 'true');
      host.appendChild(canvas);
    } else {
      if (!canvas.style.width) canvas.style.width = '100%';
      if (!canvas.style.height) canvas.style.height = '100%';
      canvas.style.display = 'block';
    }
    const ctx = canvas.getContext('2d');

    let rng = mulberry32(P.seed == null ? (Math.random() * 4294967296) >>> 0 : P.seed);
    const rand = (a, b) => a + (b - a) * rng();
    const randi = (a, b) => Math.floor(a + (b - a + 1) * rng());
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const range = (v) => (Array.isArray(v) ? rand(v[0], v[1]) : v);
    function weightedIndex(ws) {
      let sum = 0;
      for (let i = 0; i < ws.length; i++) sum += ws[i];
      if (!(sum > 0)) return -1;
      let r = rng() * sum;
      for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r <= 0) return i; }
      return ws.length - 1;
    }

    // Size and colour
    let W = 0, H = 0, dpr = 1, sc = 1, lw = 0.5;
    let rgbStr = '', sprite = null;
    function applyColor() {
      const rgb = parseColor(P.color);
      rgbStr = 'rgb(' + rgb.join(',') + ')';
      sprite = haloSprite(rgb);
    }
    applyColor();

    // Simulation state
    let T = 0, MT = 0, cycle = 0, phase = 0, phaseStart = 0, cycleStart = 0;
    let durs = [2, 5, 20, 7, 4];
    let agents = [], conns = [], pulses = [], spawns = [], pendingLinks = [], timers = [];
    const amap = new Map(), pairs = new Map(), grid = new Map();
    let plan = null, counts = [], clusterAvail = [], avail = [], liveCount = 0, availCount = 0, activeSpawnCount = 0;
    let netCx = 0, netCy = 0, cell = 10;
    let nextId = 1, nextConnId = 1, nextBurst = Infinity, nextSignal = Infinity, nextCascade = Infinity, nextGlow = Infinity, nextPrune = 0, lastFocus = -1;
    const cam = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, lz: { x: Math.log(1.45), v: 0 } };
    let reduced = false, frozen = false, started = false, destroyed = false, manualPause = false, building = 0;
    let raf = 0, last = 0, visible = true, Tr = 0, rAcc = 0;

    // -------------------------------------------------------------------------------------
    // The plan for one cycle: unit distance, agent limit and the districts that may grow
    // -------------------------------------------------------------------------------------
    function makePlan() {
      const w = W || 900, h = H || 520;
      const mobile = w < P.mobileWidth;
      const maxA = Math.max(6, Math.round(mobile ? P.maxAgentsMobile : P.maxAgents));
      const u = P.spacing * Math.sqrt((w * h * 0.3) / maxA);
      const cap = Math.max(P.seedMax + P.spawnMin, Math.round(maxA * rand(0.86, 1)));
      const bx = w / 2 / 0.92 - 0.5 * u, by = h / 2 / 0.92 - 0.5 * u;
      let clusters = null;
      for (let k = clamp(Math.round(2 + Math.sqrt(cap) / 4), 1, 12); k >= 1 && !clusters; k--) {
        clusters = layoutClusters(k, cap, u, bx, by);
      }
      const total = clusters.reduce((s, c) => s + c.cap, 0);
      return { u, cap: Math.min(cap, total), minSep: 0.5 * u, bx, by, clusters, mobile, n0: 0, zMax: clamp(80 / u, 1.45, 7) };
    }

    function layoutClusters(k, cap, u, bx, by) {
      const wts = [];
      for (let i = 0; i < k; i++) wts.push(rand(0.75, 1.25));
      wts[0] *= 0.85;
      const sum = wts.reduce((s, w) => s + w, 0);
      const caps = wts.map((w) => Math.max(3, Math.round((cap * w) / sum)));
      const radius = (c) => (0.46 * Math.sqrt(c) + 0.3) * u;
      if (k === 1) return [{ id: 0, x: 0, y: 0, r: radius(caps[0]), cap: caps[0] }];
      let best = null, bestScore = -Infinity;
      for (let trial = 0; trial < 36; trial++) {
        const cl = [{ id: 0, x: 0, y: 0, r: radius(caps[0]), cap: caps[0] }];
        let ok = true;
        for (let i = 1; i < k && ok; i++) {
          // Each new district sits beside one already placed, with breathing room between them
          const r = radius(caps[i]);
          let chosen = null, cs = -Infinity;
          for (let n = 0; n < 48; n++) {
            const anchor = pick(cl), ang = rand(0, TAU), gap = rand(1.5, 2.1) * u;
            const x = anchor.x + Math.cos(ang) * (anchor.r + r + gap), y = anchor.y + Math.sin(ang) * (anchor.r + r + gap);
            if (Math.abs(x) > bx - 0.6 * r || Math.abs(y) > by - 0.6 * r) continue;
            let clear = Infinity;
            for (const c of cl) clear = Math.min(clear, dist(x, y, c.x, c.y) - c.r - r);
            if (clear < 1.4 * u) continue;
            const s = -Math.hypot(x / bx, y / by) + rand(0, 0.35);
            if (s > cs) { cs = s; chosen = { id: i, x, y, r, cap: caps[i] }; }
          }
          if (chosen) cl.push(chosen); else ok = false;
        }
        if (!ok) continue;
        let sx = 0, sy = 0, sw = 0, ex = 0, ey = 0;
        for (const c of cl) {
          sx += c.x * c.cap; sy += c.y * c.cap; sw += c.cap;
          ex = Math.max(ex, Math.abs(c.x) + c.r); ey = Math.max(ey, Math.abs(c.y) + c.r);
        }
        const off = Math.hypot(sx / sw / bx, sy / sw / by);
        const score = -2 * off + Math.min(ex / bx, ey / by) + rand(0, 0.2);
        if (score > bestScore) { bestScore = score; best = cl; }
      }
      return best;
    }

    function seedSlots(n) {
      const u = plan.u, pts = [];
      for (let tries = 0; pts.length < n && tries < 600; tries++) {
        const a = rand(0, TAU), r = rand(0.4, 1.45) * u * (n > 3 ? 1.12 : 1);
        const x = Math.cos(a) * r * 1.25, y = Math.sin(a) * r * 0.85;
        if (pts.every((p) => dist(p.x, p.y, x, y) >= 1.05 * u)) pts.push({ x, y });
      }
      let cx = 0, cy = 0;
      pts.forEach((p) => { cx += p.x; cy += p.y; });
      cx /= pts.length || 1; cy /= pts.length || 1;
      pts.forEach((p) => { p.x -= cx * 0.7; p.y -= cy * 0.7; });
      return pts;
    }

    // -------------------------------------------------------------------------------------
    // A spatial grid of agents, rebuilt each step, so neighbour queries stay cheap at scale
    // -------------------------------------------------------------------------------------
    const gkey = (ix, iy) => (ix + 32768) * 65536 + (iy + 32768);
    function gridAdd(a) {
      const k = gkey(Math.floor(a.x / cell), Math.floor(a.y / cell));
      let l = grid.get(k);
      if (!l) { l = []; grid.set(k, l); }
      l.push(a);
    }
    function eachNear(x, y, r, fn) {
      const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell);
      const j0 = Math.floor((y - r) / cell), j1 = Math.floor((y + r) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const l = grid.get(gkey(i, j));
          if (l) for (let n = 0; n < l.length; n++) fn(l[n]);
        }
      }
    }

    // -------------------------------------------------------------------------------------
    // Agents and paths
    // -------------------------------------------------------------------------------------
    function newAgent(x, y, cluster) {
      const u = plan.u;
      const a = {
        id: nextId++, x, y, rx: x, ry: y, sx: 0, sy: 0, cluster, born: T,
        amp: rand(0.07, 0.12) * u, w1: TAU / rand(9, 15), w2: TAU / rand(14, 23),
        p1: rand(0, TAU), p2: rand(0, TAU), p3: rand(0, TAU), p4: rand(0, TAU), bp: rand(7, 13),
        driftStart: null, presence: 0, fadeIn: null, fadeOut: null, glide: null, hidden: false, dead: false,
        incoming: 0, pendingIn: 0, spawned: false, eligibleAt: 0, nextTry: 0, landed: 0,
        act: 0, actT: 0, seed: false, traffic: 0, size: 0.62, edges: []
      };
      agents.push(a);
      amap.set(a.id, a);
      if (plan) gridAdd(a);
      return a;
    }

    function killAgent(a) {
      if (a.dead) return;
      a.dead = true;
      for (const c of a.edges.slice()) dropConn(c);
      amap.delete(a.id);
    }

    const kick = (a, v) => { if (a) a.actT = Math.max(a.actT, v); };
    const isAvail = (a) => !a.dead && !a.hidden && !a.glide && !a.fadeOut && a.presence > 0.9;
    const pref = (a) => Math.pow(1 + a.traffic, P.hubStrength);   // busy agents draw more connections

    // One path per pair. A first connection draws a new path; later ones travel along it and
    // thicken it, so the paths used most become roads.
    function addConn(src, dst, kind) {
      const u = plan.u, len = dist(src.x, src.y, dst.x, dst.y);
      const c = {
        id: nextConnId++, a: src.id, b: dst.id, key: pairKey(src.id, dst.id), kind,
        bend: (kind === 'birth' ? 0.05 : 0.07) * (rng() < 0.5 ? -1 : 1),
        born: T, done: false, progress: 0, drawDur: clamp(len / (4.2 * u), 0.35, 1.4) / P.speed,
        act: 0.55, lastUsed: T, fade: null, alpha: 1, dead: false, weight: 1, wDisp: 1,
        breathP: rand(6, 12), breathPh: rand(0, TAU)
      };
      conns.push(c);
      pairs.set(c.key, c);
      src.edges.push(c); dst.edges.push(c);
      src.traffic += 1;
      if (kind === 'link') { dst.pendingIn++; kick(src, 0.45); }
      return c;
    }

    function fadeConn(c, dur) {
      if (c.fade || c.dead) return;
      c.fade = { at: T, dur };
      if (pairs.get(c.key) === c) pairs.delete(c.key);
    }

    function dropConn(c) {
      if (c.dead) return;
      c.dead = true;
      if (pairs.get(c.key) === c) pairs.delete(c.key);
      const A = amap.get(c.a), B = amap.get(c.b);
      if (A) removeFrom(A.edges, c);
      if (B) {
        removeFrom(B.edges, c);
        if (!c.done && c.kind === 'link') B.pendingIn = Math.max(0, B.pendingIn - 1);
      }
    }

    function makeLink(src, dst) {
      if (!src || !dst || src === dst) return false;
      const ex = pairs.get(pairKey(src.id, dst.id));
      if (ex) {
        if (!ex.done || ex.fade) return false;
        const len = dist(src.x, src.y, dst.x, dst.y);
        pulses.push({ c: ex, kind: 'link', from: src.id, to: dst.id, dir: ex.a === src.id ? 1 : -1,
          start: T, dur: clamp(0.3 + len / (4.2 * plan.u), 0.4, 1.3) / P.speed });
        dst.pendingIn++; src.traffic += 1; kick(src, 0.45);
        return true;
      }
      addConn(src, dst, 'link');
      return true;
    }

    // -------------------------------------------------------------------------------------
    // Spawning
    // -------------------------------------------------------------------------------------
    const roomIn = (c) => c.cap - counts[c.id];
    const globalRoom = () => plan.cap - liveCount;
    const spawnAllowed = () => phase === 1 || phase === 2 || (phase === 3 && T - phaseStart < 0.35 * durs[3]);
    function maxConcurrent() {
      const scaled = Math.round(liveCount * P.spawnShare);
      if (phase === 1) return Math.max(Math.min(2, P.maxConcurrentSpawns), scaled);
      if (phase === 3) return Math.max(1, Math.round(scaled * 0.25));
      return Math.max(P.maxConcurrentSpawns, scaled);
    }

    // A full district sends its children to the nearest district with room, from the side
    // that faces it; pioneers fly further when the near districts are full.
    function spillTarget(a) {
      const own = plan.clusters[a.cluster];
      let best = null, bd = Infinity;
      for (const c of plan.clusters) {
        if (c === own || roomIn(c) < P.spawnMin) continue;
        if (own && (a.x - own.x) * (c.x - own.x) + (a.y - own.y) * (c.y - own.y) < 0) continue;
        const d = dist(a.x, a.y, c.x, c.y) - c.r * (counts[c.id] ? 1 : 0.6);
        if (counts[c.id] >= 3 && d > 3 * plan.u) continue;   // once pioneers have landed, the district grows on its own
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }

    function canSpawn(a) {
      if (a.spawned || a.fadeOut || globalRoom() < P.spawnMin) return false;
      const own = plan.clusters[a.cluster];
      if (own && roomIn(own) >= P.spawnMin) return true;
      return !!spillTarget(a);
    }

    // Null when the site is taken; higher for open space inside the district's region.
    function siteScore(x, y, c, extra) {
      const u = plan.u;
      if (Math.abs(x) > plan.bx || Math.abs(y) > plan.by) return null;
      let dmin = Infinity;
      eachNear(x, y, 1.2 * u, (b) => { if (!b.fadeOut && !b.dead) { const d = dist(x, y, b.x, b.y); if (d < dmin) dmin = d; } });
      for (const p of extra) { const d = dist(x, y, p.x, p.y); if (d < dmin) dmin = d; }
      if (dmin < plan.minSep) return null;
      let s = Math.min(dmin, 1.2 * u) / u;
      const dc = dist(x, y, c.x, c.y);
      if (dc > c.r) s -= (1.4 * (dc - c.r)) / u;
      for (const o of plan.clusters) {
        if (o === c) continue;
        const d = dist(x, y, o.x, o.y), lim = o.r + 0.5 * u;
        if (d < lim) s -= (1.8 * (lim - d)) / u;
      }
      return s;
    }

    function placeNear(a, n, c, wide) {
      const u = plan.u, out = [], r0 = wide ? 1.2 : 0.7, r1 = wide ? 2.2 : 1.2;
      const ox = a.x - c.x, oy = a.y - c.y, ol = Math.hypot(ox, oy) || 1;
      for (let i = 0; i < n; i++) {
        let best = null, bs = -Infinity;
        for (let k = 0; k < 26; k++) {
          const ang = rand(0, TAU), r = rand(r0, r1) * u;
          const x = a.x + Math.cos(ang) * r, y = a.y + Math.sin(ang) * r;
          const s = siteScore(x, y, c, out);
          if (s === null) continue;
          const outward = (Math.cos(ang) * ox + Math.sin(ang) * oy) / ol;
          const total = s + 0.3 * outward + rand(0, 0.35);
          if (total > bs) { bs = total; best = { x, y }; }
        }
        if (!best) break;
        out.push(best);
      }
      return out;
    }

    function placeIn(c, a, n) {
      const u = plan.u, out = [];
      const empty = counts[c.id] === 0;
      const dx = a.x - c.x, dy = a.y - c.y, dl = Math.hypot(dx, dy) || 1;
      const tilt = rand(-0.5, 0.5), cs = Math.cos(tilt), sn = Math.sin(tilt);
      const ux = (dx * cs - dy * sn) / dl, uy = (dx * sn + dy * cs) / dl;     // the near side, turned a little
      const ax = c.x + ux * c.r * (empty ? 0.4 : 0.5), ay = c.y + uy * c.r * (empty ? 0.4 : 0.5);
      for (let i = 0; i < n; i++) {
        let best = null, bs = -Infinity;
        for (let k = 0; k < 30; k++) {
          const ang = rand(0, TAU), r = (out.length ? rand(0.5, 1.4) : rand(0, 1.8)) * u;
          const x = ax + Math.cos(ang) * r, y = ay + Math.sin(ang) * r;
          const s = siteScore(x, y, c, out);
          if (s === null) continue;
          const total = s - (0.4 * dist(x, y, ax, ay)) / u + rand(0, 0.3);
          if (total > bs) { bs = total; best = { x, y }; }
        }
        if (!best) break;
        out.push(best);
      }
      return out;
    }

    function planSpawn(a) {
      const gr = globalRoom();
      if (gr < P.spawnMin) return null;
      const n = Math.min(randi(P.spawnMin, Math.max(P.spawnMin, P.spawnMax)), gr);
      const own = plan.clusters[a.cluster];
      let targets, cluster = a.cluster, far = false;
      const need = Math.min(P.spawnMin, n);
      targets = [];
      // A district a third full starts seeding its neighbours, so several districts grow at once
      const fill = own ? counts[own.id] / own.cap : 1;
      const early = phase !== 3 && fill > 0.33 && rng() < (fill - 0.33) * 1.4 ? spillTarget(a) : null;
      if (early) {
        targets = placeIn(early, a, Math.min(randi(2, 3), roomIn(early)));
        if (targets.length >= need) return { targets, cluster: early.id, far: true };
        targets = [];
      }
      if (own && roomIn(own) >= P.spawnMin) {
        // Near the parent first; if that is crowded, a little further out
        targets = placeNear(a, Math.min(n, roomIn(own)), own, false);
        if (targets.length < need) targets = placeNear(a, Math.min(n, roomIn(own)), own, true);
      }
      if (targets.length < need) {
        const c = phase === 3 ? null : spillTarget(a);   // while living, growth stays local
        if (!c) return null;
        targets = placeIn(c, a, Math.min(randi(2, 3), roomIn(c)));
        cluster = c.id;
        far = true;
      }
      if (!targets.length || targets.length < need) return null;
      return { targets, cluster, far };
    }

    function triggerSpawn(a, sp) {
      a.spawned = true;
      kick(a, 1);                                   // the parent brightens first
      const u = plan.u;
      let at = T + 0.38, end = T;
      for (const p of sp.targets) {
        const c = newAgent(p.x, p.y, sp.cluster);
        const d = dist(a.x, a.y, p.x, p.y);
        const dur = (sp.far ? clamp(1.3 + d / (4.5 * u), 1.5, 3.2) : rand(1.2, 1.6)) / P.speed;
        c.hidden = true;
        c.glide = { at, dur, started: false, birth: true, parent: a.id, fx: a.rx, fy: a.ry };
        c.driftStart = at + dur;
        c.eligibleAt = at + dur + P.settleTime;
        c.rx = a.rx; c.ry = a.ry;
        end = Math.max(end, at + 0.6);              // the event lasts until the last child is on its way
        at += rand(0.16, 0.3);                      // a soft ripple, not a burst
      }
      spawns.push({ parent: a.id, end });
      activeSpawnCount++;
      counts[sp.cluster] += sp.targets.length;
      liveCount += sp.targets.length;
    }

    // -------------------------------------------------------------------------------------
    // Pacing: growth compounds, slowly at first, then fast, then the city fills in
    // -------------------------------------------------------------------------------------
    function targetCount(t) {
      const t0 = cycleStart + durs[0], span = durs[1] + durs[2] * 0.8;
      const k = clamp((t - t0) / span, 0, 1);
      const n0 = Math.max(1, plan.n0);
      return n0 * Math.pow(plan.cap / n0, smooth(k));
    }
    const isBehind = () => liveCount < targetCount(T + 1.2);

    function burstInterval() {
      let base;
      if (phase === 1) base = rand(0.45, 0.75);
      else if (phase === 2) {
        base = (1.05 / (0.55 + availCount / 10)) * rand(0.75, 1.25);
        const deficit = targetCount(T + 1.2) - liveCount;
        if (deficit > 0) base /= 1 + 2.5 * clamp(deficit / (6 + 0.12 * liveCount), 0, 1);
        if (globalRoom() < P.spawnMin) base *= 1.7;
      } else {
        base = (lerp(0.8, 2.0, (T - phaseStart) / durs[3]) * rand(0.8, 1.25)) / (0.55 + availCount / 60);
      }
      return base / Math.max(0.05, P.connectionFrequency);
    }

    function chooseFocus() {
      const behind = phase <= 2 && isBehind();
      const ws = clusterAvail.map((g, i) => {
        if (!g.length) return 0;
        let w = 0.5 + Math.min(g.length, 8) * 0.1;
        if (behind) {
          let n = 0;
          for (const a of g) if (!a.spawned && canSpawn(a)) n++;
          w += Math.min(n, 12) * 0.6 + (g.length <= 5 && roomIn(plan.clusters[i]) >= P.spawnMin ? 1.5 : 0);
        }
        if (i === lastFocus) w *= 0.45;
        return w;
      });
      lastFocus = weightedIndex(ws);
      return lastFocus;
    }

    // Share of free sites around an agent, so growth goes where there is room to grow.
    function openness(a) {
      if (a._openT !== undefined && T - a._openT < 0.4) return a._open;
      const own = plan.clusters[a.cluster], u = plan.u;
      let c = own;
      if (!own || roomIn(own) < P.spawnMin) c = spillTarget(a);
      let free = 0;
      if (c && c !== own) free = 1;
      else if (c) {
        for (let i = 0; i < 12; i++) {
          const rr = (i % 2 ? 1.6 : 0.95) * u, ang = (i / 12) * TAU + a.p1, x = a.x + Math.cos(ang) * rr, y = a.y + Math.sin(ang) * rr;
          const s = siteScore(x, y, c, []);
          if (s !== null && s > -0.6) free++;
        }
        free /= 12;
      }
      a._open = free; a._openT = T;
      return free;
    }

    // While growth is behind schedule, a burst converges on one agent that can spawn.
    function pickGrowthTarget(focus) {
      const thr = P.spawnThreshold, cands = [], ws = [];
      for (const a of avail) {
        const k = a.incoming + a.pendingIn;
        if (k >= thr || a.spawned || !canSpawn(a)) continue;
        const open = openness(a);
        if (open <= 0) continue;
        let w = Math.pow(1 + k, 1.5) * (a.cluster === focus ? 2.5 : 1) * (0.25 + open) * (counts[a.cluster] <= 5 ? 2 : 1);
        if (T < a.eligibleAt - 1) w *= 0.4;
        cands.push(a); ws.push(w);
      }
      const i = weightedIndex(ws);
      return i >= 0 ? cands[i].id : 0;
    }

    // Distance preference of one new link. A 'wide' link (chance = reach) ignores distance.
    function nearWeight(d, wide) {
      if (wide) return 1;
      const u = plan.u;
      return Math.exp(-d / (0.95 * u)) * (d > 2.4 * u ? 0.06 : 1);
    }

    function growthBias(b, ctxw) {
      const k = b.incoming + b.pendingIn, thr = P.spawnThreshold;
      if (k >= thr || b.spawned) return 1;
      if (!canSpawn(b)) return 1;
      if (phase <= 2) {
        if (ctxw.behind && !ctxw.full) return 1 + (4 * Math.min(k + 1, thr)) / thr;
        if (k >= thr - 1) return 0.25;
        return 1;
      }
      return k >= thr - 1 ? 0.1 : 1;
    }

    // Candidates for one end of a link: neighbours by distance, or anyone when the link is wide;
    // either way, busy agents are favoured.
    function chooseNear(o, wide, weightFn) {
      const cands = [], ws = [];
      const consider = (b) => {
        if (b === o || !isAvail(b)) return;
        const w = nearWeight(dist(o.x, o.y, b.x, b.y), wide) * weightFn(b);
        if (w > 0) { cands.push(b); ws.push(w); }
      };
      if (wide) for (const b of avail) consider(b);
      else eachNear(o.x, o.y, 3 * plan.u, consider);
      if (!cands.length && !wide) return chooseNear(o, true, weightFn);
      const i = weightedIndex(ws);
      return i >= 0 ? cands[i] : null;
    }

    // Busy agents feed the newcomers, so hubs grow as the city grows.
    function linkInto(dst) {
      const src = chooseNear(dst, rng() < P.reach * 0.3, (a) => {
        const ex = pairs.get(pairKey(a.id, dst.id));
        return ex && (!ex.done || ex.fade) ? 0 : pref(a);       // not along a path still being drawn
      });
      return src ? makeLink(src, dst) : false;
    }

    function pickSource(focus) {
      const g = focus >= 0 && clusterAvail[focus] && clusterAvail[focus].length ? clusterAvail[focus] : avail;
      if (!g.length) return null;
      const i = weightedIndex(g.map((a) => Math.sqrt(pref(a))));
      return i >= 0 ? g[i] : null;
    }

    // A trunk between neighbouring districts, from a busy agent on the facing side to another.
    function bridge(src) {
      const own = plan.clusters[src.cluster], u = plan.u;
      const cand = plan.clusters.filter((c) => c !== own && clusterAvail[c.id] && clusterAvail[c.id].length);
      if (!cand.length || !own) return false;
      const tc = cand[Math.max(0, weightedIndex(cand.map((c) => Math.exp(-dist(own.x, own.y, c.x, c.y) / (4 * u)))))];
      const A = clusterAvail[own.id], B = clusterAvail[tc.id];
      const ia = weightedIndex(A.map((a) => pref(a) * Math.exp(-dist(a.x, a.y, tc.x, tc.y) / (2.5 * u))));
      if (ia < 0) return false;
      const a = A[ia];
      const ib = weightedIndex(B.map((b) => pref(b) * Math.exp(-dist(b.x, b.y, a.x, a.y) / (2.5 * u))));
      if (ib < 0) return false;
      return rng() < 0.5 ? makeLink(a, B[ib]) : makeLink(B[ib], a);
    }

    // A long connection runs between busy agents, so repeats travel the same path and become
    // trunk roads across the city instead of a web of crossing lines.
    function wideLink() {
      if (availCount < 6) return false;
      const ws = avail.map((a) => Math.pow(pref(a), 1.6));
      const i = weightedIndex(ws);
      if (i < 0) return false;
      const src = avail[i], far = 3 * plan.u;
      const j = weightedIndex(avail.map((b, k) => (k === i ? 0 : ws[k] * (dist(src.x, src.y, b.x, b.y) > far ? 1 : 0.15))));
      return j >= 0 ? makeLink(src, avail[j]) : false;
    }

    function createLink(focus, targetId) {
      if (availCount < 2) return;
      if (availCount <= 3 && phase <= 2) {
        // The first exchange: every link goes to the agent closest to spawning
        const ready = avail.filter((a) => a.incoming + a.pendingIn < P.spawnThreshold && canSpawn(a));
        if (ready.length) {
          ready.sort((p, q) => (q.incoming + q.pendingIn) - (p.incoming + p.pendingIn) || p.id - q.id);
          linkInto(ready[0]);
          return;
        }
      }
      if (targetId) {
        const t = amap.get(targetId);
        if (t && isAvail(t) && t.incoming + t.pendingIn < P.spawnThreshold && canSpawn(t) && linkInto(t)) return;
      }
      const src = pickSource(focus);
      if (!src) return;
      if (plan.clusters.length > 1 && rng() < P.bridgeChance && bridge(src)) return;
      if (rng() < P.reach && wideLink()) return;
      let dst = null;
      if (src.landed && T - src.landed < 5 && rng() < 0.25) {
        // A newcomer reaches outside its own district
        dst = chooseNear(src, false, (b) => (b.cluster !== src.cluster ? pref(b) : 0));
      }
      if (!dst) {
        const ctxw = { behind: phase <= 2 && isBehind(), full: activeSpawnCount >= maxConcurrent() };
        dst = chooseNear(src, false, (b) => pref(b) * growthBias(b, ctxw));
      }
      if (dst) makeLink(src, dst);
    }

    // -------------------------------------------------------------------------------------
    // Signals. Relays pass a pulse through two or three agents; cascades rise at a hub and
    // flow outward to smaller agents at the edge, branching as they go.
    // -------------------------------------------------------------------------------------
    function later(dt, fn) { timers.push({ at: T + dt, fn }); }
    const otherEnd = (c, a) => (c.a === a.id ? c.b : c.a);

    function startRelay(a, hops, fromId) {
      if (!a || !isAvail(a) || phase === 4) return;
      const opts = [];
      for (const c of a.edges) {
        if (!c.done || c.fade) continue;
        const oid = otherEnd(c, a);
        if (oid === fromId) continue;
        const o = amap.get(oid);
        if (o && isAvail(o)) opts.push([c, o]);
      }
      if (!opts.length) return;
      const [c, o] = pick(opts);
      pulses.push({ c, kind: 'relay', from: a.id, to: o.id, dir: c.a === a.id ? 1 : -1, start: T,
        dur: clamp(0.35 + dist(a.x, a.y, o.x, o.y) / (3.4 * plan.u), 0.5, 1.4) / P.speed, hops: hops - 1 });
      kick(a, 0.55);
    }

    function startCascade() {
      if (availCount < 4) return;
      const i = weightedIndex(avail.map((a) => a.traffic * a.traffic + 0.01));
      if (i < 0) return;
      emitCascade({ visited: new Set([avail[i].id]), count: 0 }, avail[i], 0, 0);
    }

    function emitCascade(cas, node, depth, fromId) {
      if (!node || !isAvail(node) || phase === 4) return;
      kick(node, depth === 0 ? 1 : 0.6);
      if (depth >= 8 || cas.count > 70) return;
      const dn = dist(node.x, node.y, netCx, netCy), opts = [], ws = [];
      for (const c of node.edges) {
        if (!c.done || c.fade) continue;
        const oid = otherEnd(c, node);
        if (oid === fromId || cas.visited.has(oid)) continue;
        const o = amap.get(oid);
        if (!o || !isAvail(o)) continue;
        const outward = dist(o.x, o.y, netCx, netCy) > dn, smaller = o.traffic <= node.traffic;
        if (!outward && !smaller) continue;
        opts.push([c, o]);
        ws.push(c.wDisp * (outward ? 1.3 : 1) * (smaller ? 1.2 : 1));
      }
      if (!opts.length) return;
      const n = depth === 0 ? Math.min(opts.length, randi(2, 4)) : rng() < 0.38 ? 2 : 1;
      const keep = depth === 0 ? 1 : 0.94 - 0.09 * depth;
      for (let k = 0; k < n && opts.length; k++) {
        if (rng() > keep) break;
        const i = weightedIndex(ws);
        const [c, o] = opts.splice(i, 1)[0];
        ws.splice(i, 1);
        cas.visited.add(o.id);
        cas.count++;
        pulses.push({ c, kind: 'cascade', cascade: cas, depth, from: node.id, to: o.id, dir: c.a === node.id ? 1 : -1,
          start: T, dur: clamp(0.22 + dist(node.x, node.y, o.x, o.y) / (5 * plan.u), 0.3, 1.0) / P.speed });
      }
    }

    function glow() {
      if (!availCount) return;
      const a = pick(avail);
      kick(a, 0.4);
      for (const c of a.edges) {
        if (c.fade || !c.done) continue;
        c.act = Math.max(c.act, 0.3);
        const oid = otherEnd(c, a);
        later(rand(0.15, 0.35), () => kick(amap.get(oid), 0.25));
      }
    }

    // -------------------------------------------------------------------------------------
    // Cycle and phases
    // -------------------------------------------------------------------------------------
    function startCycle(first) {
      cycle++;
      cycleStart = phaseStart = T;
      phase = 0;
      const ph = P.phases, s = Math.max(0.1, P.phaseScale);
      durs = [range(ph.emergence), range(ph.connection), range(ph.expansion), range(ph.living), range(ph.renewal)]
        .map((d) => Math.max(0.3, d * s));
      plan = makePlan();
      if (!agents.length) first = true;
      const slots = seedSlots(first ? randi(P.seedMin, P.seedMax) : agents.length);
      if (first) {
        for (const p of slots) {
          const a = newAgent(p.x, p.y, 0);
          a.seed = true;
          a.fadeIn = { at: T + rand(0, 0.55) * durs[0], dur: rand(0.8, 1.1) };
        }
      } else {
        // The retained seeds glide to a new arrangement around the middle
        const free = slots.slice();
        for (const a of agents) {
          let bi = 0, bd = Infinity;
          free.forEach((p, i) => { const d = dist(a.x, a.y, p.x, p.y); if (d < bd) { bd = d; bi = i; } });
          const p = free.splice(bi, 1)[0] || { x: a.x, y: a.y };
          a.glide = { at: T + rand(0, 0.2), dur: durs[0] * rand(0.75, 0.88), started: true, birth: false, fx: a.x, fy: a.y };
          a.x = p.x; a.y = p.y;
          a.cluster = 0; a.incoming = 0; a.pendingIn = 0; a.spawned = false; a.nextTry = 0; a.traffic = 0;
          a.eligibleAt = T + durs[0]; a.fadeOut = null; a.seed = true; a.born = T; a.landed = 0;
          a.amp = rand(0.07, 0.12) * plan.u;
        }
      }
      plan.n0 = agents.length;
      counts = plan.clusters.map(() => 0);
      clusterAvail = plan.clusters.map(() => []);
      nextBurst = phaseStart + durs[0] + rand(0.1, 0.4);
      nextSignal = nextBurst + rand(1.2, 2);
      nextCascade = Infinity;
      nextGlow = Infinity;
      if (first) snapCamera();
    }

    function beginRenewal() {
      pendingLinks = [];
      for (const a of agents) if (a.hidden) killAgent(a);
      agents = agents.filter((a) => !a.dead);
      spawns = [];
      const live = agents.filter((a) => !a.fadeOut);
      if (!live.length) return;
      const cx = cam.x.x, cy = cam.y.x;
      let core = live[0], cd = Infinity;
      for (const a of live) { const d = dist(a.rx, a.ry, cx, cy) - 0.4 * plan.u * Math.sqrt(a.traffic); if (d < cd) { cd = d; core = a; } }
      const k = Math.min(randi(P.seedMin, P.seedMax), live.length), seeds = [core];
      const rest = live.filter((a) => a !== core).sort((p, q) => dist(p.x, p.y, core.x, core.y) - dist(q.x, q.y, core.x, core.y));
      for (const a of rest) {
        if (seeds.length >= k) break;
        if (seeds.every((s) => dist(s.x, s.y, a.x, a.y) >= 0.55 * plan.u)) seeds.push(a);
      }
      const ids = new Set(seeds.map((s) => s.id));
      agents.forEach((a) => { a.seed = ids.has(a.id); });
      let mx = 0, my = 0;
      seeds.forEach((s) => { mx += s.x; my += s.y; });
      mx /= seeds.length; my /= seeds.length;
      let maxD = 1e-6;
      live.forEach((a) => { maxD = Math.max(maxD, dist(a.x, a.y, mx, my)); });
      const d5 = durs[4], spread = Math.max(0.9, d5 - 1.9);
      const outer = (a) => (a.seed ? 0 : dist(a.x, a.y, mx, my) / maxD);
      // The outskirts go dark first; their lines go just before them
      live.forEach((a) => {
        if (!a.seed) a.fadeOut = { at: T + 0.55 + (1 - outer(a)) * spread + rand(0, 0.2), dur: rand(0.9, 1.15) };
      });
      const vis = conns.filter((c) => !c.fade && !c.dead).sort((p, q) => p.born - q.born);
      vis.forEach((c, i) => {
        const A = amap.get(c.a), B = amap.get(c.b);
        if (!A || !B) return;
        if (A.seed && B.seed) { c.fade = { at: T + d5 - 1.3, dur: 0.9 }; return; }
        // Each line goes dark just before the first of its two agents; older lines a little sooner
        const ends = [A, B].filter((x) => x.fadeOut).map((x) => x.fadeOut.at);
        const at = Math.min.apply(null, ends) - 0.25 - (1 - i / Math.max(1, vis.length - 1)) * 0.3 - rand(0, 0.1);
        c.fade = { at: Math.max(T, at), dur: 0.8 };
        if (pairs.get(c.key) === c) pairs.delete(c.key);
      });
    }

    function endRenewal() {
      for (const a of agents) if (!a.seed) killAgent(a);
      agents = agents.filter((a) => !a.dead);
      for (const c of conns) dropConn(c);
      conns = []; pulses = []; timers = []; pendingLinks = []; spawns = [];
      pairs.clear();
      for (const a of agents) a.edges = [];
    }

    function advancePhase() {
      while (T >= phaseStart + durs[phase]) {
        if (phase === 4) {
          endRenewal();
          startCycle(false);
          return;
        }
        phaseStart += durs[phase];
        phase++;
        if (phase === 3) { nextGlow = T + rand(0.8, 1.6); nextCascade = T + rand(0.2, 0.5); }
        if (phase === 4) beginRenewal();
      }
    }

    // -------------------------------------------------------------------------------------
    // One simulation step
    // -------------------------------------------------------------------------------------
    function recount() {
      counts = plan.clusters.map(() => 0);
      clusterAvail = plan.clusters.map(() => []);
      avail = [];
      liveCount = 0;
      grid.clear();
      cell = plan.u;
      let sx = 0, sy = 0;
      for (const a of agents) {
        if (a.fadeOut || a.dead) continue;
        gridAdd(a);
        if (counts[a.cluster] !== undefined) counts[a.cluster]++;
        liveCount++; sx += a.x; sy += a.y;
        if (isAvail(a)) { avail.push(a); if (clusterAvail[a.cluster]) clusterAvail[a.cluster].push(a); }
      }
      availCount = avail.length;
      if (liveCount) { netCx = sx / liveCount; netCy = sy / liveCount; }
      spawns = spawns.filter((e) => T < e.end);
      activeSpawnCount = spawns.length;
    }

    function updateAgents(dt) {
      let anyDead = false;
      for (const a of agents) {
        if (a.dead) { anyDead = true; continue; }
        const g = a.glide;
        if (g && !g.started && T >= g.at) {            // a child leaves its parent
          const p = amap.get(g.parent);
          g.fx = p ? p.rx : a.x; g.fy = p ? p.ry : a.y;
          g.started = true; a.hidden = false;
          if (p) { addConn(p, a, 'birth'); kick(p, 0.7); }
        }
        let pr = 1;
        if (a.fadeIn) { pr *= smooth((T - a.fadeIn.at) / a.fadeIn.dur); if (T > a.fadeIn.at + a.fadeIn.dur) a.fadeIn = null; }
        if (g && g.birth) pr *= g.started ? smooth((T - g.at) / (g.dur * 0.35)) : 0;
        if (a.fadeOut) pr *= 1 - smooth((T - a.fadeOut.at) / a.fadeOut.dur);
        a.presence = pr;

        let x = a.x, y = a.y;
        if (g && g.started) {
          const k = (T - g.at) / g.dur, e = glideEase(k);
          x = lerp(g.fx, a.x, e); y = lerp(g.fy, a.y, e);
          if (k >= 1) { a.glide = null; if (g.birth) { a.landed = T; kick(a, 0.35); } }
        } else if (g) {
          const p = amap.get(g.parent);
          if (p) { x = p.rx; y = p.ry; }
        }
        const dw = frozen ? 0 : a.driftStart == null ? 1 : smooth((T - a.driftStart) / 1.6);
        if (dw > 0) {
          x += a.amp * dw * (0.62 * Math.sin(a.w1 * MT + a.p1) + 0.38 * Math.sin(a.w2 * MT + a.p2));
          y += a.amp * dw * (0.62 * Math.sin(a.w1 * 0.83 * MT + a.p3) + 0.38 * Math.sin(a.w2 * 1.17 * MT + a.p4));
        }
        a.rx = x; a.ry = y;
        a.actT *= Math.exp(-dt / 0.85);
        a.act += (a.actT - a.act) * (1 - Math.exp(-dt / (a.actT > a.act ? 0.11 : 0.3)));
        const sizeT = clamp(0.72 + 0.24 * Math.sqrt(a.traffic), 0.72, 3.4);   // agents swell with traffic
        a.size += (sizeT - a.size) * (1 - Math.exp(-dt / 0.45));
        if (a.fadeOut && T > a.fadeOut.at + a.fadeOut.dur) { killAgent(a); anyDead = true; }
      }
      if (anyDead) agents = agents.filter((a) => !a.dead);
    }

    function checkSpawns() {
      if (!spawnAllowed()) return;
      const maxC = maxConcurrent();
      for (const a of agents) {
        if (activeSpawnCount >= maxC) return;
        if (a.spawned || a.incoming < P.spawnThreshold || T < a.eligibleAt || T < a.nextTry || !isAvail(a)) continue;
        const sp = planSpawn(a);
        if (sp) triggerSpawn(a, sp); else a.nextTry = T + 0.6;
      }
    }

    function updateConns(dt) {
      let anyDead = false;
      const wDecay = Math.exp(-dt / 45), wEase = 1 - Math.exp(-dt / 0.5), aDecay = Math.exp(-dt / 1.1);
      for (const c of conns) {
        if (c.dead) { anyDead = true; continue; }
        const A = amap.get(c.a), B = amap.get(c.b);
        if (!A || !B) { dropConn(c); anyDead = true; continue; }
        if (!c.done) {
          if (c.kind === 'link') {
            c.progress = (T - c.born) / c.drawDur;
            if (c.progress >= 1) {
              c.progress = 1; c.done = true; c.lastUsed = T; c.act = Math.max(c.act, 0.7);
              B.pendingIn = Math.max(0, B.pendingIn - 1);
              if (!B.fadeOut) B.incoming++;            // completed incoming links count; birth links do not
              B.traffic += 1;
              kick(B, 0.8);
            }
          } else if (!B.glide) { c.done = true; c.lastUsed = T; B.traffic += 0.5; }
        }
        c.act *= aDecay;
        c.weight = 1 + (c.weight - 1) * wDecay;
        c.wDisp += (c.weight - c.wDisp) * wEase;
        if (c.fade) {
          const k = (T - c.fade.at) / c.fade.dur;
          c.alpha = 1 - smooth(k);
          if (k >= 1) { dropConn(c); anyDead = true; }
        }
      }
      if (anyDead) conns = conns.filter((c) => !c.dead);
    }

    function updatePulses() {
      let anyDone = false;
      for (const p of pulses) {
        if (p.c.dead) {
          p.done = anyDone = true;
          if (p.kind === 'link') { const o = amap.get(p.to); if (o) o.pendingIn = Math.max(0, o.pendingIn - 1); }
          continue;
        }
        const k = (T - p.start) / p.dur;
        p.c.act = Math.max(p.c.act, 0.5 * smooth(k * 4));
        if (k < 1) continue;
        p.done = anyDone = true;
        const o = amap.get(p.to);
        if (!o) continue;
        p.c.lastUsed = T;
        if (p.kind === 'link') {                      // a repeated link arrives: it counts, and the road thickens
          o.pendingIn = Math.max(0, o.pendingIn - 1);
          if (!o.fadeOut) o.incoming++;
          o.traffic += 1;
          p.c.weight += 1;
          p.c.act = Math.max(p.c.act, 0.8);
          kick(o, 0.8);
        } else {
          o.traffic += 0.12;
          p.c.weight += p.kind === 'cascade' ? 0.3 : 0.12;
          if (p.kind === 'relay') {
            kick(o, 0.8);
            if (p.hops > 0 && phase !== 4 && rng() < 0.85) {
              const from = p.from, to = p.to, hops = p.hops;
              later(rand(0.12, 0.3), () => startRelay(amap.get(to), hops, from));
            }
          } else {
            const cas = p.cascade, depth = p.depth + 1, from = p.from, to = p.to;
            later(rand(0.05, 0.14), () => emitCascade(cas, amap.get(to), depth, from));
          }
        }
      }
      if (anyDone) pulses = pulses.filter((p) => !p.done);
    }

    function runTimers() {
      if (!timers.length) return;
      const due = timers.filter((t) => t.at <= T);
      if (!due.length) return;
      timers = timers.filter((t) => t.at > T);
      due.forEach((t) => t.fn());
    }

    function schedule() {
      if (phase < 1 || phase > 3) return;
      for (let guard = 0; T >= nextBurst && guard < 10; guard++) {
        const focus = chooseFocus();
        const max = phase === 3 ? Math.min(2, P.burstMax) : P.burstMax;
        let n = randi(Math.min(P.burstMin, max), max);
        const growth = phase <= 2 && isBehind() && activeSpawnCount < maxConcurrent() && rng() < (targetCount(T + 1.2) - liveCount > 6 ? 0.88 : 0.72);
        const target = growth ? pickGrowthTarget(focus) : 0;
        if (target) {
          const t = amap.get(target);
          n = clamp(P.spawnThreshold - t.incoming - t.pendingIn, 1, Math.max(max, P.spawnThreshold));
        }
        let at = T;
        for (let i = 0; i < n; i++) { pendingLinks.push({ at, focus, target }); at += rand(0.12, 0.28); }
        nextBurst = Math.max(nextBurst + burstInterval(), T - 0.5);
      }
      let relays = 0;
      for (const p of pulses) if (p.kind === 'relay') relays++;
      for (let guard = 0; T >= nextSignal && guard < 4; guard++) {
        if (relays < 2 + availCount / 80 && availCount) { startRelay(pick(avail), phase === 3 ? randi(2, 3) : randi(1, 2), 0); relays++; }
        nextSignal += (phase === 3 ? rand(0.8, 1.6) : rand(1.2, 2.4)) / (1 + availCount / 120);
      }
      if (phase === 2 && nextCascade === Infinity && availCount > 40) nextCascade = T + rand(1, 2);
      for (let guard = 0; T >= nextCascade && guard < 3; guard++) {
        if (pulses.length < 140) startCascade();
        nextCascade += phase === 3 ? rand(0.45, 0.9) : rand(1.6, 3.2);
      }
      if (phase === 3 && T >= nextGlow) { glow(); nextGlow = T + rand(1.4, 2.8); }
    }

    function processPendingLinks() {
      if (!pendingLinks.length) return;
      const due = pendingLinks.filter((p) => p.at <= T);
      if (!due.length) return;
      pendingLinks = pendingLinks.filter((p) => p.at > T);
      due.forEach((p) => createLink(p.focus, p.target));
    }

    // Lines persist. Past the limit, thin idle old lines fade slowly; roads stay.
    function prune() {
      if (T < nextPrune || phase === 4) return;
      nextPrune = T + 0.25;
      let vis = 0;
      for (const c of conns) if (!c.fade && !c.dead) vis++;
      const limit = Math.round(P.linesPerAgent * availCount) + 3;
      if (vis <= limit) return;
      const liveDeg = (id) => { const a = amap.get(id); let n = 0; if (a) for (const c of a.edges) if (!c.fade) n++; return n; };
      const cands = [];
      for (const c of conns) {
        if (c.fade || c.dead || !c.done || T - c.lastUsed < 3) continue;
        const A = amap.get(c.a), B = amap.get(c.b);
        if (!A || !B) continue;
        const span = dist(A.x, A.y, B.x, B.y) / plan.u;
        const flight = c.kind === 'birth' && span > 2.5 ? 30 : 0;     // a pioneer's long birth line
        cands.push([c.born + 12 * (c.weight - 1) - 1.2 * span - flight, c]);
      }
      cands.sort((p, q) => p[0] - q[0]);
      let n = Math.min(40, Math.ceil((vis - limit) / 3));
      for (const [, c] of cands) {
        if (n <= 0) break;
        if (liveDeg(c.a) < 2 || liveDeg(c.b) < 2) continue;
        fadeConn(c, 4);
        n--;
      }
    }

    // The framing follows the network's planned extent on slow springs: it starts close on the
    // first agents and pulls back as the city grows.
    function cameraTarget() {
      const zMax = plan ? plan.zMax : 1.45;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
      for (const a of agents) {
        if (a.dead || (a.fadeOut && a.presence < 0.45)) continue;
        if (a.x < x0) x0 = a.x; if (a.x > x1) x1 = a.x;
        if (a.y < y0) y0 = a.y; if (a.y > y1) y1 = a.y;
        any = true;
      }
      if (!any || !W || !H || !plan) return { x: 0, y: 0, z: zMax };
      const m = 0.8 * plan.u;
      x0 -= m; y0 -= m; x1 += m; y1 += m;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const hw = Math.max(x1 - cx, cx - x0), hh = Math.max(y1 - cy, cy - y0);
      const z = clamp(Math.min(((W / 2) * 0.86) / hw, ((H / 2) * 0.86) / hh), 0.35, zMax);
      return { x: cx, y: cy, z };
    }
    function snapCamera() {
      const t = cameraTarget();
      cam.x.x = t.x; cam.y.x = t.y; cam.lz.x = Math.log(t.z);
      cam.x.v = cam.y.v = cam.lz.v = 0;
    }
    function updateCamera(dt) {
      const t = cameraTarget();
      spring(cam.x, t.x, 0.8, dt);
      spring(cam.y, t.y, 0.8, dt);
      spring(cam.lz, Math.log(t.z), 0.85, dt);
    }

    function update(dt) {
      T += dt;
      MT += dt * P.speed;
      advancePhase();
      recount();
      updateAgents(dt);
      recount();
      checkSpawns();
      updateConns(dt);
      updatePulses();
      runTimers();
      schedule();
      processPendingLinks();
      prune();
      updateCamera(dt);
    }

    // -------------------------------------------------------------------------------------
    // Drawing. Lines and dots are grouped by width and opacity so a city of hundreds of
    // agents is drawn in a few dozen strokes.
    // -------------------------------------------------------------------------------------
    function geom(c, A, B) {
      const x0 = A.sx, y0 = A.sy, x2 = B.sx, y2 = B.sy;
      const dx = x2 - x0, dy = y2 - y0, mx = (x0 + x2) / 2, my = (y0 + y2) / 2, k = c.bend;
      return [x0, y0, mx - dy * k, my + dx * k, x2, y2];
    }
    function pathSub(g, a, b) {
      if (b - a < 0.002) return;
      ctx.moveTo(bez(g[0], g[2], g[4], a), bez(g[1], g[3], g[5], a));
      ctx.quadraticCurveTo(blossom(g[0], g[2], g[4], a, b), blossom(g[1], g[3], g[5], a, b), bez(g[0], g[2], g[4], b), bez(g[1], g[3], g[5], b));
    }

    function render() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!W || !H || !plan) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const z = Math.exp(cam.lz.x), ox = W / 2 - cam.x.x * z, oy = H / 2 - cam.y.x * z;
      const zs = clamp(0.72 + 0.28 * Math.sqrt(z), 0.9, 1.6);              // larger when the camera is close
      sc = clamp(Math.sqrt((W * H) / (1000 * 560)), 0.78, 1.15);
      lw = 0.5 * Math.max(0.85, sc) * zs;
      const r0 = 1.05 * P.dotSize * sc * zs;
      for (const a of agents) { a.sx = ox + a.rx * z; a.sy = oy + a.ry * z; }

      ctx.lineCap = 'round';
      ctx.strokeStyle = rgbStr;
      ctx.fillStyle = rgbStr;

      // Lines, grouped
      const buckets = new Map(), tips = [];
      for (const c of conns) {
        if (c.dead) continue;
        const A = amap.get(c.a), B = amap.get(c.b);
        if (!A || !B || B.hidden) continue;
        const pres = Math.min(A.presence, B.presence) * c.alpha;
        const thick = Math.log2(Math.max(1, c.wDisp));
        let al = P.lineOpacity * pres * (1 + 0.5 * thick) * (1 + 1.2 * c.act);
        if (frozen) al *= 0.72 + 0.28 * Math.sin((TAU * Tr) / c.breathP + c.breathPh);
        if (al < 0.006) continue;
        const width = Math.min(lw * (1 + 1.1 * thick), lw * 5);
        const g = geom(c, A, B);
        let t1 = 1;
        if (c.kind === 'link' && !c.done) { t1 = easeInOut(c.progress); tips.push([g, t1, 1, pres]); }
        const key = Math.round(width * 10) * 128 + Math.min(127, Math.round(Math.min(al, 0.7) / 0.012));
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push(g, t1);
      }
      buckets.forEach((list, key) => {
        ctx.lineWidth = Math.floor(key / 128) / 10;
        ctx.globalAlpha = (key % 128) * 0.012;
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 2) pathSub(list[i], 0, list[i + 1]);
        ctx.stroke();
      });

      // Signals: drawing tips, repeated links, relays and cascades
      const pi = P.pulseIntensity;
      if (pi > 0 && !frozen) {
        for (const p of pulses) {
          const A = amap.get(p.c.a), B = amap.get(p.c.b);
          if (!A || !B || p.c.dead) continue;
          const k = easeInOut((T - p.start) / p.dur);
          tips.push([geom(p.c, A, B), p.dir > 0 ? k : 1 - k, p.dir, Math.min(A.presence, B.presence) * p.c.alpha]);
        }
        const tail = 0.16, heads = [];
        ctx.lineWidth = lw * 1.3;
        ctx.globalAlpha = Math.min(0.5, 0.26 * pi);
        ctx.beginPath();
        for (const [g, t, dir, pr] of tips) {
          if (pr < 0.2) continue;
          const a = dir > 0 ? clamp(t - tail, 0, 1) : t, b = dir > 0 ? t : clamp(t + tail, 0, 1);
          pathSub(g, a, b);
          heads.push(bez(g[0], g[2], g[4], t), bez(g[1], g[3], g[5], t), pr);
        }
        ctx.stroke();
        const hr = 4.2 * sc;
        for (let i = 0; i < heads.length; i += 3) {
          ctx.globalAlpha = Math.min(0.3, 0.12 * pi * heads[i + 2]);
          ctx.drawImage(sprite, heads[i] - hr, heads[i + 1] - hr, hr * 2, hr * 2);
        }
        ctx.globalAlpha = Math.min(0.9, 0.7 * pi);
        ctx.beginPath();
        for (let i = 0; i < heads.length; i += 3) { ctx.moveTo(heads[i] + 1.05 * sc, heads[i + 1]); ctx.arc(heads[i], heads[i + 1], 1.05 * sc, 0, TAU); }
        ctx.fill();
      }

      // Agents: halos for the busy and the active, then cores grouped by opacity
      const cores = new Map();
      for (const a of agents) {
        if (a.dead || a.hidden || a.presence < 0.004) continue;
        let pr = a.presence;
        if (frozen) pr *= 0.8 + 0.2 * Math.sin((TAU * Tr) / a.bp + a.p1);
        const act = a.act, g = a.glide, hub = clamp((a.size - 1) / 2, 0, 1);
        const grow = g && g.birth ? 0.45 + 0.55 * smooth((T - g.at) / (g.dur * 0.5)) : 1;
        const r = r0 * a.size * (1 + 0.3 * act) * grow;
        const ha = pr * (0.03 + 0.07 * hub + 0.17 * act);
        if (ha > 0.012) {
          const hr = r * (3 + 2.4 * act) + 2 * hub * sc;
          ctx.globalAlpha = ha;
          ctx.drawImage(sprite, a.sx - hr, a.sy - hr, hr * 2, hr * 2);
        }
        const ca = Math.min(1, pr * (0.62 + 0.25 * hub + 0.2 * act));
        const key = Math.round(ca * 20);
        let l = cores.get(key);
        if (!l) { l = []; cores.set(key, l); }
        l.push(a.sx, a.sy, r);
      }
      cores.forEach((l, key) => {
        ctx.globalAlpha = key / 20;
        ctx.beginPath();
        for (let i = 0; i < l.length; i += 3) { ctx.moveTo(l[i] + l[i + 2], l[i + 1]); ctx.arc(l[i], l[i + 1], l[i + 2], 0, TAU); }
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    // -------------------------------------------------------------------------------------
    // Modes, sizing, the loop
    // -------------------------------------------------------------------------------------
    function resetState() {
      agents = []; conns = []; pulses = []; spawns = []; pendingLinks = []; timers = []; avail = [];
      amap.clear(); pairs.clear(); grid.clear();
      T = 0; MT = 0; cycle = 0; phase = 0; frozen = false; Tr = 0;
      nextPrune = 0; nextBurst = nextSignal = nextCascade = nextGlow = Infinity; lastFocus = -1;
      liveCount = availCount = activeSpawnCount = 0;
    }

    // Reduced motion: the city is grown off-screen in small slices, then held still with
    // gentle opacity changes.
    function buildStatic() {
      resetState();
      startCycle(true);
      const token = ++building;
      const end = durs[0] + durs[1] + durs[2] + durs[3] * 0.85, dt = 1 / 15;
      const slice = () => {
        if (token !== building || destroyed) return;
        for (let i = 0; i < 40 && T < end; i++) update(dt);
        if (T < end) { setTimeout(slice, 0); return; }
        for (const a of agents) if (a.hidden || a.fadeOut) killAgent(a);
        agents = agents.filter((a) => !a.dead);
        for (const a of agents) { a.glide = null; a.fadeIn = null; a.presence = 1; a.act = a.actT = 0; a.rx = a.x; a.ry = a.y; }
        for (const c of conns) if (c.fade) dropConn(c);
        conns = conns.filter((c) => !c.dead);
        for (const c of conns) { c.done = true; c.progress = 1; c.act = 0; c.alpha = 1; c.wDisp = c.weight; }
        pulses = []; timers = []; pendingLinks = []; spawns = [];
        frozen = true;
        snapCamera();
        render();
      };
      slice();
    }

    const mq = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const wantReduced = () => P.reducedMotion === true || (P.reducedMotion === 'auto' && !!(mq && mq.matches));
    function applyMode() {
      reduced = wantReduced();
      building++;
      if (reduced) buildStatic(); else { resetState(); startCycle(true); }
      render();
      wake();
    }
    const onMotionPref = () => { if (P.reducedMotion === 'auto') applyMode(); };
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', onMotionPref); else if (mq.addListener) mq.addListener(onMotionPref); }

    function resize() {
      const r = canvas.getBoundingClientRect();
      const nd = Math.min(global.devicePixelRatio || 1, P.maxDpr);
      if (r.width === W && r.height === H && nd === dpr) return;
      W = r.width; H = r.height; dpr = nd;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      if (!started && W > 0 && H > 0) { started = true; applyMode(); return; }
      if (frozen) snapCamera();
      render();
      wake();
    }

    const shouldRun = () => started && visible && !document.hidden && !manualPause && !destroyed && W > 0 && H > 0;
    function frame(now) {
      raf = 0;
      if (!shouldRun()) { last = 0; return; }
      const dt = last ? Math.min((now - last) / 1000, 0.25) : 0;
      last = now;
      if (reduced) {
        Tr += dt; rAcc += dt;
        if (frozen && rAcc >= 1 / 12) { rAcc = 0; render(); }
      } else {
        let rem = dt;
        while (rem > 1e-6) { const s = Math.min(rem, 1 / 30); update(s); rem -= s; }
        render();
      }
      raf = requestAnimationFrame(frame);
    }
    function wake() { if (!raf && shouldRun()) { last = 0; raf = requestAnimationFrame(frame); } }
    const onVisibility = () => { if (document.hidden) last = 0; wake(); };

    let ro = null, io = null;
    if (global.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(canvas); }
    else global.addEventListener('resize', resize);
    if (global.IntersectionObserver) {
      io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; wake(); }, { rootMargin: '64px' });
      io.observe(canvas);
    }
    document.addEventListener('visibilitychange', onVisibility);
    resize();

    const api = {
      get params() { return mergeParams(P, P); },
      set(o) {
        o = o || {};
        const prevColor = P.color, prevRM = P.reducedMotion;
        Object.keys(o).forEach((k) => { if (k !== 'phases') P[k] = o[k]; });
        if (o.phases) P.phases = Object.assign({}, P.phases, o.phases);
        if (P.color !== prevColor) applyColor();
        if (P.reducedMotion !== prevRM && started) applyMode();
        else if (frozen) render();
        return api;
      },
      restart() {
        if (P.seed != null) rng = mulberry32(P.seed);
        if (started) applyMode();
        return api;
      },
      pause() { manualPause = true; return api; },
      resume() { manualPause = false; wake(); return api; },
      get paused() { return manualPause; },
      // Advance by a fixed step and draw: for tests and screenshots.
      step(seconds, fps) {
        const dt = 1 / (fps || 60);
        if (reduced) { Tr += seconds; render(); return api; }
        for (let t = 0; t < seconds - 1e-9; t += dt) update(dt);
        render();
        return api;
      },
      stats() {
        let vis = 0, shown = 0, cross = 0, span = 0, x0 = Infinity, x1 = -Infinity, maxSize = 0, hubs = 0, roads = 0;
        for (const a of agents) {
          if (a.dead) continue;
          if (!a.fadeOut) { x0 = Math.min(x0, a.x); x1 = Math.max(x1, a.x); }
          if (!a.hidden && a.presence > 0.05) { shown++; maxSize = Math.max(maxSize, a.size); if (a.size > 1.8) hubs++; }
        }
        for (const c of conns) {
          if (c.dead || c.alpha <= 0.05) continue;
          vis++;
          if (c.wDisp >= 3) roads++;
          const A = amap.get(c.a), B = amap.get(c.b);
          if (A && B) { if (A.cluster !== B.cluster) cross++; span += dist(A.x, A.y, B.x, B.y); }
        }
        return {
          cycle, phase: PHASES[phase], phaseElapsed: +(T - phaseStart).toFixed(2), phaseDuration: +durs[phase].toFixed(2),
          time: +T.toFixed(2), agents: shown, maxAgents: plan ? plan.cap : 0, clusters: plan ? plan.clusters.length : 0,
          connections: vis, spawning: activeSpawnCount, signals: pulses.length, hubs, roads, maxSize: +maxSize.toFixed(2),
          reducedMotion: reduced, building: reduced && !frozen,
          crossShare: vis ? +(cross / vis).toFixed(2) : 0, meanSpan: vis && x1 > x0 ? +(span / vis / (x1 - x0)).toFixed(2) : 0
        };
      },
      destroy() {
        destroyed = true;
        building++;
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
        if (io) io.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        if (mq) { if (mq.removeEventListener) mq.removeEventListener('change', onMotionPref); else if (mq.removeListener) mq.removeListener(onMotionPref); }
        if (owned && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
    return api;
  }

  global.AgentNetwork = { mount: create, defaults: DEFAULTS, phases: PHASES.slice() };
})(typeof window !== 'undefined' ? window : this);
