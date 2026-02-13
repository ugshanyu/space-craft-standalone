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
  fireSeq?: number;
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
  fire_seq?: number;
  client_sent_at_ms?: number;
};
type PendingInput = { transportSeq: number; payload: InputPayload; dtSec: number };
type PerfHud = { fps: number; netGapMs: number; jitterMs: number; pendingInputs: number };
type NetDebugHud = { mode: string; transport: string; rttMs: number | null };
type ServerDebugHud = { region: string; simHz: number | null; netHz: number | null };
type LogLine = { id: number; ts: string; text: string };

declare global {
  interface Window {
    Usion?: any;
  }
}

const CANVAS_SIZE = 1000;
const JOIN_RETRY_LIMIT = Number(process.env.NEXT_PUBLIC_JOIN_RETRY_LIMIT || 4);
const JOIN_RETRY_BACKOFF_MS = 600;
const BRUTAL_CLIENT_SIDE_MODE = process.env.NEXT_PUBLIC_BRUTAL_CLIENT_SIDE_MODE === "1";

const WORLD_SIZE = 100;
const PLAYER_RADIUS = 1.5;
const PROJECTILE_RADIUS = 0.45;
const INPUT_SEND_MS = 16;
const INTERP_DELAY_MS = Number(process.env.NEXT_PUBLIC_INTERP_DELAY_MS || (BRUTAL_CLIENT_SIDE_MODE ? 20 : 10));
const UI_TICK_UPDATE_EVERY = 2;
const MAX_PENDING_INPUTS = 120;
const IMMEDIATE_INPUT_MIN_GAP_MS = 12;
const UNSENT_PREDICTION_MAX_MS = INPUT_SEND_MS;
const MAX_RENDER_DELTA_MS = 64;
const EXPECTED_NET_UPDATE_MS = 18;

const FIRE_COOLDOWN_MS = 180;
const PROJECTILE_SPEED = 60;
const PROJECTILE_TTL_MS = 1100;
const PROJECTILE_MUZZLE_OFFSET = 2;
const PREDICTED_PROJECTILE_BRIDGE_MS = 450;
const PROJECTILE_RECONCILE_DIST = 2.6;
const PROJECTILE_RECONCILE_DIST_LAX = 12;

// --- CS:GO 2 style: no reconciliation smoothing ---
// Only snap-correct if truly desynced (teleport / severe packet loss)
const DESYNC_SNAP_THRESHOLD = 15;

const TURN_RATE = 3.8;
const ACCEL_FORWARD = 55;
const ACCEL_REVERSE = 28;
const LINEAR_DRAG_PER_SECOND = 0.18;
const MAX_SPEED = 32;

// Match server quantization to avoid rounding-induced reconciliation
const STATE_PRECISION = 10000;
function roundState(v: number): number {
  return Math.round(v * STATE_PRECISION) / STATE_PRECISION;
}

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

function clampToBoard(v: number, radius = 0): number {
  return clamp(v, radius, WORLD_SIZE - radius);
}

function normalizeAngle(v: number): number {
  const tau = Math.PI * 2;
  let n = v % tau;
  if (n < 0) n += tau;
  return roundState(n);
}

function toProjectile(raw: AnyObj): ProjectileState {
  const fireSeq = Number(raw?.fireSeq ?? raw?.fire_seq);
  return {
    id: String(raw?.id || ""),
    x: Number(raw?.x || 0),
    y: Number(raw?.y || 0),
    ownerId: String(raw?.ownerId || ""),
    vx: Number(raw?.vx || 0),
    vy: Number(raw?.vy || 0),
    ttlMs: Number(raw?.ttlMs || 0),
    fireSeq: Number.isFinite(fireSeq) && fireSeq > 0 ? Math.floor(fireSeq) : undefined,
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
    tick: changed.tick !== undefined ? Number(changed.tick) : base.tick,
    remainingMs: changed.remainingMs !== undefined ? Number(changed.remainingMs) : base.remainingMs,
    players,
    projectiles: projectiles.map((x: AnyObj) => toProjectile(x)),
    pickups,
  };

  return merged;
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

function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
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
      x: prev.x + (next.x - prev.x) * t,
      y: prev.y + (next.y - prev.y) * t,
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
      x: pa.x + (pb.x - pa.x) * t,
      y: pa.y + (pb.y - pa.y) * t,
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

  p.x += p.vx * dtSec;
  p.y += p.vy * dtSec;

  const minPos = PLAYER_RADIUS;
  const maxPos = WORLD_SIZE - PLAYER_RADIUS;
  if (p.x < minPos) {
    p.x = minPos;
    if (p.vx < 0) p.vx = 0;
  } else if (p.x > maxPos) {
    p.x = maxPos;
    if (p.vx > 0) p.vx = 0;
  }
  if (p.y < minPos) {
    p.y = minPos;
    if (p.vy < 0) p.vy = 0;
  } else if (p.y > maxPos) {
    p.y = maxPos;
    if (p.vy > 0) p.vy = 0;
  }

  // Quantize to match server precision, preventing float-drift reconciliation
  p.x = roundState(p.x);
  p.y = roundState(p.y);
  p.vx = roundState(p.vx);
  p.vy = roundState(p.vy);
  p.angle = roundState(p.angle);

  return p;
}

