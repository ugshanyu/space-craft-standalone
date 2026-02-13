/**
 * Space Craft Game Logic - Clean & Deterministic
 */

const _round = (v) => Math.round(v * 10000) / 10000;

export const CONFIG = {
  arenaWidth: 100.0,
  arenaHeight: 100.0,
  
  // Movement
  accel: 60.0,         // Pixels per second squared
  drag: 0.94,          // Velocity multiplier per second
  turnRate: 5.5,       // Radians per second
  maxSpeed: 35.0,
  
  // Weapons
  projectileSpeed: 55.0,
  projectileTtlMs: 1500,
  projectileDamage: 18,
  fireCooldownMs: 250,
  
  // Vitality
  maxHp: 100,
  maxShield: 60,
  shieldRegenPerTick: 0.3,
  
  roundDurationMs: 120000,
  pickupSpawnEveryTicks: 40,
  maxPickups: 3,
};

export function initState(playerIds, seed) {
  const spawnPoints = [
    [20.0, 50.0, 0.0],
    [80.0, 50.0, Math.PI],
  ];
  const players = {};
  for (let i = 0; i < Math.min(playerIds.length, 2); i++) {
    const pid = playerIds[i];
    const [x, y, angle] = spawnPoints[i];
    players[pid] = {
      id: pid,
      x, y,
      vx: 0.0, vy: 0.0,
      angle,
      hp: CONFIG.maxHp,
      shield: CONFIG.maxShield,
      alive: true,
      weaponLevel: 1,
      fireCooldownMs: 0,
      stats: { kills: 0, deaths: 0, damageDealt: 0, pickups: 0 },
    };
  }
  return {
    phase: 'playing',
    tick: 0,
    seed,
    remainingMs: CONFIG.roundDurationMs,
    arena: { width: CONFIG.arenaWidth, height: CONFIG.arenaHeight },
    players,
    projectiles: [],
    pickups: [],
    winnerIds: [],
    reason: null,
  };
}

export function applyInput(state, playerId, payload) {
  const player = state.players[playerId];
  if (!player || !player.alive) return;
  player.pendingTurn = Math.max(-1, Math.min(1, Number(payload.turn || 0)));
  player.pendingThrust = Math.max(0, Math.min(1, Number(payload.thrust || 0)));
  player.pendingFire = Boolean(payload.fire);
}

export function tick(state, dtMs) {
  const dt = dtMs / 1000.0;
  state.tick++;
  state.remainingMs = Math.max(0, state.remainingMs - dtMs);
  
  const W = state.arena.width;
  const H = state.arena.height;

  for (const [pid, p] of Object.entries(state.players)) {
    if (!p.alive) continue;

    const turn = p.pendingTurn || 0;
    const thrust = p.pendingThrust || 0;
    const fire = p.pendingFire || false;

    // 1. Snappy Rotation
    p.angle += turn * CONFIG.turnRate * dt;

    // 2. Standard Acceleration
    if (thrust > 0) {
      p.vx += Math.cos(p.angle) * CONFIG.accel * thrust * dt;
      p.vy += Math.sin(p.angle) * CONFIG.accel * thrust * dt;
    }

    // 3. Friction/Drag (Framerate independent)
    const dragFactor = Math.pow(CONFIG.drag, dt);
    p.vx *= dragFactor;
    p.vy *= dragFactor;

    // 4. Speed Cap
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > CONFIG.maxSpeed) {
      const ratio = CONFIG.maxSpeed / speed;
      p.vx *= ratio;
      p.vy *= ratio;
    }

    // 5. Move & Wrap
    p.x = ((p.x + p.vx * dt) % W + W) % W;
    p.y = ((p.y + p.vy * dt) % H + H) % H;

    p.fireCooldownMs = Math.max(0, p.fireCooldownMs - dtMs);
    p.shield = Math.min(CONFIG.maxShield, _round(p.shield + CONFIG.shieldRegenPerTick));

    if (fire && p.fireCooldownMs === 0) {
      state.projectiles.push({
        id: `${state.tick}-${pid}`,
        ownerId: pid,
        x: p.x, y: p.y,
        vx: _round(Math.cos(p.angle) * CONFIG.projectileSpeed),
        vy: _round(Math.sin(p.angle) * CONFIG.projectileSpeed),
        ttlMs: CONFIG.projectileTtlMs,
        damage: CONFIG.projectileDamage + 2 * (p.weaponLevel - 1),
      });
      p.fireCooldownMs = CONFIG.fireCooldownMs;
    }
  }

  advanceProjectiles(state, dtMs);
  spawnPickupsIfNeeded(state);
  collectPickups(state);
  resolveTerminal(state);
  return state;
}

