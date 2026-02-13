/**
 * Space Craft - Authoritative 2P shooter simulation.
 * Deterministic, fixed-step physics.
 *
 * Features:
 * - Big ships, big projectiles, no shield regen
 * - 3 power-up types: Laser, Bomb, Nova
 */

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const TAU = Math.PI * 2;
const STATE_PRECISION = 10000;
const roundState = (v) => Math.round(v * STATE_PRECISION) / STATE_PRECISION;

export const CONFIG = {
  arenaWidth: 100,
  arenaHeight: 100,

  turnRate: 3.8,
  accelForward: 55,
  accelReverse: 28,
  linearDragPerSecond: 0.18,
  maxSpeed: 32,

  // --- Projectiles (bigger, faster, harder) ---
  projectileSpeed: 70,
  projectileTtlMs: 1200,
  projectileDamage: 30,
  fireCooldownMs: 160,
  maxLagCompensationMs: 400,

  // --- Health (no shield, no regen) ---
  maxHp: 100,

  // --- Pickups: 3 types ---
  pickupSpawnEveryTicks: 120,
  maxPickups: 3,

  // --- Sizes (bigger ships & bullets) ---
  playerRadius: 2.5,
  projectileRadius: 0.8,
  pickupRadius: 2.8,

  // --- Special weapons ---
  laserDps: 80,
  laserRangeUnits: 55,
  laserWidthUnits: 1.2,
  laserDurationMs: 2000,
  laserCooldownMs: 300,

  bombSpeed: 50,
  bombDamage: 60,
  bombRadius: 8,
  bombTtlMs: 1600,

  novaDamage: 50,
  novaRadius: 15,
  novaDurationMs: 400,

  specialUsesPerPickup: 3,

  roundDurationMs: 180000,
};

// Pickup types
const PICKUP_TYPES = ['laser', 'bomb', 'nova'];

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
      shield: 0,
      weaponLevel: 1,
      fireCooldownMs: 0,
      alive: true,
      // Special weapon state
      specialWeapon: null, // 'laser' | 'bomb' | 'nova' | null
      specialUses: 0,
      laserActiveMs: 0,     // remaining laser beam time
      novaCooldownMs: 0,
      input: { turn: 0, thrust: 0, fire: false, firePressed: false, fireSeq: null, lagCompMs: 0 },
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
    // Visual effects for client rendering
    effects: [],
    winnerIds: [],
    reason: null,
  };
}

export function applyInput(state, playerId, payload) {
  const p = state.players[playerId];
  if (!p || !p.alive) return;
  const incomingFireSeq = Number(payload?.fire_seq);
  p.input = {
    turn: clamp(Number(payload?.turn || 0), -1, 1),
    thrust: clamp(Number(payload?.thrust || 0), -1, 1),
    fire: Boolean(payload?.fire),
    firePressed: Boolean(payload?.fire_pressed),
    fireSeq: Number.isFinite(incomingFireSeq) && incomingFireSeq > 0 ? Math.floor(incomingFireSeq) : null,
    lagCompMs: clamp(Number(payload?.lag_comp_ms || 0), 0, CONFIG.maxLagCompensationMs),
  };
}

export function tick(state, dtMs) {
  if (state.phase !== 'playing') return state;

  const dt = dtMs / 1000;
  state.tick += 1;
  state.remainingMs = Math.max(0, state.remainingMs - dtMs);

  // Expire effects
  state.effects = (state.effects || [])
    .map(e => ({ ...e, ttlMs: e.ttlMs - dtMs }))
    .filter(e => e.ttlMs > 0);

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

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    clampPlayerToArena(p, state);
    quantizePlayerState(p);

    // No shield regeneration at all
    p.fireCooldownMs = Math.max(0, p.fireCooldownMs - dtMs);
    p.novaCooldownMs = Math.max(0, (p.novaCooldownMs || 0) - dtMs);

    // --- Handle firing ---
    if (p.input.firePressed && p.fireCooldownMs <= 0) {
      if (p.specialWeapon && p.specialUses > 0) {
        fireSpecialWeapon(state, pid, p);
      } else {
        // Normal projectile
        const lagCompMs = p.input.firePressed ? p.input.lagCompMs : 0;
        spawnProjectile(state, pid, p, lagCompMs, p.input.fireSeq);
        p.fireCooldownMs = CONFIG.fireCooldownMs;
      }
    }
    p.input.firePressed = false;
    p.input.fireSeq = null;

    // --- Laser beam (continuous while fire held + has uses) ---
    if (p.specialWeapon === 'laser' && p.input.fire && p.specialUses > 0) {
      p.laserActiveMs = (p.laserActiveMs || 0) + dtMs;
      applyLaserDamage(state, pid, p, dt);
      // Consume uses over time
      if (p.laserActiveMs >= CONFIG.laserDurationMs) {
        p.specialUses -= 1;
        p.laserActiveMs = 0;
        if (p.specialUses <= 0) {
          p.specialWeapon = null;
          p.specialUses = 0;
        }
      }
    } else {
      p.laserActiveMs = 0;
    }
  }

  updateProjectiles(state, dtMs);
  spawnPickups(state);
  collectPickups(state);
  resolveTerminal(state);
  return state;
}

