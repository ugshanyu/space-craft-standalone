"use client";

import { useEffect, useRef, useState } from "react";

type AnyObj = Record<string, any>;
type InputEvent = { seq: number; payload: AnyObj };

declare global {
  interface Window {
    Usion?: any;
  }
}

/* ───── Constants (Must match server/game.js) ───── */
const ACCEL = 60.0;
const DRAG = 0.94;
const TURN_RATE = 5.5;
const MAX_SPEED = 35.0;
const SERVER_TICK_HZ = 20;
const SERVER_DT = 1 / SERVER_TICK_HZ;

const CANVAS_SIZE = 1100;
const INPUT_SEND_MS = 16; // 60Hz input for minimal latency
const UI_REFRESH_MS = 200;

/* ───── Physics Helper ───── */
function simPlayer(p: AnyObj, turn: number, thrust: number, dt: number) {
  // 1. Rotation
  p.angle += turn * TURN_RATE * dt;

  // 2. Acceleration
  if (thrust > 0) {
    p.vx += Math.cos(p.angle) * ACCEL * thrust * dt;
    p.vy += Math.sin(p.angle) * ACCEL * thrust * dt;
  }

  // 3. Friction
  const dragFactor = Math.pow(DRAG, dt);
  p.vx *= dragFactor;
  p.vy *= dragFactor;

  // 4. Speed Cap
  const speed = Math.hypot(p.vx, p.vy);
  if (speed > MAX_SPEED) {
    const ratio = MAX_SPEED / speed;
    p.vx *= ratio;
    p.vy *= ratio;
  }

  // 5. Move & Wrap
  p.x = ((p.x + p.vx * dt) % 100 + 100) % 100;
  p.y = ((p.y + p.vy * dt) % 100 + 100) % 100;
}

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /* ── State ── */
  const [status, setStatus] = useState("Initializing...");
  const [roomId, setRoomId] = useState("");
  const [displayId, setDisplayId] = useState("");
  const [joined, setJoined] = useState(false);
  const [serverTick, setServerTick] = useState(0);
  const [playerCount, setPlayerCount] = useState(0);
  const [waitingFor, setWaitingFor] = useState(0);
  const [gameStarted, setGameStarted] = useState(false);
  const [joining, setJoining] = useState(false);
  const [uiPlayers, setUiPlayers] = useState<[string, AnyObj][]>([]);

  /* ── Refs ── */
  const worldRef = useRef<AnyObj | null>(null); // Last server state
  const renderRef = useRef<AnyObj | null>(null); // Current simulated state
  const pendingRef = useRef<InputEvent[]>([]);
  const keysRef = useRef({ up: false, down: false, left: false, right: false, fire: false });
  const seqRef = useRef(0);
  const myIdRef = useRef("");
  const lastFrameMs = useRef(performance.now());
  const lastServerMs = useRef(performance.now());

  /* ── SDK Init ── */
  useEffect(() => {
    window.Usion?.init?.();
  }, []);

  /* ── Controls ── */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w" || e.key === "ArrowUp") keysRef.current.up = true;
      if (k === "s" || e.key === "ArrowDown") keysRef.current.down = true;
      if (k === "a" || e.key === "ArrowLeft") keysRef.current.left = true;
      if (k === "d" || e.key === "ArrowRight") keysRef.current.right = true;
      if (k === "e") keysRef.current.fire = true;
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w" || e.key === "ArrowUp") keysRef.current.up = false;
      if (k === "s" || e.key === "ArrowDown") keysRef.current.down = false;
      if (k === "a" || e.key === "ArrowLeft") keysRef.current.left = false;
      if (k === "d" || e.key === "ArrowRight") keysRef.current.right = false;
      if (k === "e") keysRef.current.fire = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  /* ── Render Loop (60fps) ── */
  useEffect(() => {
    const render = () => {
      const now = performance.now();
      const dt = Math.min((now - lastFrameMs.current) / 1000, 0.1);
      lastFrameMs.current = now;

      const state = renderRef.current;
      if (state && gameStarted && myIdRef.current) {
        const me = state.players[myIdRef.current];
        if (me?.alive) {
          const k = keysRef.current;
          simPlayer(me, k.left ? -1 : k.right ? 1 : 0, k.up ? 1 : 0, dt);
        }
      }

      const dtRemote = (now - lastServerMs.current) / 1000;
      drawWorld(state, canvasRef.current, myIdRef.current, dtRemote);
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }, [gameStarted]);

  /* ── Input Loop (60Hz) ── */
  useEffect(() => {
    const interval = setInterval(() => {
      if (!gameStarted || !joined) return;
      const k = keysRef.current;
      seqRef.current++;
      const payload = {
        turn: k.left ? -1 : k.right ? 1 : 0,
        thrust: k.up ? 1 : 0,
        fire: k.fire,
      };
      pendingRef.current.push({ seq: seqRef.current, payload });
      window.Usion?.game?.realtime("control", payload);
    }, INPUT_SEND_MS);
    return () => clearInterval(interval);
  }, [gameStarted, joined]);

  /* ── UI Sync Loop ── */
  useEffect(() => {
    const interval = setInterval(() => {
      const s = renderRef.current || worldRef.current;
      if (s?.players) setUiPlayers(Object.entries(s.players));
    }, UI_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  /* ── Reconciliation ── */
  function reconcile(data: AnyObj) {
    const full = data.full_state;
    if (full) worldRef.current = full;
    else if (worldRef.current && data.changed_entities) {
      worldRef.current = { ...worldRef.current, ...data.changed_entities };
    }
    if (!worldRef.current) return;

    const myId = myIdRef.current;
    const ack = data.ack_seq_by_player?.[myId] || 0;
    pendingRef.current = pendingRef.current.filter(e => e.seq > ack);

    // Re-simulate from server baseline
    const rs = JSON.parse(JSON.stringify(worldRef.current));
    for (const ev of pendingRef.current) {
      const me = rs.players[myId];
      if (me?.alive) simPlayer(me, ev.payload.turn, ev.payload.thrust, SERVER_DT);
    }
    renderRef.current = rs;
    lastServerMs.current = performance.now();
    setServerTick(data.server_tick || 0);
  }

  /* ── Networking ── */
  async function connect() {
    const usion = window.Usion;
    const rid = new URLSearchParams(window.location.search).get("roomId") || usion?.config?.roomId;
    if (!rid) return setStatus("Missing Room ID");

    setRoomId(rid);
    const uid = String(usion?.user?.getId?.() || "");
    myIdRef.current = uid;
    setDisplayId(uid);
    setJoining(true);

    try {
      usion.game.onRealtime((d: AnyObj) => reconcile(d));
      usion.game.onStateUpdate((d: AnyObj) => reconcile(d));
      usion.game.onJoined(() => setJoined(true));
      usion.game.onGameStart(() => setGameStarted(true));

      await usion.game.connectDirect();
      await usion.game.join(rid);
      setStatus("Connected!");
    } catch (e: any) {
      setStatus("Error: " + e.message);
    } finally {
      setJoining(false);
    }
  }

  return (
    <main style={{ height: "100dvh", background: "#020617", display: "grid", placeItems: "center" }}>
      <div style={{ width: "min(900px, 95vw)", background: "#0f172a", borderRadius: 16, padding: 20, color: "#f8fafc" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <h1 style={{ margin: 0 }}>Space Craft</h1>
          <div>Tick: {serverTick}</div>
        </div>
        
        {!joined ? (
          <button onClick={connect} disabled={joining} style={{ width: "100%", padding: 12, borderRadius: 8, background: "#2563eb", color: "#fff", cursor: "pointer" }}>
            {joining ? "Connecting..." : "Join Game"}
          </button>
        ) : (
          <div style={{ marginBottom: 10 }}>{status}</div>
        )}

        <div style={{ position: "relative", background: "#000", borderRadius: 12, overflow: "hidden" }}>
          <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} style={{ width: "100%", height: "auto", display: "block" }} />
        </div>

        <div style={{ marginTop: 15, display: "flex", gap: 10, fontSize: 13, color: "#94a3b8" }}>
          {uiPlayers.map(([pid, p]) => (
            <div key={pid} style={{ padding: "4px 10px", borderRadius: 20, border: "1px solid #334155" }}>
              {pid === displayId ? "YOU" : "ENEMY"}: HP {Math.round(p.hp)} | W{p.weaponLevel}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function drawWorld(world: AnyObj | null, canvas: HTMLCanvasElement | null, myId: string, dtRemote: number) {
  if (!world || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const s = W / 100;

  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, W, H);

  // Players
  for (const [pid, p] of Object.entries(world.players) as any) {
    const isMe = pid === myId;
    let x = p.x;
    let y = p.y;
    
    // Extrapolate others, keep local where it is
    if (!isMe) {
      x = ((x + p.vx * dtRemote) % 100 + 100) % 100;
      y = ((y + p.vy * dtRemote) % 100 + 100) % 100;
    }

    ctx.save();
    ctx.translate(x * s, y * s);
    ctx.rotate(p.angle);
    ctx.fillStyle = isMe ? "#22d3ee" : "#f59e0b";
    
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(-10, 10);
    ctx.lineTo(-10, -10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Health Bar
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(x * s - 20, y * s - 25, 40, 5);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(x * s - 20, y * s - 25, (p.hp / 100) * 40, 5);
  }

  // Projectiles
  ctx.fillStyle = "#fb7185";
  for (const proj of world.projectiles || []) {
    const px = ((proj.x + proj.vx * dtRemote) % 100 + 100) % 100;
    const py = ((proj.y + proj.vy * dtRemote) % 100 + 100) % 100;
    ctx.beginPath();
    ctx.arc(px * s, py * s, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pickups
  ctx.fillStyle = "#facc15";
  for (const pk of world.pickups || []) {
    ctx.fillRect(pk.x * s - 6, pk.y * s - 6, 12, 12);
  }
}
