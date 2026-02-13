"use client";

import { useEffect, useRef, useState } from "react";

type AnyObj = Record<string, any>;

type PlayerState = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  shield: number;
  weaponLevel: number;
  alive: boolean;
};

type ProjectileState = {
  id: string;
  x: number;
  y: number;
  ownerId: string;
  vx: number;
  vy: number;
  ttlMs: number;
};

type WorldState = {
  phase: string;
  tick: number;
  remainingMs: number;
  players: Record<string, PlayerState>;
  projectiles: ProjectileState[];
  pickups: Array<{ id: string; x: number; y: number; type?: string }>;
};

type SnapshotFrame = {
  t: number;
  serverTick: number;
  state: WorldState;
};

type InputPayload = {
  turn: number;
  thrust: number;
  fire: boolean;
  fire_pressed?: boolean;
  client_sent_at_ms?: number;
};
type PendingInput = { transportSeq: number; payload: InputPayload; dtSec: number };

declare global {
  interface Window {
    Usion?: any;
  }
}

const CANVAS_SIZE = 1000;
const JOIN_RETRY_LIMIT = Number(process.env.NEXT_PUBLIC_JOIN_RETRY_LIMIT || 4);
const JOIN_RETRY_BACKOFF_MS = 600;

const INPUT_SEND_MS = 33;
const INTERP_DELAY_MS = 45;
const UI_TICK_UPDATE_EVERY = 2;
const MAX_PENDING_INPUTS = 120;
const IMMEDIATE_INPUT_MIN_GAP_MS = 12;
const UNSENT_PREDICTION_MAX_MS = INPUT_SEND_MS;
const MAX_RENDER_DELTA_MS = 64;

const FIRE_COOLDOWN_MS = 180;
const PROJECTILE_SPEED = 60;
const PROJECTILE_TTL_MS = 1100;
const PROJECTILE_MUZZLE_OFFSET = 2;
const PREDICTED_PROJECTILE_BRIDGE_MS = 450;
const PROJECTILE_RECONCILE_DIST = 2.6;
const PROJECTILE_RECONCILE_DIST_LAX = 12;

const POS_ERROR_SOFT = 0.45;
const POS_ERROR_HARD = 2.2;
const VEL_ERROR_SOFT = 1.3;
const ANGLE_ERROR_SOFT = 0.12;
const ANGLE_ERROR_HARD = 0.85;
const CORRECTION_SMOOTH_MS = 110;
const CORRECTION_MIN_INTERVAL_MS = 55;

const TURN_RATE = 3.8;
const ACCEL_FORWARD = 55;
const ACCEL_REVERSE = 28;
const LINEAR_DRAG_PER_SECOND = 0.18;
const MAX_SPEED = 32;

function isFireKey(event: KeyboardEvent): boolean {
  return event.code === "KeyE" || event.key.toLowerCase() === "e";
}