function fireSpecialWeapon(state, pid, p) {
  switch (p.specialWeapon) {
    case 'bomb': {
      // Launch a bomb projectile (slower, bigger, explodes on impact or timeout)
      const muzzle = CONFIG.playerRadius + 1;
      const pr = {
        id: `bomb:${state.tick}:${pid}`,
        ownerId: pid,
        x: clamp(p.x + Math.cos(p.angle) * muzzle, CONFIG.projectileRadius, state.arena.width - CONFIG.projectileRadius),
        y: clamp(p.y + Math.sin(p.angle) * muzzle, CONFIG.projectileRadius, state.arena.height - CONFIG.projectileRadius),
        vx: Math.cos(p.angle) * CONFIG.bombSpeed,
        vy: Math.sin(p.angle) * CONFIG.bombSpeed,
        ttlMs: CONFIG.bombTtlMs,
        fireSeq: p.input.fireSeq || undefined,
        damage: CONFIG.bombDamage,
        isBomb: true,
      };
      quantizeProjectileState(pr);
      state.projectiles.push(pr);
      p.specialUses -= 1;
      p.fireCooldownMs = CONFIG.fireCooldownMs * 2;
      if (p.specialUses <= 0) {
        p.specialWeapon = null;
        p.specialUses = 0;
      }
      break;
    }
    case 'nova': {
      // Instant radius explosion around the player
      if (p.novaCooldownMs <= 0) {
        for (const [tid, target] of Object.entries(state.players)) {
          if (tid === pid || !target.alive) continue;
          const d = Math.hypot(target.x - p.x, target.y - p.y);
          if (d <= CONFIG.novaRadius) {
            const falloff = 1 - (d / CONFIG.novaRadius) * 0.5; // 100% at center, 50% at edge
            const dmg = Math.round(CONFIG.novaDamage * falloff);
            target.hp = Math.max(0, target.hp - dmg);
            p.stats.damageDealt += dmg;
            if (target.hp <= 0 && target.alive) {
              target.alive = false;
              target.stats.deaths += 1;
              p.stats.kills += 1;
            }
          }
        }
        // Visual effect
        state.effects.push({
          type: 'nova',
          x: p.x,
          y: p.y,
          radius: CONFIG.novaRadius,
          ownerId: pid,
          ttlMs: CONFIG.novaDurationMs,
        });
        p.specialUses -= 1;
        p.novaCooldownMs = CONFIG.fireCooldownMs * 3;
        if (p.specialUses <= 0) {
          p.specialWeapon = null;
          p.specialUses = 0;
        }
      }
      break;
    }
    case 'laser': {
      // Laser is handled continuously in the tick loop, not on firePressed
      // But pressing fire with laser should not consume the normal fire cooldown
      break;
    }
  }
}

function applyLaserDamage(state, pid, p, dt) {
  // Raycast beam from player position in facing direction
  const beamDps = CONFIG.laserDps;
  const beamRange = CONFIG.laserRangeUnits;
  const beamHalfWidth = CONFIG.laserWidthUnits / 2;

  for (const [tid, target] of Object.entries(state.players)) {
    if (tid === pid || !target.alive) continue;

    // Point-to-line-segment distance
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const beamDirX = Math.cos(p.angle);
    const beamDirY = Math.sin(p.angle);
    const proj = dx * beamDirX + dy * beamDirY;
    if (proj < 0 || proj > beamRange) continue;
    const perpDist = Math.abs(dx * (-beamDirY) + dy * beamDirX);
    if (perpDist > beamHalfWidth + CONFIG.playerRadius) continue;

    // Hit! Apply DPS
    const dmg = beamDps * dt;
    target.hp = Math.max(0, target.hp - dmg);
    p.stats.damageDealt += dmg;

    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      target.stats.deaths += 1;
      p.stats.kills += 1;
    }
  }
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