function applyLocalPrediction(state: WorldState, myId: string, input: InputPayload, dtSec: number): WorldState {
  const me = state.players[myId];
  if (!me || !me.alive) return state;

  const pred = { ...state, players: { ...state.players, [myId]: applyInputToPlayer(me, input, dtSec) } };
  return pred;
}

function blendServerAndLocalPlayer(serverPlayer: PlayerState | undefined, localPlayer: PlayerState): PlayerState {
  if (!serverPlayer) return { ...localPlayer };
  return {
    ...serverPlayer,
    x: localPlayer.x,
    y: localPlayer.y,
    vx: localPlayer.vx,
    vy: localPlayer.vy,
    angle: localPlayer.angle,
    alive: localPlayer.alive,
  };
}

function advanceProjectile(projectile: ProjectileState, dtSec: number, maxAgeMs: number): ProjectileState {
  const x = projectile.x + projectile.vx * dtSec;
  const y = projectile.y + projectile.vy * dtSec;
  const outOfBounds = (
    x < PROJECTILE_RADIUS ||
    y < PROJECTILE_RADIUS ||
    x > WORLD_SIZE - PROJECTILE_RADIUS ||
    y > WORLD_SIZE - PROJECTILE_RADIUS
  );
  return {
    ...projectile,
    x,
    y,
    ttlMs: outOfBounds ? 0 : Math.max(0, Math.min(maxAgeMs, projectile.ttlMs - dtSec * 1000)),
  };
}

