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

type WorldState = {
  phase: string;
  tick: number;
  remainingMs: number;
  players: Record<string, PlayerState>;
  projectiles: Array<{ id: string; x: number; y: number }>;
  pickups: Array<{ id: string; x: number; y: number; type?: string }>;
};

type SnapshotFrame = {
  t: number;
  serverTick: number;
  state: WorldState;
};

type InputPayload = { turn: number; thrust: number; fire: boolean };

declare global {
  interface Window {
    Usion?: any;
  }
}

const CANVAS_SIZE = 1000;
const JOIN_RETRY_LIMIT = Number(process.env.NEXT_PUBLIC_JOIN_RETRY_LIMIT || 4);
const JOIN_RETRY_BACKOFF_MS = 600;

const INPUT_SEND_MS = 33;
const INTERP_DELAY_MS = 95;
const UI_TICK_UPDATE_EVERY = 2;

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
    projectiles: (state?.projectiles || []).map((x: AnyObj) => ({ id: String(x.id || ""), x: Number(x.x || 0), y: Number(x.y || 0) })),
    pickups: (state?.pickups || []).map((x: AnyObj) => ({ id: String(x.id || ""), x: Number(x.x || 0), y: Number(x.y || 0), type: String(x.type || "") })),
  };
}

function mergeDelta(base: WorldState | null, data: AnyObj): WorldState | null {
  if (!base) {
    if (!data?.full_state) return null;
    return cloneWorld(data.full_state);
  }

  if (data?.full_state) return cloneWorld(data.full_state);
  if (!data?.changed_entities) return base;

  const changed = data.changed_entities;
  const merged: WorldState = {
    ...base,
    phase: changed.phase !== undefined ? String(changed.phase) : base.phase,
    remainingMs: changed.remainingMs !== undefined ? Number(changed.remainingMs) : base.remainingMs,
    players: changed.players ? cloneWorld({ players: changed.players }).players : base.players,
    projectiles: changed.projectiles
      ? (changed.projectiles as AnyObj[]).map((x) => ({ id: String(x.id || ""), x: Number(x.x || 0), y: Number(x.y || 0) }))
      : base.projectiles,
    pickups: changed.pickups
      ? (changed.pickups as AnyObj[]).map((x) => ({ id: String(x.id || ""), x: Number(x.x || 0), y: Number(x.y || 0), type: String(x.type || "") }))
      : base.pickups,
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
    projectiles: b.projectiles,
    pickups: b.pickups,
  };
}

function applyLocalPrediction(state: WorldState, myId: string, input: InputPayload, dtSec: number): WorldState {
  const me = state.players[myId];
  if (!me || !me.alive) return state;

  const pred = { ...state, players: { ...state.players, [myId]: { ...me } } };
  const p = pred.players[myId];

  p.angle += input.turn * TURN_RATE * dtSec;

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

  return pred;
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

  const inputTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const connectGuardRef = useRef(false);
  const handlersBoundRef = useRef(false);
  const activeRoomIdRef = useRef("");
  const myIdRef = useRef("");
  const lastUiTickRef = useRef(0);
  const lastHudUpdateRef = useRef(0);

  useEffect(() => {
    if (window.Usion?._initialized) return;
    window.Usion?.init?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isControlKey(event)) event.preventDefault();
      const k = event.key.toLowerCase();
      if (k === "w" || event.key === "ArrowUp") keysRef.current.up = true;
      if (k === "s" || event.key === "ArrowDown") keysRef.current.down = true;
      if (k === "a" || event.key === "ArrowLeft") keysRef.current.left = true;
      if (k === "d" || event.key === "ArrowRight") keysRef.current.right = true;
      if (isFireKey(event)) keysRef.current.fire = true;
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (isControlKey(event)) event.preventDefault();
      const k = event.key.toLowerCase();
      if (k === "w" || event.key === "ArrowUp") keysRef.current.up = false;
      if (k === "s" || event.key === "ArrowDown") keysRef.current.down = false;
      if (k === "a" || event.key === "ArrowLeft") keysRef.current.left = false;
      if (k === "d" || event.key === "ArrowRight") keysRef.current.right = false;
      if (isFireKey(event)) keysRef.current.fire = false;
    };

    const onBlur = () => {
      keysRef.current = { up: false, down: false, left: false, right: false, fire: false };
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
  });

  useEffect(() => {
    const usion = window.Usion;
    if (!usion?.game) return;

    if (gameStarted && joined && !inputTimerRef.current) {
      inputTimerRef.current = window.setInterval(() => {
        const input = buildInputFromKeys(keysRef.current);
        usion.game.realtime("control", input);
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
      try { window.Usion?.game?.disconnect?.(); } catch {}
    };
  }, []);

  function renderFrame() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const now = performance.now();
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
      const input = buildInputFromKeys(keysRef.current);
      renderState = applyLocalPrediction(renderState, myPid, input, Math.min(0.12, INTERP_DELAY_MS / 1000));
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

    const merged = mergeDelta(worldRef.current, data);
    if (!merged) return;

    worldRef.current = merged;

    const frame: SnapshotFrame = {
      t: performance.now(),
      serverTick: Number(data.server_tick || 0),
      state: cloneWorld(merged),
    };

    snapshotsRef.current.push(frame);
    if (snapshotsRef.current.length > 40) {
      snapshotsRef.current.splice(0, snapshotsRef.current.length - 40);
    }

    const tick = frame.serverTick;
    if (tick - lastUiTickRef.current >= UI_TICK_UPDATE_EVERY || tick < lastUiTickRef.current) {
      lastUiTickRef.current = tick;
      setServerTick(tick);
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

    const uid = String(usion.user?.getId?.() || "");
    myIdRef.current = uid;
    setMyId(uid);

    try {
      if (!handlersBoundRef.current) {
        handlersBoundRef.current = true;

        usion.game.onJoined((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
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
          setGameStarted(true);
          setStatus("Fight");
        });

        usion.game.onRealtime((data: AnyObj) => {
          if (data?.protocol_version === "2") onNetworkState(data);
        });

        usion.game.onStateUpdate((data: AnyObj) => {
          onNetworkState(data);
        });

        usion.game.onGameFinished((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
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
        overflow: "hidden",
        background: "radial-gradient(circle at 20% 5%, #0b1732 0%, #030712 55%, #01040d 100%)",
        display: "grid",
        placeItems: "center",
        padding: 14,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "min(980px, 100%)",
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
              width: "min(calc(100dvh - 300px), calc(100vw - 64px), 760px)",
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
    ctx.moveTo(12, 0);
    ctx.lineTo(-9, 7);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-9, -7);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    const barW = 32;
    const hp = clamp(p.hp / 100, 0, 1);
    const sh = clamp(p.shield / 60, 0, 1);

    ctx.fillStyle = "rgba(15,23,42,0.8)";
    ctx.fillRect(x - barW / 2, y - 18, barW, 4);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(x - barW / 2, y - 18, barW * hp, 4);

    ctx.fillStyle = "rgba(15,23,42,0.8)";
    ctx.fillRect(x - barW / 2, y - 13, barW, 3);
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(x - barW / 2, y - 13, barW * sh, 3);

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "bold 12px system-ui";
    ctx.fillText(`${pid === myId ? "YOU" : "RIVAL"} W${Math.round(p.weaponLevel)}`, x - 20, y - 24);
  }
}