function spawnProjectile(state, ownerId, p, lagCompMs = 0, fireSeq = null) {
  const muzzle = CONFIG.playerRadius + 0.5;
  const minX = CONFIG.projectileRadius;
  const maxX = state.arena.width - CONFIG.projectileRadius;
  const minY = CONFIG.projectileRadius;
  const maxY = state.arena.height - CONFIG.projectileRadius;
  const pr = {
    id: `${state.tick}:${ownerId}:${Math.random().toString(36).slice(2, 7)}`,
    ownerId,
    x: clamp(p.x + Math.cos(p.angle) * muzzle, minX, maxX),
    y: clamp(p.y + Math.sin(p.angle) * muzzle, minY, maxY),
    vx: Math.cos(p.angle) * CONFIG.projectileSpeed,
    vy: Math.sin(p.angle) * CONFIG.projectileSpeed,
    ttlMs: CONFIG.projectileTtlMs,
    fireSeq: Number.isFinite(Number(fireSeq)) && Number(fireSeq) > 0 ? Math.floor(Number(fireSeq)) : undefined,
    damage: CONFIG.projectileDamage,
    isBomb: false,
  };

  const appliedLagMs = clamp(Number(lagCompMs || 0), 0, CONFIG.maxLagCompensationMs);
  if (appliedLagMs > 0) {
    const lagDt = appliedLagMs / 1000;
    pr.x += pr.vx * lagDt;
    pr.y += pr.vy * lagDt;
    pr.x = clamp(pr.x, minX, maxX);
    pr.y = clamp(pr.y, minY, maxY);
    pr.ttlMs = Math.max(0, pr.ttlMs - appliedLagMs);
  }
  quantizeProjectileState(pr);

  state.projectiles.push(pr);
}

function updateProjectiles(state, dtMs) {
  const dt = dtMs / 1000;
  const kept = [];

  for (const pr of state.projectiles) {
    pr.ttlMs -= dtMs;
    if (pr.ttlMs <= 0) {
      // Bombs explode on timeout
      if (pr.isBomb) triggerBombExplosion(state, pr);
      continue;
    }

    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    if (isOutOfArena(pr.x, pr.y, state, CONFIG.projectileRadius)) {
      if (pr.isBomb) triggerBombExplosion(state, pr);
      continue;
    }
    quantizeProjectileState(pr);

    let hit = null;
    for (const [pid, p] of Object.entries(state.players)) {
      if (!p.alive || pid === pr.ownerId) continue;
      if (distSq(pr.x, pr.y, p.x, p.y) <= Math.pow(CONFIG.playerRadius + CONFIG.projectileRadius, 2)) {
        hit = pid;
        break;
      }
    }

    if (!hit) {
      kept.push(pr);
      continue;
    }

    // Hit!
    if (pr.isBomb) {
      triggerBombExplosion(state, pr);
    } else {
      // Normal projectile — direct HP damage (no shield)
      const target = state.players[hit];
      const owner = state.players[pr.ownerId];
      target.hp = Math.max(0, target.hp - pr.damage);
      if (owner) owner.stats.damageDealt += pr.damage;
      if (target.hp <= 0 && target.alive) {
        target.alive = false;
        target.stats.deaths += 1;
        if (owner) owner.stats.kills += 1;
      }
    }
  }

  state.projectiles = kept;
}