function isControlKey(event: KeyboardEvent): boolean {
  const k = event.key.toLowerCase();
  return k === "w" || k === "a" || k === "s" || k === "d" || event.key.startsWith("Arrow") || isFireKey(event);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function wrap(v: number, max: number): number {
  let n = v % max;
  if (n < 0) n += max;
  return n;
}

function normalizeAngle(v: number): number {
  const tau = Math.PI * 2;
  let n = v % tau;
  if (n < 0) n += tau;
  return n;
}

function toProjectile(raw: AnyObj): ProjectileState {
  return {
    id: String(raw?.id || ""),
    x: Number(raw?.x || 0),
    y: Number(raw?.y || 0),
    ownerId: String(raw?.ownerId || ""),
    vx: Number(raw?.vx || 0),
    vy: Number(raw?.vy || 0),
    ttlMs: Number(raw?.ttlMs || 0),
  };
}

function cloneWorld(state: AnyObj): WorldState {
  const players: Record<string, PlayerState> = {};
  for (const [pid, p] of Object.entries(state?.players || {})) {
    const pp = p as AnyObj;
    players[pid] = {
      id: String(pp.id || pid),
      x: Number(pp.x || 0),
      y: Number(pp.y || 0),
      vx: Number(pp.vx || 0),
      vy: Number(pp.vy || 0),
      angle: Number(pp.angle || 0),
      hp: Number(pp.hp || 0),
      shield: Number(pp.shield || 0),
      weaponLevel: Number(pp.weaponLevel || 1),
      alive: Boolean(pp.alive),
    };
  }

  return {
    phase: String(state?.phase || "playing"),
    tick: Number(state?.tick || 0),
    remainingMs: Number(state?.remainingMs || 0),
    players,
    projectiles: (state?.projectiles || []).map((x: AnyObj) => toProjectile(x)),
    pickups: (state?.pickups || []).map((x: AnyObj) => ({ id: String(x.id || ""), x: Number(x.x || 0), y: Number(x.y || 0), type: String(x.type || "") })),
  };
}

function patchEntitiesById<T extends { id: string }>(
  base: T[],
  patch: AnyObj[] | undefined,
  removed: string[] | undefined,
): T[] {
  const byId = new Map<string, T>();
  for (const item of base || []) byId.set(String(item.id), item);

  if (Array.isArray(patch)) {
    for (const raw of patch) {
      if (!raw || raw.id === undefined || raw.id === null) continue;
      const id = String(raw.id);
      byId.set(id, raw as T);
    }
  }

  if (Array.isArray(removed)) {
    for (const id of removed) byId.delete(String(id));
  }

  return Array.from(byId.values());
}

function mergeDelta(base: WorldState | null, data: AnyObj): WorldState | null {
  if (!base) {
    if (!data?.full_state) return null;
    return cloneWorld(data.full_state);
  }

  if (data?.full_state) return cloneWorld(data.full_state);
  if (!data?.changed_entities) return base;

  const changed = data.changed_entities;
  const removed = data.removed_entities || {};
  const basePlayers = base.players || {};
  let players = basePlayers;
  if (changed.players) {
    const changedPlayers = cloneWorld({ players: changed.players }).players;
    players = { ...basePlayers, ...changedPlayers };
  }

  let projectiles = base.projectiles;
  if (changed.projectiles || removed.projectiles) {
    projectiles = patchEntitiesById(
      base.projectiles,
      changed.projectiles as AnyObj[] | undefined,
      removed.projectiles as string[] | undefined,
    );
  }

  let pickups = base.pickups;
  if (changed.pickups || removed.pickups) {
    pickups = patchEntitiesById(
      base.pickups,
      changed.pickups as AnyObj[] | undefined,
      removed.pickups as string[] | undefined,
    ).map((x: AnyObj) => ({ id: String(x.id || ""), x: Number(x.x || 0), y: Number(x.y || 0), type: String(x.type || "") }));
  }

  const merged: WorldState = {
    ...base,
    phase: changed.phase !== undefined ? String(changed.phase) : base.phase,
    remainingMs: changed.remainingMs !== undefined ? Number(changed.remainingMs) : base.remainingMs,
    players,
    projectiles: projectiles.map((x: AnyObj) => toProjectile(x)),
    pickups,
  };

  return merged;
}

function shortestWrapDelta(a: number, b: number, size: number): number {
  let d = b - a;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function shortestAngleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function torusDistanceSq(ax: number, ay: number, bx: number, by: number, size: number): number {
  const dx = shortestWrapDelta(ax, bx, size);
  const dy = shortestWrapDelta(ay, by, size);
  return dx * dx + dy * dy;
}

function interpolateProjectiles(a: ProjectileState[], b: ProjectileState[], t: number): ProjectileState[] {
  const prevById = new Map<string, ProjectileState>();
  for (const item of a || []) prevById.set(item.id, item);

  const out: ProjectileState[] = [];
  for (const next of b || []) {
    const prev = prevById.get(next.id);
    if (!prev) {
      out.push({ ...next });
      continue;
    }
    out.push({
      ...next,
      x: wrap(prev.x + shortestWrapDelta(prev.x, next.x, 100) * t, 100),
      y: wrap(prev.y + shortestWrapDelta(prev.y, next.y, 100) * t, 100),
      vx: prev.vx + (next.vx - prev.vx) * t,
      vy: prev.vy + (next.vy - prev.vy) * t,
      ttlMs: prev.ttlMs + (next.ttlMs - prev.ttlMs) * t,
    });
  }
  return out;
}

function interpolateWorld(a: WorldState, b: WorldState, t: number): WorldState {
  const outPlayers: Record<string, PlayerState> = {};
  const ids = new Set([...Object.keys(a.players), ...Object.keys(b.players)]);

  for (const pid of Array.from(ids)) {
    const pa = a.players[pid];
    const pb = b.players[pid];
    if (!pa && pb) {
      outPlayers[pid] = { ...pb };
      continue;
    }
    if (pa && !pb) {
      outPlayers[pid] = { ...pa };
      continue;
    }
    if (!pa || !pb) continue;

    outPlayers[pid] = {
      ...pb,
      x: wrap(pa.x + shortestWrapDelta(pa.x, pb.x, 100) * t, 100),
      y: wrap(pa.y + shortestWrapDelta(pa.y, pb.y, 100) * t, 100),
      vx: pa.vx + (pb.vx - pa.vx) * t,
      vy: pa.vy + (pb.vy - pa.vy) * t,
      angle: lerpAngle(pa.angle, pb.angle, t),
      hp: pa.hp + (pb.hp - pa.hp) * t,
      shield: pa.shield + (pb.shield - pa.shield) * t,
      weaponLevel: t < 0.5 ? pa.weaponLevel : pb.weaponLevel,
      alive: t < 0.5 ? pa.alive : pb.alive,
    };
  }

  return {
    phase: b.phase,
    tick: b.tick,
    remainingMs: b.remainingMs,
    players: outPlayers,
    projectiles: interpolateProjectiles(a.projectiles, b.projectiles, t),
    pickups: b.pickups,
  };
}

function applyInputToPlayer(base: PlayerState, input: InputPayload, dtSec: number): PlayerState {
  const p = { ...base };
  p.angle = normalizeAngle(p.angle + input.turn * TURN_RATE * dtSec);

  if (input.thrust !== 0) {
    const accel = input.thrust > 0 ? ACCEL_FORWARD : ACCEL_REVERSE;
    p.vx += Math.cos(p.angle) * accel * input.thrust * dtSec;
    p.vy += Math.sin(p.angle) * accel * input.thrust * dtSec;
  }

  const drag = Math.exp(-LINEAR_DRAG_PER_SECOND * dtSec);
  p.vx *= drag;
  p.vy *= drag;

  const speed = Math.hypot(p.vx, p.vy);
  if (speed > MAX_SPEED) {
    const s = MAX_SPEED / speed;
    p.vx *= s;
    p.vy *= s;
  }

  p.x = wrap(p.x + p.vx * dtSec, 100);
  p.y = wrap(p.y + p.vy * dtSec, 100);

  return p;
}

function applyLocalPrediction(state: WorldState, myId: string, input: InputPayload, dtSec: number): WorldState {
  const me = state.players[myId];
  if (!me || !me.alive) return state;

  const pred = { ...state, players: { ...state.players, [myId]: applyInputToPlayer(me, input, dtSec) } };
  return pred;
}

function advanceProjectile(projectile: ProjectileState, dtSec: number, maxAgeMs: number): ProjectileState {
  return {
    ...projectile,
    x: wrap(projectile.x + projectile.vx * dtSec, 100),
    y: wrap(projectile.y + projectile.vy * dtSec, 100),
    ttlMs: Math.max(0, Math.min(maxAgeMs, projectile.ttlMs - dtSec * 1000)),
  };
}

function makePredictedProjectile(myId: string, ship: PlayerState, id: string): ProjectileState {
  return {
    id,
    ownerId: myId,
    x: wrap(ship.x + Math.cos(ship.angle) * PROJECTILE_MUZZLE_OFFSET, 100),
    y: wrap(ship.y + Math.sin(ship.angle) * PROJECTILE_MUZZLE_OFFSET, 100),
    vx: Math.cos(ship.angle) * PROJECTILE_SPEED,
    vy: Math.sin(ship.angle) * PROJECTILE_SPEED,
    ttlMs: Math.min(PROJECTILE_TTL_MS, PREDICTED_PROJECTILE_BRIDGE_MS),
  };
}

function reconcilePredictedProjectiles(
  predicted: ProjectileState[],
  authoritative: ProjectileState[],
  myId: string,
): ProjectileState[] {
  const mine = (authoritative || []).filter((pr) => pr.ownerId === myId);
  if (mine.length === 0) return predicted;

  const strictDistSq = PROJECTILE_RECONCILE_DIST * PROJECTILE_RECONCILE_DIST;
  const laxDistSq = PROJECTILE_RECONCILE_DIST_LAX * PROJECTILE_RECONCILE_DIST_LAX;
  const used = new Set<number>();
  const out: ProjectileState[] = [];
  for (const localShot of predicted) {
    let matchIdx = -1;
    for (let i = 0; i < mine.length; i++) {
      if (used.has(i)) continue;
      const serverShot = mine[i];
      const d2 = torusDistanceSq(localShot.x, localShot.y, serverShot.x, serverShot.y, 100);
      if (d2 <= strictDistSq || (localShot.ttlMs > 250 && d2 <= laxDistSq)) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx >= 0) {
      used.add(matchIdx);
    } else {
      out.push(localShot);
    }
  }
  return out;
}

function suppressLocalAuthoritativeDuplicates(
  authoritative: ProjectileState[],
  predicted: ProjectileState[],
  myId: string,
): ProjectileState[] {
  if (!myId || predicted.length === 0) return authoritative;
  const suppressDistSq = PROJECTILE_RECONCILE_DIST_LAX * PROJECTILE_RECONCILE_DIST_LAX;
  const out: ProjectileState[] = [];
  for (const pr of authoritative) {
    if (pr.ownerId !== myId) {
      out.push(pr);
      continue;
    }
    const duplicatesPredicted = predicted.some((localPr) => torusDistanceSq(localPr.x, localPr.y, pr.x, pr.y, 100) <= suppressDistSq);
    if (!duplicatesPredicted) out.push(pr);
  }
  return out;
}

function reconcileLocalPlayerVisual(
  prevVisual: PlayerState | null,
  authoritative: PlayerState,
  dtSec: number,
  nowMs: number,
  lastCorrectionAtMs: number,
): { player: PlayerState; corrected: boolean } {
  if (!prevVisual) return { player: { ...authoritative }, corrected: true };
  if (!authoritative.alive) return { player: { ...authoritative }, corrected: true };

  const posError = Math.sqrt(torusDistanceSq(prevVisual.x, prevVisual.y, authoritative.x, authoritative.y, 100));
  const velError = Math.hypot(prevVisual.vx - authoritative.vx, prevVisual.vy - authoritative.vy);
  const angleError = Math.abs(shortestAngleDelta(prevVisual.angle, authoritative.angle));

  if (posError < POS_ERROR_SOFT && velError < VEL_ERROR_SOFT && angleError < ANGLE_ERROR_SOFT) {
    return { player: prevVisual, corrected: false };
  }

  if (posError >= POS_ERROR_HARD || angleError >= ANGLE_ERROR_HARD) {
    return { player: { ...authoritative }, corrected: true };
  }

  if (nowMs - lastCorrectionAtMs < CORRECTION_MIN_INTERVAL_MS) {
    return { player: prevVisual, corrected: false };
  }

  const alpha = clamp((dtSec * 1000) / CORRECTION_SMOOTH_MS, 0.08, 0.85);
  return {
    corrected: true,
    player: {
      ...prevVisual,
      x: wrap(prevVisual.x + shortestWrapDelta(prevVisual.x, authoritative.x, 100) * alpha, 100),
      y: wrap(prevVisual.y + shortestWrapDelta(prevVisual.y, authoritative.y, 100) * alpha, 100),
      vx: prevVisual.vx + (authoritative.vx - prevVisual.vx) * alpha,
      vy: prevVisual.vy + (authoritative.vy - prevVisual.vy) * alpha,
      angle: normalizeAngle(lerpAngle(prevVisual.angle, authoritative.angle, alpha)),
      hp: authoritative.hp,
      shield: authoritative.shield,
      weaponLevel: authoritative.weaponLevel,
      alive: authoritative.alive,
    },
  };
}

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState("Initializing...");
  const [roomId, setRoomId] = useState("");
  const [myId, setMyId] = useState("");
  const [joined, setJoined] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [joining, setJoining] = useState(false);
  const [playerCount, setPlayerCount] = useState(0);
  const [serverTick, setServerTick] = useState(0);

  const worldRef = useRef<WorldState | null>(null);
  const snapshotsRef = useRef<SnapshotFrame[]>([]);
  const keysRef = useRef({ up: false, down: false, left: false, right: false, fire: false });
  const pendingInputsRef = useRef<PendingInput[]>([]);
  const lastAckSeqRef = useRef(0);
  const lastNetworkTickRef = useRef(0);

  const inputTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const connectGuardRef = useRef(false);
  const handlersBoundRef = useRef(false);
  const activeRoomIdRef = useRef("");
  const myIdRef = useRef("");
  const lastUiTickRef = useRef(0);
  const lastHudUpdateRef = useRef(0);
  const lastRenderAtRef = useRef<number | null>(null);
  const localFireCooldownMsRef = useRef(0);
  const predictedProjectilesRef = useRef<ProjectileState[]>([]);
  const predictedProjectileSeqRef = useRef(0);
  const lastInputSentAtRef = useRef(0);
  const lastImmediateInputSentAtRef = useRef(0);
  const lastSentFireRef = useRef(false);
  const localVisualPlayerRef = useRef<PlayerState | null>(null);
  const lastLocalCorrectionAtRef = useRef(0);
  const joinedRef = useRef(false);
  const gameStartedRef = useRef(false);
  const sendImmediateInputRef = useRef<() => void>(() => {});

  joinedRef.current = joined;
  gameStartedRef.current = gameStarted;

  useEffect(() => {
    if (window.Usion?._initialized) return;
    window.Usion?.init?.();
  }, []);

  function sendControlInput(usion: AnyObj, input: InputPayload, sentAtMs = performance.now()) {
    const isFirePressed = Boolean(input.fire && !lastSentFireRef.current);
    lastSentFireRef.current = Boolean(input.fire);
    const inputWithTiming: InputPayload = {
      ...input,
      fire_pressed: isFirePressed,
      client_sent_at_ms: Date.now(),
    };
    usion.game.realtime("control", inputWithTiming);

    const prevSentAt = lastInputSentAtRef.current || sentAtMs - INPUT_SEND_MS;
    const dtSec = clamp((sentAtMs - prevSentAt) / 1000, 1 / 240, 0.12);
    lastInputSentAtRef.current = sentAtMs;

    const transportSeq = Number(usion?.game?._directSeq || 0);
    if (transportSeq > 0) {
      pendingInputsRef.current.push({ transportSeq, payload: inputWithTiming, dtSec });
      if (pendingInputsRef.current.length > MAX_PENDING_INPUTS) {
        pendingInputsRef.current.splice(0, pendingInputsRef.current.length - MAX_PENDING_INPUTS);
      }
    }
  }

  sendImmediateInputRef.current = () => {
    if (!joinedRef.current || !gameStartedRef.current) return;

    const usion = window.Usion;
    if (!usion?.game) return;

    const now = performance.now();
    if (now - lastImmediateInputSentAtRef.current < IMMEDIATE_INPUT_MIN_GAP_MS) return;

    sendControlInput(usion, buildInputFromKeys(keysRef.current), now);
    lastImmediateInputSentAtRef.current = now;
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isControlKey(event)) event.preventDefault();

      const k = event.key.toLowerCase();
      let changed = false;
      if ((k === "w" || event.key === "ArrowUp") && !keysRef.current.up) {
        keysRef.current.up = true;
        changed = true;
      }
      if ((k === "s" || event.key === "ArrowDown") && !keysRef.current.down) {
        keysRef.current.down = true;
        changed = true;
      }
      if ((k === "a" || event.key === "ArrowLeft") && !keysRef.current.left) {
        keysRef.current.left = true;
        changed = true;
      }
      if ((k === "d" || event.key === "ArrowRight") && !keysRef.current.right) {
        keysRef.current.right = true;
        changed = true;
      }
      if (isFireKey(event) && !keysRef.current.fire) {
        keysRef.current.fire = true;
        changed = true;
      }
      if (changed) sendImmediateInputRef.current();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (isControlKey(event)) event.preventDefault();

      const k = event.key.toLowerCase();
      let changed = false;
      if ((k === "w" || event.key === "ArrowUp") && keysRef.current.up) {
        keysRef.current.up = false;
        changed = true;
      }
      if ((k === "s" || event.key === "ArrowDown") && keysRef.current.down) {
        keysRef.current.down = false;
        changed = true;
      }
      if ((k === "a" || event.key === "ArrowLeft") && keysRef.current.left) {
        keysRef.current.left = false;
        changed = true;
      }
      if ((k === "d" || event.key === "ArrowRight") && keysRef.current.right) {
        keysRef.current.right = false;
        changed = true;
      }
      if (isFireKey(event) && keysRef.current.fire) {
        keysRef.current.fire = false;
        changed = true;
      }
      if (changed) sendImmediateInputRef.current();
    };

    const onBlur = () => {
      const hadInput = keysRef.current.up || keysRef.current.down || keysRef.current.left || keysRef.current.right || keysRef.current.fire;
      keysRef.current = { up: false, down: false, left: false, right: false, fire: false };
      lastSentFireRef.current = false;
      if (hadInput) sendImmediateInputRef.current();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const render = () => {
      renderFrame();
      rafRef.current = window.requestAnimationFrame(render);
    };
    rafRef.current = window.requestAnimationFrame(render);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const usion = window.Usion;
    if (!usion?.game) return;

    if (gameStarted && joined && !inputTimerRef.current) {
      lastInputSentAtRef.current = performance.now() - INPUT_SEND_MS;
      lastSentFireRef.current = false;
      inputTimerRef.current = window.setInterval(() => {
        const input = buildInputFromKeys(keysRef.current);
        sendControlInput(usion, input);
      }, INPUT_SEND_MS);
    }

    if ((!gameStarted || !joined) && inputTimerRef.current) {
      window.clearInterval(inputTimerRef.current);
      inputTimerRef.current = null;
    }
  }, [gameStarted, joined]);

  useEffect(() => {
    return () => {
      if (inputTimerRef.current) window.clearInterval(inputTimerRef.current);
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      predictedProjectilesRef.current = [];
      pendingInputsRef.current = [];
      localFireCooldownMsRef.current = 0;
      lastRenderAtRef.current = null;
      lastSentFireRef.current = false;
      localVisualPlayerRef.current = null;
      lastLocalCorrectionAtRef.current = 0;
      try { window.Usion?.game?.disconnect?.(); } catch {}
    };
  }, []);

  function renderFrame() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const now = performance.now();
    const prevRenderAt = lastRenderAtRef.current ?? now - INPUT_SEND_MS;
    const frameDtMs = clamp(now - prevRenderAt, 0, MAX_RENDER_DELTA_MS);
    const frameDtSec = frameDtMs / 1000;
    lastRenderAtRef.current = now;

    const target = now - INTERP_DELAY_MS;
    const snapshots = snapshotsRef.current;

    if (snapshots.length === 0) return;

    let renderState: WorldState;
    if (snapshots.length === 1 || target <= snapshots[0].t) {
      renderState = snapshots[0].state;
    } else {
      let older = snapshots[0];
      let newer = snapshots[snapshots.length - 1];

      for (let i = 0; i < snapshots.length - 1; i++) {
        const a = snapshots[i];
        const b = snapshots[i + 1];
        if (a.t <= target && b.t >= target) {
          older = a;
          newer = b;
          break;
        }
      }

      if (older === newer) {
        renderState = older.state;
      } else {
        const alpha = clamp((target - older.t) / Math.max(1, newer.t - older.t), 0, 1);
        renderState = interpolateWorld(older.state, newer.state, alpha);
      }
    }

    const myPid = myIdRef.current;
    if (myPid) {
      predictedProjectilesRef.current = predictedProjectilesRef.current
        .map((pr) => advanceProjectile(pr, frameDtSec, PREDICTED_PROJECTILE_BRIDGE_MS))
        .filter((pr) => pr.ttlMs > 0);
      localFireCooldownMsRef.current = Math.max(0, localFireCooldownMsRef.current - frameDtMs);

      const newest = snapshots[snapshots.length - 1]?.state;
      const newestMe = newest?.players?.[myPid];
      if (newestMe) {
        const reconciled = reconcileLocalPlayerVisual(
          localVisualPlayerRef.current,
          newestMe,
          frameDtSec,
          now,
          lastLocalCorrectionAtRef.current,
        );
        if (reconciled.corrected) {
          lastLocalCorrectionAtRef.current = now;
        }
        renderState = {
          ...renderState,
          players: {
            ...renderState.players,
            [myPid]: { ...reconciled.player },
          },
        };
      }
      for (const pending of pendingInputsRef.current) {
        renderState = applyLocalPrediction(renderState, myPid, pending.payload, pending.dtSec);
      }

      const unsentMs = clamp(now - lastInputSentAtRef.current, 0, UNSENT_PREDICTION_MAX_MS);
      if (unsentMs > 0) {
        renderState = applyLocalPrediction(renderState, myPid, buildInputFromKeys(keysRef.current), unsentMs / 1000);
      }

      if (joinedRef.current && gameStartedRef.current && keysRef.current.fire && localFireCooldownMsRef.current <= 0) {
        const predictedMe = renderState.players[myPid];
        if (predictedMe?.alive) {
          predictedProjectileSeqRef.current += 1;
          predictedProjectilesRef.current.push(
            makePredictedProjectile(myPid, predictedMe, `pred:${myPid}:${predictedProjectileSeqRef.current}`),
          );
          localFireCooldownMsRef.current = FIRE_COOLDOWN_MS;
        }
      }

      predictedProjectilesRef.current = reconcilePredictedProjectiles(
        predictedProjectilesRef.current,
        renderState.projectiles,
        myPid,
      );
      if (renderState.players[myPid]) {
        localVisualPlayerRef.current = { ...renderState.players[myPid] };
      }
    } else if (predictedProjectilesRef.current.length > 0) {
      predictedProjectilesRef.current = [];
      localFireCooldownMsRef.current = 0;
      localVisualPlayerRef.current = null;
    }

    if (predictedProjectilesRef.current.length > 0) {
      const authoritativeProjectiles = suppressLocalAuthoritativeDuplicates(
        renderState.projectiles,
        predictedProjectilesRef.current,
        myPid,
      );
      renderState = {
        ...renderState,
        projectiles: [...authoritativeProjectiles, ...predictedProjectilesRef.current],
      };
    }

    drawWorld(renderState, canvas, myPid);
  }

  function getConfigRoomId(): string {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("roomId");
    if (query) return query;
    return String(window.Usion?.config?.roomId || "");
  }

  function buildInputFromKeys(keys: { up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean }): InputPayload {
    const turn = keys.left ? -1 : keys.right ? 1 : 0;
    const thrust = keys.up ? 1 : keys.down ? -1 : 0;
    return { turn, thrust, fire: keys.fire };
  }

  function onNetworkState(data: AnyObj) {
    if (!data || data.room_id !== activeRoomIdRef.current) return;
    const tick = Number(data.server_tick || 0);
    if (tick > 0) {
      if (tick <= lastNetworkTickRef.current) return;
      lastNetworkTickRef.current = tick;
    }

    const merged = mergeDelta(worldRef.current, data);
    if (!merged) return;

    worldRef.current = merged;

    const myPid = myIdRef.current;
    if (myPid) {
      const ack = Number(data?.ack_seq_by_player?.[myPid] || 0);
      if (ack > lastAckSeqRef.current) {
        lastAckSeqRef.current = ack;
        pendingInputsRef.current = pendingInputsRef.current.filter((ev) => ev.transportSeq > ack);
      }
    }

    const frame: SnapshotFrame = {
      t: performance.now(),
      serverTick: tick,
      state: cloneWorld(merged),
    };

    snapshotsRef.current.push(frame);
    if (snapshotsRef.current.length > 40) {
      snapshotsRef.current.splice(0, snapshotsRef.current.length - 40);
    }

    const uiTick = frame.serverTick;
    if (uiTick - lastUiTickRef.current >= UI_TICK_UPDATE_EVERY || uiTick < lastUiTickRef.current) {
      lastUiTickRef.current = uiTick;
      setServerTick(uiTick);
    }

    if (!gameStarted) setGameStarted(true);

    const now = performance.now();
    if (now - lastHudUpdateRef.current > 180) {
      lastHudUpdateRef.current = now;
      setPlayerCount(Object.keys(merged.players || {}).length);
    }
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function connectAndJoin() {
    if (connectGuardRef.current) return;

    const usion = window.Usion;
    if (!usion?.game) {
      setStatus("SDK not ready");
      return;
    }

    const rid = getConfigRoomId();
    if (!rid) {
      setStatus("Missing roomId");
      return;
    }

    connectGuardRef.current = true;
    setJoining(true);
    setRoomId(rid);
    activeRoomIdRef.current = rid;
    predictedProjectilesRef.current = [];
    predictedProjectileSeqRef.current = 0;
    localFireCooldownMsRef.current = 0;
    lastRenderAtRef.current = null;
    lastSentFireRef.current = false;
    localVisualPlayerRef.current = null;
    lastLocalCorrectionAtRef.current = 0;

    const uid = String(usion.user?.getId?.() || "");
    myIdRef.current = uid;
    setMyId(uid);

    try {
      if (!handlersBoundRef.current) {
        handlersBoundRef.current = true;

        usion.game.onJoined((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          const joinedPlayerId = String(data?.player_id || "");
          if (joinedPlayerId) {
            myIdRef.current = joinedPlayerId;
            setMyId(joinedPlayerId);
          }
          pendingInputsRef.current = [];
          predictedProjectilesRef.current = [];
          predictedProjectileSeqRef.current = 0;
          lastAckSeqRef.current = 0;
          lastNetworkTickRef.current = 0;
          lastInputSentAtRef.current = performance.now() - INPUT_SEND_MS;
          localFireCooldownMsRef.current = 0;
          lastSentFireRef.current = false;
          localVisualPlayerRef.current = null;
          lastLocalCorrectionAtRef.current = 0;
          setJoined(true);
          setPlayerCount((data?.player_ids || []).length);
          const waiting = Number(data?.waiting_for || 0);
          setStatus(waiting > 0 ? `Waiting for ${waiting} player(s)...` : "All players connected");
        });

        if (usion.game.onPlayerJoined) {
          usion.game.onPlayerJoined((data: AnyObj) => {
            if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
            setPlayerCount((data?.player_ids || []).length);
          });
        }

        usion.game.onGameStart((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          lastInputSentAtRef.current = performance.now() - INPUT_SEND_MS;
          localFireCooldownMsRef.current = 0;
          predictedProjectilesRef.current = [];
          lastSentFireRef.current = false;
          localVisualPlayerRef.current = null;
          lastLocalCorrectionAtRef.current = 0;
          setGameStarted(true);
          setStatus("Fight");
        });

        usion.game.onStateUpdate((data: AnyObj) => {
          onNetworkState(data);
        });

        usion.game.onGameFinished((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          pendingInputsRef.current = [];
          predictedProjectilesRef.current = [];
          localFireCooldownMsRef.current = 0;
          lastSentFireRef.current = false;
          localVisualPlayerRef.current = null;
          lastLocalCorrectionAtRef.current = 0;
          setGameStarted(false);
          setStatus(`Match ended (${data?.reason || "done"})`);
        });

        usion.game.onError((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          const code = String(data?.code || "unknown");
          setStatus(`Server error: ${code}`);
        });
      }

      let lastError: any = null;
      for (let attempt = 1; attempt <= JOIN_RETRY_LIMIT; attempt++) {
        try {
          try { usion.game.disconnect?.(); } catch {}
          await sleep(100);

          await usion.game.connectDirect();
          const joinRes = await usion.game.join(rid);
          if (joinRes?.error) throw new Error(String(joinRes.error));
          const joinedPlayerId = String(joinRes?.player_id || "");
          if (joinedPlayerId) {
            myIdRef.current = joinedPlayerId;
            setMyId(joinedPlayerId);
          }

          predictedProjectilesRef.current = [];
          predictedProjectileSeqRef.current = 0;
          localFireCooldownMsRef.current = 0;
          lastInputSentAtRef.current = performance.now() - INPUT_SEND_MS;
          lastSentFireRef.current = false;
          localVisualPlayerRef.current = null;
          lastLocalCorrectionAtRef.current = 0;
          setJoined(true);
          setPlayerCount((joinRes?.player_ids || []).length);
          const waiting = Number(joinRes?.waiting_for || 0);
          setStatus(waiting > 0 ? `Waiting for ${waiting} player(s)...` : "Ready");

          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          const msg = String((err as AnyObj)?.message || err);
          if (!msg.includes("1006") || attempt === JOIN_RETRY_LIMIT) throw err;
          setStatus(`Reconnecting (${attempt}/${JOIN_RETRY_LIMIT})...`);
          await sleep(JOIN_RETRY_BACKOFF_MS * attempt);
        }
      }

      if (lastError) throw lastError;
    } catch (err: any) {
      setStatus(`Connection failed: ${String(err?.message || err)}`);
    } finally {
      connectGuardRef.current = false;
      setJoining(false);
    }
  }

  const me = myId ? worldRef.current?.players?.[myId] : null;

  return (
    <main
      style={{
        height: "100dvh",
        width: "100vw",
        overflow: "hidden",
        background: "radial-gradient(circle at 20% 5%, #0b1732 0%, #030712 55%, #01040d 100%)",
        display: "block",
        padding: 10,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "grid",
          gridTemplateRows: "auto auto auto minmax(0, 1fr) auto",
          gap: 10,
          borderRadius: 14,
          border: "1px solid rgba(56,189,248,0.35)",
          background: "linear-gradient(180deg, rgba(2,6,23,0.88), rgba(2,6,23,0.96))",
          padding: 12,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "#dbeafe" }}>
          <h1 style={{ margin: 0, fontSize: "clamp(1.2rem, 2.6vw, 1.85rem)", fontWeight: 800 }}>Space Craft Duel</h1>
          <div style={{ fontSize: 12, opacity: 0.9 }}>Tick {serverTick}</div>
        </div>

        <div style={{ color: "#93c5fd", fontSize: 13 }}>
          Room {roomId || "-"} | {joined ? "connected" : "not connected"} | players {playerCount}/2
        </div>

        {!joined ? (
          <button
            onClick={connectAndJoin}
            disabled={joining}
            style={{
              height: 40,
              borderRadius: 8,
              border: "1px solid #2563eb",
              background: "linear-gradient(180deg,#3b82f6,#2563eb)",
              color: "#eff6ff",
              fontWeight: 700,
              cursor: joining ? "progress" : "pointer",
            }}
          >
            {joining ? "Connecting..." : "Connect + Join"}
          </button>
        ) : (
          <div style={{ color: "#bfdbfe", fontSize: 13 }}>{status}</div>
        )}

        <div
          style={{
            minHeight: 0,
            border: "1px solid rgba(56,189,248,0.25)",
            borderRadius: 12,
            overflow: "hidden",
            display: "grid",
            placeItems: "center",
            background: "#020817",
          }}
        >
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            style={{
              display: "block",
              width: "min(calc(100dvh - 190px), calc(100vw - 30px))",
              height: "auto",
              aspectRatio: "1 / 1",
              maxHeight: "100%",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", color: "#93c5fd", fontSize: 12 }}>
          <span>Move: W/A/S/D</span>
          <span>Shoot: E</span>
          <span>Pickups: yellow W+</span>
          {me && <span>You HP {Math.round(me.hp)} SH {Math.round(me.shield)} W{Math.round(me.weaponLevel)}</span>}
        </div>
      </div>
    </main>
  );
}

function drawWorld(world: WorldState, canvas: HTMLCanvasElement, myId: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const sx = w / 100;
  const sy = h / 100;
  const shipNose = 16;
  const shipTail = 12;
  const shipWing = 10;
  const hpBarW = 38;
  const hpBarY = 22;
  const shieldBarY = 16;
  const labelY = 29;

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#07132b");
  bg.addColorStop(1, "#020817");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(56,189,248,0.06)";
  ctx.lineWidth = 1;
  for (let i = 10; i < 100; i += 10) {
    ctx.beginPath();
    ctx.moveTo(i * sx, 0);
    ctx.lineTo(i * sx, h);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i * sy);
    ctx.lineTo(w, i * sy);
    ctx.stroke();
  }

  for (const pickup of world.pickups) {
    const x = pickup.x * sx;
    const y = pickup.y * sy;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((world.tick * 0.06) % (Math.PI * 2));
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(8, 0);
    ctx.lineTo(0, 8);
    ctx.lineTo(-8, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "#fde68a";
    ctx.font = "bold 11px system-ui";
    ctx.fillText("W+", x - 9, y - 11);
  }

  ctx.fillStyle = "#fb7185";
  for (const pr of world.projectiles) {
    ctx.beginPath();
    ctx.arc(pr.x * sx, pr.y * sy, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const [pid, p] of Object.entries(world.players)) {
    const x = p.x * sx;
    const y = p.y * sy;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.angle);

    ctx.fillStyle = p.alive ? (pid === myId ? "#22d3ee" : "#f59e0b") : "#64748b";
    ctx.beginPath();
    ctx.moveTo(shipNose, 0);
    ctx.lineTo(-shipTail, shipWing);
    ctx.lineTo(-shipTail * 0.66, 0);
    ctx.lineTo(-shipTail, -shipWing);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    const hp = clamp(p.hp / 100, 0, 1);
    const sh = clamp(p.shield / 60, 0, 1);

    ctx.fillStyle = "rgba(15,23,42,0.8)";
    ctx.fillRect(x - hpBarW / 2, y - hpBarY, hpBarW, 4);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(x - hpBarW / 2, y - hpBarY, hpBarW * hp, 4);

    ctx.fillStyle = "rgba(15,23,42,0.8)";
    ctx.fillRect(x - hpBarW / 2, y - shieldBarY, hpBarW, 3);
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(x - hpBarW / 2, y - shieldBarY, hpBarW * sh, 3);

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "bold 12px system-ui";
    ctx.fillText(`${pid === myId ? "YOU" : "RIVAL"} W${Math.round(p.weaponLevel)}`, x - 24, y - labelY);
  }
}