function advanceProjectiles(state, dtMs) {
  const { width: W, height: H } = state.arena;
  const kept = [];
  const dt = dtMs / 1000.0;

  for (const proj of state.projectiles) {
    proj.ttlMs -= dtMs;
    if (proj.ttlMs <= 0) continue;

    proj.x = _round(((proj.x + proj.vx * dt) % W + W) % W);
    proj.y = _round(((proj.y + proj.vy * dt) % H + H) % H);

    let hitPlayerId = null;
    for (const [pid, p] of Object.entries(state.players)) {
      if (pid === proj.ownerId || !p.alive) continue;
      if (distSq(proj.x, proj.y, p.x, p.y) <= 5.0) {
        hitPlayerId = pid;
        break;
      }
    }

    if (!hitPlayerId) {
      kept.push(proj);
      continue;
    }

    const target = state.players[hitPlayerId];
    const owner = state.players[proj.ownerId];
    const damage = proj.damage;
    const absorbed = Math.min(target.shield, damage);
    target.shield = _round(target.shield - absorbed);
    const hpDamage = damage - absorbed;
    if (hpDamage > 0) target.hp = Math.max(0, target.hp - hpDamage);
    if (owner) owner.stats.damageDealt += damage;
    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      target.stats.deaths++;
      if (owner) owner.stats.kills++;
    }
  }
  state.projectiles = kept;
}

function spawnPickupsIfNeeded(state) {
  if (state.phase !== 'playing') return;
  if (state.tick % CONFIG.pickupSpawnEveryTicks !== 0) return;
  if (state.pickups.length >= CONFIG.maxPickups) return;
  const rng = (s) => (s * 9301 + 49297) % 233280;
  let seed = state.tick + (state.seed || 0);
  const nextRnd = () => { seed = rng(seed); return seed / 233280; };
  
  state.pickups.push({
    id: `pickup-${state.tick}-${state.pickups.length}`,
    x: _round(10 + nextRnd() * (CONFIG.arenaWidth - 20)),
    y: _round(10 + nextRnd() * (CONFIG.arenaHeight - 20)),
    type: 'weapon_boost',
    value: 1,
  });
}

function collectPickups(state) {
  const remaining = [];
  for (const pickup of state.pickups) {
    let collectedBy = null;
    for (const [pid, p] of Object.entries(state.players)) {
      if (!p.alive) continue;
      if (distSq(p.x, p.y, pickup.x, pickup.y) <= 8.0) {
        collectedBy = pid;
        break;
      }
    }
    if (!collectedBy) {
      remaining.push(pickup);
      continue;
    }
    const player = state.players[collectedBy];
    player.weaponLevel = Math.min(5, player.weaponLevel + pickup.value);
    player.stats.pickups++;
  }
  state.pickups = remaining;
}

function resolveTerminal(state) {
  if (state.phase !== 'playing') return;
  const alive = Object.entries(state.players).filter(([_, p]) => p.alive).map(([pid]) => pid);
  if (alive.length <= 1) {
    state.phase = 'finished';
    state.winnerIds = alive;
    state.reason = 'elimination';
  } else if (state.remainingMs === 0) {
    state.phase = 'finished';
    state.reason = 'timeout';
    // Logic to determine winner based on HP/Shield...
  }
}

function distSq(ax, ay, bx, by) {
  let dx = Math.abs(ax - bx);
  let dy = Math.abs(ay - by);
  if (dx > 50) dx = 100 - dx;
  if (dy > 50) dy = 100 - dy;
  return dx * dx + dy * dy;
}