function triggerBombExplosion(state, pr) {
  const owner = state.players[pr.ownerId];
  // Damage all players in blast radius (including owner!)
  for (const [pid, p] of Object.entries(state.players)) {
    if (!p.alive) continue;
    const d = Math.hypot(p.x - pr.x, p.y - pr.y);
    if (d <= CONFIG.bombRadius) {
      const falloff = 1 - (d / CONFIG.bombRadius) * 0.6;
      const dmg = Math.round(CONFIG.bombDamage * falloff);
      // Self-damage is halved
      const actualDmg = pid === pr.ownerId ? Math.round(dmg * 0.5) : dmg;
      p.hp = Math.max(0, p.hp - actualDmg);
      if (owner && pid !== pr.ownerId) owner.stats.damageDealt += actualDmg;
      if (p.hp <= 0 && p.alive) {
        p.alive = false;
        p.stats.deaths += 1;
        if (owner && pid !== pr.ownerId) owner.stats.kills += 1;
      }
    }
  }
  // Visual effect
  state.effects.push({
    type: 'explosion',
    x: pr.x,
    y: pr.y,
    radius: CONFIG.bombRadius,
    ownerId: pr.ownerId,
    ttlMs: 500,
  });
}

function spawnPickups(state) {
  if (state.tick % CONFIG.pickupSpawnEveryTicks !== 0) return;
  if (state.pickups.length >= CONFIG.maxPickups) return;

  const r1 = pseudoRandom(state.seed + state.tick * 7919);
  const r2 = pseudoRandom(state.seed + state.tick * 1543);
  const r3 = pseudoRandom(state.seed + state.tick * 3571);
  const minX = CONFIG.pickupRadius + 5;
  const maxX = state.arena.width - CONFIG.pickupRadius - 5;
  const minY = CONFIG.pickupRadius + 5;
  const maxY = state.arena.height - CONFIG.pickupRadius - 5;

  // Pick a random type from the 3 special weapons
  const typeIndex = Math.floor(r3 * PICKUP_TYPES.length) % PICKUP_TYPES.length;
  const pickupType = PICKUP_TYPES[typeIndex];

  state.pickups.push({
    id: `pu:${state.tick}:${state.pickups.length}`,
    x: roundState(minX + r1 * Math.max(0.0001, (maxX - minX))),
    y: roundState(minY + r2 * Math.max(0.0001, (maxY - minY))),
    type: pickupType,
    value: CONFIG.specialUsesPerPickup,
  });
}

function collectPickups(state) {
  const rest = [];
  for (const pickup of state.pickups) {
    let collectorId = null;
    for (const [pid, p] of Object.entries(state.players)) {
      if (!p.alive) continue;
      if (distSq(pickup.x, pickup.y, p.x, p.y) <= Math.pow(CONFIG.pickupRadius + CONFIG.playerRadius, 2)) {
        collectorId = pid;
        break;
      }
    }

    if (!collectorId) {
      rest.push(pickup);
      continue;
    }

    const collector = state.players[collectorId];
    // Grant the special weapon
    collector.specialWeapon = pickup.type;
    collector.specialUses = pickup.value;
    collector.laserActiveMs = 0;
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
      .map(([pid, p]) => ({ pid, score: p.hp }))
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

function normalizeAngle(a) {
  let n = a % TAU;
  if (n < 0) n += TAU;
  return roundState(n);
}

function distSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function clampPlayerToArena(player, state) {
  const minX = CONFIG.playerRadius;
  const maxX = state.arena.width - CONFIG.playerRadius;
  const minY = CONFIG.playerRadius;
  const maxY = state.arena.height - CONFIG.playerRadius;
  if (player.x < minX) {
    player.x = minX;
    if (player.vx < 0) player.vx = 0;
  } else if (player.x > maxX) {
    player.x = maxX;
    if (player.vx > 0) player.vx = 0;
  }
  if (player.y < minY) {
    player.y = minY;
    if (player.vy < 0) player.vy = 0;
  } else if (player.y > maxY) {
    player.y = maxY;
    if (player.vy > 0) player.vy = 0;
  }
}

function isOutOfArena(x, y, state, radius) {
  return (
    x < radius ||
    y < radius ||
    x > state.arena.width - radius ||
    y > state.arena.height - radius
  );
}

function quantizePlayerState(player) {
  player.x = roundState(player.x);
  player.y = roundState(player.y);
  player.vx = roundState(player.vx);
  player.vy = roundState(player.vy);
  player.angle = roundState(player.angle);
}

function quantizeProjectileState(projectile) {
  projectile.x = roundState(projectile.x);
  projectile.y = roundState(projectile.y);
  projectile.vx = roundState(projectile.vx);
  projectile.vy = roundState(projectile.vy);
}
