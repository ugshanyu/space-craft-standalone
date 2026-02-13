/**
 * Space Craft - Authoritative 2P shooter simulation.
 * Deterministic, fixed-step physics.
 */

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const TAU = Math.PI * 2;

export const CONFIG = {
  arenaWidth: 100,
  arenaHeight: 100,

  turnRate: 3.8,
  accelForward: 55,
  accelReverse: 28,
  linearDragPerSecond: 0.18,
  maxSpeed: 32,

  projectileSpeed: 60,
  projectileTtlMs: 1100,
  projectileDamage: 20,
  fireCooldownMs: 180,

  maxHp: 100,
  maxShield: 60,
  shieldRegenPerSecond: 8,

  pickupSpawnEveryTicks: 90,
  maxPickups: 2,

  playerRadius: 1.5,
  projectileRadius: 0.45,
  pickupRadius: 2.2,

  roundDurationMs: 180000,
};

export function initState(playerIds, seed) {
  const spawns = [
    { x: 18, y: 50, angle: 0 },
    { x: 82, y: 50, angle: Math.PI },
  ];

  const players = {};
  for (let i = 0; i < Math.min(playerIds.length, 2); i++) {
    const id = playerIds[i];
    const s = spawns[i];
    players[id] = {
      id,
      x: s.x,
      y: s.y,
      vx: 0,
      vy: 0,
      angle: s.angle,
      hp: CONFIG.maxHp,
      shield: CONFIG.maxShield,
      weaponLevel: 1,
      fireCooldownMs: 0,
      alive: true,
      input: { turn: 0, thrust: 0, fire: false },
      stats: {
        kills: 0,
        deaths: 0,
        damageDealt: 0,
        pickups: 0,
      },
    };
  }

  return {
    phase: 'playing',
    seed: Number(seed || 1),
    tick: 0,
    remainingMs: CONFIG.roundDurationMs,
    arena: {
      width: CONFIG.arenaWidth,
      height: CONFIG.arenaHeight,
    },
    players,
    projectiles: [],
    pickups: [],
    winnerIds: [],
    reason: null,
  };
}

export function applyInput(state, playerId, payload) {
  const p = state.players[playerId];
  if (!p || !p.alive) return;
  p.input = {
    turn: clamp(Number(payload?.turn || 0), -1, 1),
    thrust: clamp(Number(payload?.thrust || 0), -1, 1),
    fire: Boolean(payload?.fire),
  };
}

export function tick(state, dtMs) {
  if (state.phase !== 'playing') return state;

  const dt = dtMs / 1000;
  state.tick += 1;
  state.remainingMs = Math.max(0, state.remainingMs - dtMs);

  for (const [pid, p] of Object.entries(state.players)) {
    if (!p.alive) continue;

    p.angle = normalizeAngle(p.angle + p.input.turn * CONFIG.turnRate * dt);

    const thrust = p.input.thrust;
    if (thrust !== 0) {
      const accel = thrust > 0 ? CONFIG.accelForward : CONFIG.accelReverse;
      const dirX = Math.cos(p.angle);
      const dirY = Math.sin(p.angle);
      p.vx += dirX * accel * thrust * dt;
      p.vy += dirY * accel * thrust * dt;
    }

    const drag = Math.exp(-CONFIG.linearDragPerSecond * dt);
    p.vx *= drag;
    p.vy *= drag;

    const speed = Math.hypot(p.vx, p.vy);
    if (speed > CONFIG.maxSpeed) {
      const s = CONFIG.maxSpeed / speed;
      p.vx *= s;
      p.vy *= s;
    }

    p.x = wrap(p.x + p.vx * dt, state.arena.width);
    p.y = wrap(p.y + p.vy * dt, state.arena.height);

    p.fireCooldownMs = Math.max(0, p.fireCooldownMs - dtMs);
    p.shield = Math.min(CONFIG.maxShield, p.shield + CONFIG.shieldRegenPerSecond * dt);

    if (p.input.fire && p.fireCooldownMs <= 0) {
      spawnProjectile(state, pid, p);
      p.fireCooldownMs = CONFIG.fireCooldownMs;
    }
  }

  updateProjectiles(state, dtMs);
  spawnPickups(state);
  collectPickups(state);
  resolveTerminal(state);
  return state;
}

export function isTerminal(state) {
  if (state.phase !== 'finished') return { terminal: false };
  return {
    terminal: true,
    winnerIds: state.winnerIds,
    reason: state.reason,
    finalTick: state.tick,
    remainingMs: state.remainingMs,
  };
}