function makePredictedProjectile(myId: string, ship: PlayerState, id: string, fireSeq?: number): ProjectileState {
  return {
    id,
    ownerId: myId,
    x: clampToBoard(ship.x + Math.cos(ship.angle) * PROJECTILE_MUZZLE_OFFSET, PROJECTILE_RADIUS),
    y: clampToBoard(ship.y + Math.sin(ship.angle) * PROJECTILE_MUZZLE_OFFSET, PROJECTILE_RADIUS),
    vx: Math.cos(ship.angle) * PROJECTILE_SPEED,
    vy: Math.sin(ship.angle) * PROJECTILE_SPEED,
    ttlMs: Math.min(PROJECTILE_TTL_MS, PREDICTED_PROJECTILE_BRIDGE_MS),
    fireSeq,
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
  const byFireSeq = new Map<number, number[]>();
  for (let i = 0; i < mine.length; i++) {
    const seq = mine[i].fireSeq;
    if (!seq) continue;
    const bucket = byFireSeq.get(seq) || [];
    bucket.push(i);
    byFireSeq.set(seq, bucket);
  }
  const out: ProjectileState[] = [];
  for (const localShot of predicted) {
    if (localShot.fireSeq) {
      const bucket = byFireSeq.get(localShot.fireSeq) || [];
      const seqMatch = bucket.find((i) => !used.has(i));
      if (seqMatch !== undefined) {
        used.add(seqMatch);
        continue;
      }
    }

    let matchIdx = -1;
    for (let i = 0; i < mine.length; i++) {
      if (used.has(i)) continue;
      const serverShot = mine[i];
      const d2 = distanceSq(localShot.x, localShot.y, serverShot.x, serverShot.y);
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
  const predictedFireSeqs = new Set<number>();
  for (const localPr of predicted) {
    if (localPr.fireSeq) predictedFireSeqs.add(localPr.fireSeq);
  }
  const out: ProjectileState[] = [];
  for (const pr of authoritative) {
    if (pr.ownerId !== myId) {
      out.push(pr);
      continue;
    }
    if (pr.fireSeq && predictedFireSeqs.has(pr.fireSeq)) {
      continue;
    }
    const duplicatesPredicted = predicted.some((localPr) => distanceSq(localPr.x, localPr.y, pr.x, pr.y) <= suppressDistSq);
    if (!duplicatesPredicted) out.push(pr);
  }
  return out;
}

/**
 * CS:GO 2 style server reconciliation:
 * Take authoritative server state → replay unacked inputs → that IS the position.
 * No smoothing, no thresholds. Only snap on catastrophic desync.
 */
function serverReconcilePlayer(
  serverState: PlayerState,
  pendingInputs: PendingInput[],
): PlayerState {
  let predicted = { ...serverState };
  for (const pending of pendingInputs) {
    predicted = applyInputToPlayer(predicted, pending.payload, pending.dtSec);
  }
  return predicted;
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
  const [perfHud, setPerfHud] = useState<PerfHud>({ fps: 0, netGapMs: 0, jitterMs: 0, pendingInputs: 0 });
  const [netDebugHud, setNetDebugHud] = useState<NetDebugHud>({ mode: "unknown", transport: "-", rttMs: null });
  const [serverDebugHud, setServerDebugHud] = useState<ServerDebugHud>({ region: "-", simHz: null, netHz: null });
  const [logLines, setLogLines] = useState<LogLine[]>([]);

  const worldRef = useRef<WorldState | null>(null);
  const snapshotsRef = useRef<SnapshotFrame[]>([]);
  const keysRef = useRef({ up: false, down: false, left: false, right: false, fire: false });
  const pendingInputsRef = useRef<PendingInput[]>([]);
  const lastAckSeqRef = useRef(0);
  const lastNetworkTickRef = useRef(0);

  const inputTimerRef = useRef<number | null>(null);
  const perfHudTimerRef = useRef<number | null>(null);
  const netDebugTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
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
  const localFireSeqRef = useRef(0);
  const lastInputSentAtRef = useRef(0);
  const lastImmediateInputSentAtRef = useRef(0);
  const lastSentFireRef = useRef(false);
  const brutalLocalPlayerRef = useRef<PlayerState | null>(null); // Only for BRUTAL_CLIENT_SIDE_MODE
  const joinedRef = useRef(false);
  const gameStartedRef = useRef(false);
  const sendImmediateInputRef = useRef<() => void>(() => { });
  const netStatsRef = useRef({ lastPacketAt: 0, emaGapMs: 0, jitterMs: 0 });
  const fpsWindowRef = useRef({ startedAt: 0, frames: 0 });
  const pingRef = useRef({ sentAt: 0, emaRttMs: 0 });
  const logSeqRef = useRef(0);
  const lastNetSummaryRef = useRef("");
  const lastHighQueueLogAtRef = useRef(0);

  joinedRef.current = joined;
  gameStartedRef.current = gameStarted;

  useEffect(() => {
    if (window.Usion?._initialized) return;
    window.Usion?.init?.();
  }, []);

  function appendLog(text: string) {
    const ts = new Date().toLocaleTimeString();
    const id = ++logSeqRef.current;
    setLogLines((prev) => {
      const next = [...prev, { id, ts, text }];
      if (next.length > 40) return next.slice(next.length - 40);
      return next;
    });
  }

  useEffect(() => {
    appendLog("Game window initialized");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendControlInput(usion: AnyObj, input: InputPayload, sentAtMs = performance.now()) {
    const isFirePressed = Boolean(input.fire && !lastSentFireRef.current);
    lastSentFireRef.current = Boolean(input.fire);
    const fireSeq = isFirePressed ? (localFireSeqRef.current += 1) : undefined;
    const inputWithTiming: InputPayload = {
      ...input,
      fire_pressed: isFirePressed,
      fire_seq: fireSeq,
      client_sent_at_ms: Date.now(),
    };
    usion.game.realtime("control", inputWithTiming);

    const prevSentAt = lastInputSentAtRef.current || sentAtMs - INPUT_SEND_MS;
    const dtSec = clamp((sentAtMs - prevSentAt) / 1000, 1 / 240, 0.12);
    lastInputSentAtRef.current = sentAtMs;

    const transportSeq = Number(usion?.game?._directSeq || 0);
    if (!BRUTAL_CLIENT_SIDE_MODE && transportSeq > 0) {
      pendingInputsRef.current.push({ transportSeq, payload: inputWithTiming, dtSec });
      if (pendingInputsRef.current.length > MAX_PENDING_INPUTS) {
        pendingInputsRef.current.splice(0, pendingInputsRef.current.length - MAX_PENDING_INPUTS);
      }
    }

    if (!BRUTAL_CLIENT_SIDE_MODE && fireSeq && joinedRef.current && gameStartedRef.current) {
      const myPid = myIdRef.current;
      const ship = myPid ? (worldRef.current?.players?.[myPid]) : null;
      if (myPid && ship?.alive) {
        predictedProjectileSeqRef.current += 1;
        predictedProjectilesRef.current.push(
          makePredictedProjectile(myPid, ship, `pred:${myPid}:${predictedProjectileSeqRef.current}`, fireSeq),
        );
        localFireCooldownMsRef.current = FIRE_COOLDOWN_MS;
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
    fpsWindowRef.current = { startedAt: performance.now(), frames: 0 };
    perfHudTimerRef.current = window.setInterval(() => {
      const now = performance.now();
      const elapsedMs = Math.max(1, now - fpsWindowRef.current.startedAt);
      const fps = Math.round((fpsWindowRef.current.frames * 1000) / elapsedMs);
      fpsWindowRef.current.startedAt = now;
      fpsWindowRef.current.frames = 0;
      setPerfHud({
        fps,
        netGapMs: Math.round(netStatsRef.current.emaGapMs || 0),
        jitterMs: Math.round(netStatsRef.current.jitterMs || 0),
        pendingInputs: pendingInputsRef.current.length,
      });
    }, 500);

    return () => {
      if (perfHudTimerRef.current !== null) {
        window.clearInterval(perfHudTimerRef.current);
        perfHudTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    netDebugTimerRef.current = window.setInterval(() => {
      const game = window.Usion?.game;
      if (!game) {
        setNetDebugHud((prev) => ({ ...prev, mode: "sdk-missing", transport: "-" }));
        return;
      }

      let mode = "idle";
      let transport = "-";
      if (game.directMode) {
        mode = "direct";
        transport = "websocket";
      } else if (game._useProxy) {
        mode = "proxy";
        transport = "rn-bridge";
      } else if (game.socket) {
        mode = "socket.io";
        transport = String(game.socket?.io?.engine?.transport?.name || "socket.io");
      }

      const rttMs = pingRef.current.emaRttMs > 0 ? Math.round(pingRef.current.emaRttMs) : null;
      setNetDebugHud({ mode, transport, rttMs });
      const summary = `${mode}|${transport}|${rttMs ?? "-"}`;
      if (summary !== lastNetSummaryRef.current) {
        lastNetSummaryRef.current = summary;
        appendLog(`Net ${mode}, tx ${transport}, rtt ${rttMs ?? "-"}ms`);
      }
    }, 500);

    return () => {
      if (netDebugTimerRef.current !== null) {
        window.clearInterval(netDebugTimerRef.current);
        netDebugTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const usion = window.Usion;
    if (!usion?.game || !joined || !gameStarted) return;

    pingTimerRef.current = window.setInterval(() => {
      pingRef.current.sentAt = performance.now();
      usion.game.requestSync?.(lastAckSeqRef.current || 0);
    }, 1500);

    return () => {
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    };
  }, [joined, gameStarted]);

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
      if (perfHudTimerRef.current) window.clearInterval(perfHudTimerRef.current);
      if (netDebugTimerRef.current) window.clearInterval(netDebugTimerRef.current);
      if (pingTimerRef.current) window.clearInterval(pingTimerRef.current);
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      predictedProjectilesRef.current = [];
      localFireSeqRef.current = 0;
      pendingInputsRef.current = [];
      localFireCooldownMsRef.current = 0;
      lastRenderAtRef.current = null;
      lastSentFireRef.current = false;
      netStatsRef.current = { lastPacketAt: 0, emaGapMs: 0, jitterMs: 0 };
      pingRef.current = { sentAt: 0, emaRttMs: 0 };
      try { window.Usion?.game?.disconnect?.(); } catch { }
    };
  }, []);

  function renderFrame() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const now = performance.now();
    fpsWindowRef.current.frames += 1;
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
      if (BRUTAL_CLIENT_SIDE_MODE) {
        const serverMe = newestMe || renderState.players[myPid] || undefined;
        const seedMe = brutalLocalPlayerRef.current || serverMe;
        if (seedMe) {
          const nextLocal = (joinedRef.current && gameStartedRef.current)
            ? applyInputToPlayer(seedMe, buildInputFromKeys(keysRef.current), frameDtSec)
            : seedMe;
          brutalLocalPlayerRef.current = { ...nextLocal };
          renderState = {
            ...renderState,
            players: {
              ...renderState.players,
              [myPid]: blendServerAndLocalPlayer(serverMe, nextLocal),
            },
          };
        }
      } else if (newestMe) {
        // ========== CS:GO 2 model: server state + input replay ==========
        // Start from the latest server-confirmed state for our player,
        // then replay all unacknowledged pending inputs deterministically.
        // The result IS our position — no smoothing, no blending.
        let predictedMe: PlayerState;

        if (!newestMe.alive) {
          // Dead — just use the server state, no prediction
          predictedMe = { ...newestMe };
        } else {
          predictedMe = serverReconcilePlayer(newestMe, pendingInputsRef.current);

          // Always extrapolate forward with current input for sub-tick smoothness.
          // Even with zero input, the ship has velocity that must advance each frame
          // to avoid the "freeze then jump" stutter between server updates.
          const unsentMs = clamp(now - lastInputSentAtRef.current, 0, UNSENT_PREDICTION_MAX_MS);
          if (unsentMs > 0) {
            predictedMe = applyInputToPlayer(predictedMe, buildInputFromKeys(keysRef.current), unsentMs / 1000);
          }
        }

        renderState = {
          ...renderState,
          players: {
            ...renderState.players,
            [myPid]: predictedMe,
          },
        };
      }

      predictedProjectilesRef.current = reconcilePredictedProjectiles(
        predictedProjectilesRef.current,
        renderState.projectiles,
        myPid,
      );
      if (BRUTAL_CLIENT_SIDE_MODE && predictedProjectilesRef.current.length > 0) {
        predictedProjectilesRef.current = [];
      }
    } else if (predictedProjectilesRef.current.length > 0) {
      predictedProjectilesRef.current = [];
      localFireCooldownMsRef.current = 0;
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
    if (data.deploy_region || data.sim_hz || data.net_hz) {
      setServerDebugHud({
        region: String(data.deploy_region || "-"),
        simHz: Number.isFinite(Number(data.sim_hz)) ? Number(data.sim_hz) : null,
        netHz: Number.isFinite(Number(data.net_hz)) ? Number(data.net_hz) : null,
      });
    }
    const packetNow = performance.now();
    if (netStatsRef.current.lastPacketAt > 0) {
      const gapMs = packetNow - netStatsRef.current.lastPacketAt;
      const prevEma = netStatsRef.current.emaGapMs || EXPECTED_NET_UPDATE_MS;
      const emaGap = prevEma * 0.85 + gapMs * 0.15;
      const jitterMs = netStatsRef.current.jitterMs * 0.85 + Math.abs(gapMs - emaGap) * 0.15;
      netStatsRef.current.emaGapMs = emaGap;
      netStatsRef.current.jitterMs = jitterMs;
    } else {
      netStatsRef.current.emaGapMs = EXPECTED_NET_UPDATE_MS;
      netStatsRef.current.jitterMs = 0;
    }
    netStatsRef.current.lastPacketAt = packetNow;

    const tick = Number(data.server_tick || 0);
    if (tick > 0) {
      if (tick <= lastNetworkTickRef.current) return;
      lastNetworkTickRef.current = tick;
    }

    const merged = mergeDelta(worldRef.current, data);
    if (!merged) return;

    const myPid = myIdRef.current;
    if (BRUTAL_CLIENT_SIDE_MODE && myPid && brutalLocalPlayerRef.current) {
      merged.players = {
        ...merged.players,
        [myPid]: blendServerAndLocalPlayer(merged.players[myPid], brutalLocalPlayerRef.current),
      };
    }
    worldRef.current = merged;

    if (myPid && !BRUTAL_CLIENT_SIDE_MODE) {
      const ack = Number(data?.ack_seq_by_player?.[myPid] || 0);
      if (ack > lastAckSeqRef.current) {
        lastAckSeqRef.current = ack;
        pendingInputsRef.current = pendingInputsRef.current.filter((ev) => ev.transportSeq > ack);
      }
    } else if (BRUTAL_CLIENT_SIDE_MODE) {
      pendingInputsRef.current = [];
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
    localFireSeqRef.current = 0;
    localFireCooldownMsRef.current = 0;
    lastRenderAtRef.current = null;
    lastSentFireRef.current = false;

    const uid = String(usion.user?.getId?.() || "");
    myIdRef.current = uid;
    setMyId(uid);

    try {
      if (!handlersBoundRef.current) {
        handlersBoundRef.current = true;

        usion.game.onJoined((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          if (data.deploy_region || data.sim_hz || data.net_hz) {
            setServerDebugHud({
              region: String(data.deploy_region || "-"),
              simHz: Number.isFinite(Number(data.sim_hz)) ? Number(data.sim_hz) : null,
              netHz: Number.isFinite(Number(data.net_hz)) ? Number(data.net_hz) : null,
            });
          }
          const joinedPlayerId = String(data?.player_id || "");
          if (joinedPlayerId) {
            myIdRef.current = joinedPlayerId;
            setMyId(joinedPlayerId);
          }
          pendingInputsRef.current = [];
          predictedProjectilesRef.current = [];
          predictedProjectileSeqRef.current = 0;
          localFireSeqRef.current = 0;
          lastAckSeqRef.current = 0;
          lastNetworkTickRef.current = 0;
          lastInputSentAtRef.current = performance.now() - INPUT_SEND_MS;
          localFireCooldownMsRef.current = 0;
          lastSentFireRef.current = false;
          setJoined(true);
          setPlayerCount((data?.player_ids || []).length);
          const waiting = Number(data?.waiting_for || 0);
          appendLog(`Joined room ${String(data?.room_id || activeRoomIdRef.current)} as ${joinedPlayerId || myIdRef.current}`);
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
          if (data.deploy_region || data.sim_hz || data.net_hz) {
            setServerDebugHud({
              region: String(data.deploy_region || "-"),
              simHz: Number.isFinite(Number(data.sim_hz)) ? Number(data.sim_hz) : null,
              netHz: Number.isFinite(Number(data.net_hz)) ? Number(data.net_hz) : null,
            });
          }
          lastInputSentAtRef.current = performance.now() - INPUT_SEND_MS;
          localFireCooldownMsRef.current = 0;
          predictedProjectilesRef.current = [];
          localFireSeqRef.current = 0;
          lastSentFireRef.current = false;
          setGameStarted(true);
          appendLog("Game started");
          setStatus("Fight");
        });

        usion.game.onStateUpdate((data: AnyObj) => {
          onNetworkState(data);
        });

        usion.game.onSync((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          if (data.deploy_region || data.sim_hz || data.net_hz) {
            setServerDebugHud({
              region: String(data.deploy_region || "-"),
              simHz: Number.isFinite(Number(data.sim_hz)) ? Number(data.sim_hz) : null,
              netHz: Number.isFinite(Number(data.net_hz)) ? Number(data.net_hz) : null,
            });
          }
          const sentAt = pingRef.current.sentAt;
          if (sentAt > 0) {
            const sample = performance.now() - sentAt;
            if (sample > 0 && sample < 5000) {
              const prev = pingRef.current.emaRttMs || sample;
              pingRef.current.emaRttMs = prev * 0.75 + sample * 0.25;
              if (sample >= 120) {
                appendLog(`High RTT sample ${Math.round(sample)}ms`);
              }
            }
            pingRef.current.sentAt = 0;
          }
        });

        usion.game.onGameFinished((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          pendingInputsRef.current = [];
          predictedProjectilesRef.current = [];
          localFireSeqRef.current = 0;
          localFireCooldownMsRef.current = 0;
          lastSentFireRef.current = false;
          setGameStarted(false);
          appendLog(`Game finished (${data?.reason || "done"})`);
          setStatus(`Match ended (${data?.reason || "done"})`);
        });

        usion.game.onError((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          const code = String(data?.code || "unknown");
          appendLog(`Server error: ${code}`);
          setStatus(`Server error: ${code}`);
        });
      }

      let lastError: any = null;
      for (let attempt = 1; attempt <= JOIN_RETRY_LIMIT; attempt++) {
        try {
          appendLog(`Connect attempt ${attempt}/${JOIN_RETRY_LIMIT}`);
          try { usion.game.disconnect?.(); } catch { }
          await sleep(100);

          await usion.game.connectDirect();
          appendLog("Direct socket connected");
          const joinRes = await usion.game.join(rid);
          if (joinRes?.error) throw new Error(String(joinRes.error));
          const joinedPlayerId = String(joinRes?.player_id || "");
          if (joinedPlayerId) {
            myIdRef.current = joinedPlayerId;
            setMyId(joinedPlayerId);
          }

          predictedProjectilesRef.current = [];
          predictedProjectileSeqRef.current = 0;
          localFireSeqRef.current = 0;
          localFireCooldownMsRef.current = 0;
          lastInputSentAtRef.current = performance.now() - INPUT_SEND_MS;
          lastSentFireRef.current = false;
          setJoined(true);
          setPlayerCount((joinRes?.player_ids || []).length);
          const waiting = Number(joinRes?.waiting_for || 0);
          appendLog(`Join OK, players ${(joinRes?.player_ids || []).length}/2`);
          setStatus(waiting > 0 ? `Waiting for ${waiting} player(s)...` : "Ready");

          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          const msg = String((err as AnyObj)?.message || err);
          appendLog(`Connect failed: ${msg}`);
          if (!msg.includes("1006") || attempt === JOIN_RETRY_LIMIT) throw err;
          setStatus(`Reconnecting (${attempt}/${JOIN_RETRY_LIMIT})...`);
          await sleep(JOIN_RETRY_BACKOFF_MS * attempt);
        }
      }

      if (lastError) throw lastError;
    } catch (err: any) {
      appendLog(`Connection failed: ${String(err?.message || err)}`);
      setStatus(`Connection failed: ${String(err?.message || err)}`);
    } finally {
      connectGuardRef.current = false;
      setJoining(false);
    }
  }

  useEffect(() => {
    const now = performance.now();
    if (perfHud.pendingInputs >= 8 && now - lastHighQueueLogAtRef.current > 2000) {
      lastHighQueueLogAtRef.current = now;
      appendLog(`Input queue high: q=${perfHud.pendingInputs}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfHud.pendingInputs]);

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
          <div style={{ fontSize: 11, opacity: 0.9, textAlign: "right", lineHeight: 1.35 }}>
            <div>Tick {serverTick}</div>
            <div>FPS {perfHud.fps} | gap {perfHud.netGapMs}ms | jitter {perfHud.jitterMs}ms | q {perfHud.pendingInputs}</div>
            <div>net {netDebugHud.mode} | tx {netDebugHud.transport} | rtt {netDebugHud.rttMs ?? "-"}ms</div>
            <div>srv {serverDebugHud.region} | sim {serverDebugHud.simHz ?? "-"} | net {serverDebugHud.netHz ?? "-"}</div>
          </div>
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

        <div
          style={{
            border: "1px solid rgba(56,189,248,0.2)",
            borderRadius: 8,
            padding: "6px 8px",
            minHeight: 84,
            maxHeight: 120,
            overflowY: "auto",
            background: "rgba(2,6,23,0.65)",
            color: "#93c5fd",
            fontSize: 11,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            lineHeight: 1.35,
          }}
        >
          {logLines.length === 0 ? (
            <div>Logs will appear here...</div>
          ) : (
            logLines.map((line) => (
              <div key={line.id}>[{line.ts}] {line.text}</div>
            ))
          )}
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
  const sx = w / WORLD_SIZE;
  const sy = h / WORLD_SIZE;
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
  for (let i = 10; i < WORLD_SIZE; i += 10) {
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
