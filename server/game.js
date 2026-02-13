/**
 * Space Craft Game Logic - Pure JavaScript
 * 
 * Deterministic simulation for authoritative direct-mode server.
 * Ported from backend/games/space_craft.py
 */

const _round = (v) => Math.round(v * 10000) / 10000;

export const CONFIG = {
  arenaWidth: 100.0,
  arenaHeight: 100.0,
  maxSpeed: 28.0,
  accel: 50.0,
  turnRate: 4.2,
  drag: 0.98,
  projectileSpeed: 45.0,
  projectileTtlMs: 1200,
  projectileDamage: 18,
  fireCooldownMs: 300,
  maxHp: 100,
  maxShield: 60,
  shieldRegenPerTick: 0.4,
  roundDurationMs: 120000,
  pickupSpawnEveryTicks: 40,
  maxPickups: 3,
};

export function initState(playerIds, seed) {
  const spawnPoints = [
    [15.0, 50.0, 0.0],
    [85.0, 50.0, Math.PI],
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
    rngState: seed, // Simplified: use seed as state
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
  const turn = Math.max(-1, Math.min(1, Number(payload.turn || 0)));
  const thrust = Math.max(-1, Math.min(1, Number(payload.thrust || 0)));
  const fire = Boolean(payload.fire);
  player.pendingTurn = turn;
  player.pendingThrust = thrust;
  player.pendingFire = fire;
}

export function tick(state, dtMs) {
  const dt = dtMs / 1000.0;
  state.tick++;
  state.remainingMs = Math.max(0, state.remainingMs - dtMs);
  const W = state.arena.width;
  const H = state.arena.height;

  // Update players
  for (const [pid, p] of Object.entries(state.players)) {
    if (!p.alive) continue;
    const turn = p.pendingTurn || 0;
    const thrust = p.pendingThrust || 0;
    const fire = p.pendingFire || false;
    delete p.pendingTurn;
    delete p.pendingThrust;
    delete p.pendingFire;

    // Steering
    p.angle += turn * CONFIG.turnRate * dt;

    // Always move forward; W gives a boost
    const baseSpeed = 8;                         // units/s idle cruise
    const boostSpeed = CONFIG.maxSpeed;          // units/s at full thrust
    const targetSpeed = baseSpeed + thrust * (boostSpeed - baseSpeed);

    // Smoothly approach target speed
    const curSpeed = Math.hypot(p.vx, p.vy) || 0.01;
    const desired = targetSpeed;
    const newSpeed = curSpeed + (desired - curSpeed) * 0.15;  // ease factor

    p.vx = Math.cos(p.angle) * newSpeed;
    p.vy = Math.sin(p.angle) * newSpeed;

    // Move
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

export function isTerminal(state) {
  if (state.phase === 'finished') {
    return {
      terminal: true,
      winnerIds: state.winnerIds,
      reason: state.reason,
      finalTick: state.tick,
      remainingMs: state.remainingMs,
    };
  }
  return { terminal: false };
}

export function buildDelta(prevState, currState) {
  const prevProjIds = new Set(prevState.projectiles.map((p) => p.id));
  const currProjIds = new Set(currState.projectiles.map((p) => p.id));
  const removedProjectiles = [...prevProjIds].filter((id) => !currProjIds.has(id)).sort();
  return {
    changed_entities: {
      phase: currState.phase,
      remainingMs: currState.remainingMs,
      players: currState.players,
      projectiles: currState.projectiles,
      pickups: currState.pickups,
    },
    removed_entities: { projectiles: removedProjectiles },
  };
}

function advanceProjectiles(state, dtMs) {
  const arenaWidth = state.arena.width;
  const arenaHeight = state.arena.height;
  const kept = [];
  for (const proj of state.projectiles) {
    proj.ttlMs -= dtMs;
    if (proj.ttlMs <= 0) continue;
    proj.x = _round(((proj.x + proj.vx * (dtMs / 1000.0)) % arenaWidth + arenaWidth) % arenaWidth);
    proj.y = _round(((proj.y + proj.vy * (dtMs / 1000.0)) % arenaHeight + arenaHeight) % arenaHeight);
    let hitPlayerId = null;
    for (const [pid, p] of Object.entries(state.players)) {
      if (pid === proj.ownerId || !p.alive) continue;
      if (distSq(proj.x, proj.y, p.x, p.y) <= 4.0) {
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
  // Simplified RNG using tick as seed
  const rng = seededRandom(state.rngState + state.tick);
  state.pickups.push({
    id: `pickup-${state.tick}-${state.pickups.length}`,
    x: _round(8 + rng() * (CONFIG.arenaWidth - 16)),
    y: _round(8 + rng() * (CONFIG.arenaHeight - 16)),
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
      if (distSq(p.x, p.y, pickup.x, pickup.y) <= 6.25) {
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
    return;
  }
  if (state.remainingMs === 0) {
    const sorted = Object.entries(state.players).sort((a, b) => {
      const scoreA = a[1].hp + a[1].shield / 100;
      const scoreB = b[1].hp + b[1].shield / 100;
      return scoreB - scoreA;
    });
    const topScore = sorted[0][1].hp + sorted[0][1].shield / 100;
    const winners = sorted.filter(([_, p]) => p.hp + p.shield / 100 === topScore).map(([pid]) => pid);
    state.phase = 'finished';
    state.winnerIds = winners;
    state.reason = 'timeout';
  }
}

function distSq(ax, ay, bx, by) {
  let dx = Math.abs(ax - bx);
  let dy = Math.abs(ay - by);
  if (dx > CONFIG.arenaWidth / 2) dx = CONFIG.arenaWidth - dx;
  if (dy > CONFIG.arenaHeight / 2) dy = CONFIG.arenaHeight - dy;
  return dx * dx + dy * dy;
}

function seededRandom(seed) {
  // Simple seeded PRNG
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}