function spawnProjectile(state, ownerId, p) {
  const muzzle = 2.0;
  state.projectiles.push({
    id: `${state.tick}:${ownerId}:${Math.random().toString(36).slice(2, 7)}`,
    ownerId,
    x: wrap(p.x + Math.cos(p.angle) * muzzle, state.arena.width),
    y: wrap(p.y + Math.sin(p.angle) * muzzle, state.arena.height),
    vx: Math.cos(p.angle) * CONFIG.projectileSpeed,
    vy: Math.sin(p.angle) * CONFIG.projectileSpeed,
    ttlMs: CONFIG.projectileTtlMs,
    damage: CONFIG.projectileDamage + (p.weaponLevel - 1) * 3,
  });
}

function updateProjectiles(state, dtMs) {
  const dt = dtMs / 1000;
  const kept = [];

  for (const pr of state.projectiles) {
    pr.ttlMs -= dtMs;
    if (pr.ttlMs <= 0) continue;

    pr.x = wrap(pr.x + pr.vx * dt, state.arena.width);
    pr.y = wrap(pr.y + pr.vy * dt, state.arena.height);

    let hit = null;
    for (const [pid, p] of Object.entries(state.players)) {
      if (!p.alive || pid === pr.ownerId) continue;
      if (torusDistSq(pr.x, pr.y, p.x, p.y, state.arena.width, state.arena.height) <= Math.pow(CONFIG.playerRadius + CONFIG.projectileRadius, 2)) {
        hit = pid;
        break;
      }
    }

    if (!hit) {
      kept.push(pr);
      continue;
    }

    const target = state.players[hit];
    const owner = state.players[pr.ownerId];

    const absorbed = Math.min(target.shield, pr.damage);
    target.shield -= absorbed;
    const hpDamage = pr.damage - absorbed;
    if (hpDamage > 0) target.hp = Math.max(0, target.hp - hpDamage);

    if (owner) owner.stats.damageDealt += pr.damage;

    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      target.stats.deaths += 1;
      if (owner) owner.stats.kills += 1;
    }
  }

  state.projectiles = kept;
}

function spawnPickups(state) {
  if (state.tick % CONFIG.pickupSpawnEveryTicks !== 0) return;
  if (state.pickups.length >= CONFIG.maxPickups) return;

  const r1 = pseudoRandom(state.seed + state.tick * 7919);
  const r2 = pseudoRandom(state.seed + state.tick * 1543);
  state.pickups.push({
    id: `pu:${state.tick}:${state.pickups.length}`,
    x: 12 + r1 * 76,
    y: 12 + r2 * 76,
    type: 'weapon_boost',
    value: 1,
  });
}

function collectPickups(state) {
  const rest = [];
  for (const pickup of state.pickups) {
    let collectorId = null;
    for (const [pid, p] of Object.entries(state.players)) {
      if (!p.alive) continue;
      if (torusDistSq(pickup.x, pickup.y, p.x, p.y, state.arena.width, state.arena.height) <= CONFIG.pickupRadius * CONFIG.pickupRadius) {
        collectorId = pid;
        break;
      }
    }

    if (!collectorId) {
      rest.push(pickup);
      continue;
    }

    const collector = state.players[collectorId];
    collector.weaponLevel = clamp(collector.weaponLevel + pickup.value, 1, 5);
    collector.stats.pickups += 1;
  }

  state.pickups = rest;
}

function resolveTerminal(state) {
  const alive = Object.entries(state.players)
    .filter(([, p]) => p.alive)
    .map(([pid]) => pid);

  if (alive.length <= 1) {
    state.phase = 'finished';
    state.winnerIds = alive;
    state.reason = 'elimination';
    return;
  }

  if (state.remainingMs <= 0) {
    const ranked = Object.entries(state.players)
      .map(([pid, p]) => ({ pid, score: p.hp + p.shield * 0.4 }))
      .sort((a, b) => b.score - a.score);

    const top = ranked[0]?.score ?? 0;
    state.winnerIds = ranked.filter((r) => Math.abs(r.score - top) < 0.0001).map((r) => r.pid);
    state.phase = 'finished';
    state.reason = 'timeout';
  }
}

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function wrap(v, max) {
  let n = v % max;
  if (n < 0) n += max;
  return n;
}

function normalizeAngle(a) {
  let n = a % TAU;
  if (n < 0) n += TAU;
  return n;
}

function torusDistSq(ax, ay, bx, by, w, h) {
  let dx = Math.abs(ax - bx);
  let dy = Math.abs(ay - by);
  if (dx > w / 2) dx = w - dx;
  if (dy > h / 2) dy = h - dy;
  return dx * dx + dy * dy;
}
