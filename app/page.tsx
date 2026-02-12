"use client";

import { useEffect, useRef, useState } from "react";

type AnyObj = Record<string, any>;
type InputEvent = { seq: number; input_type: string; payload: AnyObj; client_ts: number };

declare global {
  interface Window {
    Usion?: any;
  }
}

const WIDTH = 420;
const HEIGHT = 420;
const INPUT_INTERVAL_MS = 50;
const JOIN_RETRY_LIMIT = Number(process.env.NEXT_PUBLIC_JOIN_RETRY_LIMIT || 4);
const JOIN_RETRY_BACKOFF_MS = 700;

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState("Initializing...");
  const [roomId, setRoomId] = useState<string>("");
  const [myId, setMyId] = useState<string>("");
  const [joined, setJoined] = useState(false);
  const [serverTick, setServerTick] = useState(0);
  const [playerCount, setPlayerCount] = useState(0);
  const [waitingFor, setWaitingFor] = useState(0);
  const [gameStarted, setGameStarted] = useState(false);
  const [joining, setJoining] = useState(false);
  const worldRef = useRef<AnyObj | null>(null);
  const predictedRef = useRef<AnyObj | null>(null);
  const pendingInputsRef = useRef<InputEvent[]>([]);
  const keyStateRef = useRef({ up: false, down: false, left: false, right: false, fire: false });
  const seqRef = useRef(0);
  const lastAckRef = useRef(0);
  const inputTimerRef = useRef<number | null>(null);
  const isConnectingRef = useRef(false);
  const handlersBoundRef = useRef(false);
  const activeRoomIdRef = useRef<string>("");

  useEffect(() => {
    const onInit = () => {
      const usion = window.Usion;
      if (usion?._initialized) {
        console.log("[Direct] SDK initialized, config:", usion.config);
      }
    };
    if (window.Usion?._initialized) {
      onInit();
    } else if (window.Usion) {
      window.Usion.init(onInit);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") keyStateRef.current.up = true;
      if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") keyStateRef.current.down = true;
      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") keyStateRef.current.left = true;
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") keyStateRef.current.right = true;
      if (e.key === " ") keyStateRef.current.fire = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") keyStateRef.current.up = false;
      if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") keyStateRef.current.down = false;
      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") keyStateRef.current.left = false;
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") keyStateRef.current.right = false;
      if (e.key === " ") keyStateRef.current.fire = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    const renderLoop = window.setInterval(() => {
      drawWorld(predictedRef.current || worldRef.current, canvasRef.current, myId);
    }, 33);
    return () => window.clearInterval(renderLoop);
  }, [myId]);

  function getConfigRoomId(): string {
    const p = new URLSearchParams(window.location.search);
    const q = p.get("roomId");
    if (q) return q;
    const cfg = window.Usion?.config;
    return cfg?.roomId || "";
  }

  function buildInputFromKeys(): InputEvent {
    const k = keyStateRef.current;
    const turn = k.left ? -1 : k.right ? 1 : 0;
    const thrust = k.up ? 1 : k.down ? -0.4 : 0;
    seqRef.current += 1;
    return {
      seq: seqRef.current,
      input_type: "control",
      client_ts: Date.now(),
      payload: { turn, thrust, fire: k.fire }
    };
  }

  function applyLocalPrediction(input: InputEvent): void {
    const state = predictedRef.current || worldRef.current;
    if (!state || !myId) return;
    const me = state.players?.[myId];
    if (!me || !me.alive) return;
    const dt = INPUT_INTERVAL_MS / 1000;
    const turn = Number(input.payload.turn || 0);
    const thrust = Number(input.payload.thrust || 0);

    // Steering
    me.angle = Number(me.angle || 0) + turn * 4.2 * dt;

    // Speed: always moving forward, W = boost
    const baseSpeed = 8;
    const maxSpeed = 28;
    const targetSpeed = baseSpeed + thrust * (maxSpeed - baseSpeed);
    const curSpeed = Math.hypot(Number(me.vx || 0), Number(me.vy || 0)) || 0.01;
    const newSpeed = curSpeed + (targetSpeed - curSpeed) * 0.15;

    me.vx = Math.cos(me.angle) * newSpeed;
    me.vy = Math.sin(me.angle) * newSpeed;

    me.x = ((Number(me.x || 0) + me.vx * dt) % 100 + 100) % 100;
    me.y = ((Number(me.y || 0) + me.vy * dt) % 100 + 100) % 100;
    predictedRef.current = structuredClone(state);
  }

  function reconcileFromServer(snapshotOrDelta: AnyObj): void {
    const fullState = snapshotOrDelta.full_state;
    if (fullState) {
      worldRef.current = fullState;
    } else if (worldRef.current && snapshotOrDelta.changed_entities) {
      worldRef.current = {
        ...worldRef.current,
        ...snapshotOrDelta.changed_entities,
        players: snapshotOrDelta.changed_entities.players || worldRef.current.players,
        projectiles: snapshotOrDelta.changed_entities.projectiles || worldRef.current.projectiles,
        pickups: snapshotOrDelta.changed_entities.pickups || worldRef.current.pickups
      };
    }
    if (!worldRef.current) return;
    const ack = Number(snapshotOrDelta.ack_seq_by_player?.[myId] || 0);
    lastAckRef.current = Math.max(lastAckRef.current, ack);
    pendingInputsRef.current = pendingInputsRef.current.filter((ev) => ev.seq > lastAckRef.current);
    predictedRef.current = structuredClone(worldRef.current);
    for (const ev of pendingInputsRef.current) applyLocalPrediction(ev);
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function connectAndJoin() {
    if (isConnectingRef.current) return;

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
    setRoomId(rid);
    activeRoomIdRef.current = rid;
    const uid = String(usion.user?.getId?.() || "");
    setMyId(uid);
    setStatus("Connecting to direct server...");
    isConnectingRef.current = true;
    setJoining(true);

    try {
      if (!handlersBoundRef.current) {
        handlersBoundRef.current = true;

        // Setup event handlers once so reload retries do not stack duplicate listeners.
        usion.game.onJoined((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          console.log("[Direct] Joined:", data);
          const pids = data.player_ids || [];
          const waiting = Number(data.waiting_for || 0);
          setJoined(true);
          setPlayerCount(pids.length);
          setWaitingFor(waiting);
          if (waiting > 0) {
            setStatus(`Waiting for ${waiting} more player(s)... (${pids.length}/2)`);
          } else {
            setStatus("All players connected!");
          }
        });

        if (usion.game.onPlayerJoined) {
          usion.game.onPlayerJoined((data: AnyObj) => {
            if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
            console.log("[Direct] Player joined:", data);
            const pids = data.player_ids || [];
            const waiting = data.waiting_for !== undefined
              ? Number(data.waiting_for || 0)
              : Math.max(0, 2 - pids.length);
            setPlayerCount(pids.length);
            setWaitingFor(waiting);
            if (waiting > 0) {
              setStatus(`Player joined! Waiting for ${waiting} more... (${pids.length}/2)`);
            } else {
              setStatus("All players connected! Starting...");
            }
          });
        }

        usion.game.onGameStart((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          console.log("[Direct] Game started!", data);
          setGameStarted(true);
          setPlayerCount((data.player_ids || []).length);
          setWaitingFor(0);
          setStatus("Game started! Fight!");

          if (inputTimerRef.current) window.clearInterval(inputTimerRef.current);
          inputTimerRef.current = window.setInterval(() => {
            const input = buildInputFromKeys();
            pendingInputsRef.current.push(input);
            applyLocalPrediction(input);
            usion.game.realtime("control", input.payload);
          }, INPUT_INTERVAL_MS);
        });

        usion.game.onRealtime((data: AnyObj) => {
          if (data.room_id !== activeRoomIdRef.current) return;
          if (data.protocol_version === "2") {
            setGameStarted(true);
            setServerTick(Number(data.server_tick || 0));
            reconcileFromServer(data);
          }
        });

        usion.game.onStateUpdate((data: AnyObj) => {
          if (data.room_id !== activeRoomIdRef.current) return;
          setGameStarted(true);
          setServerTick(Number(data.server_tick || 0));
          reconcileFromServer(data);
        });

        usion.game.onGameFinished((data: AnyObj) => {
          if (data.room_id !== activeRoomIdRef.current) return;
          setGameStarted(false);
          setStatus(`Match ended (${data.reason || "completed"})`);
        });

        usion.game.onError((data: AnyObj) => {
          if (data.room_id && data.room_id !== activeRoomIdRef.current) return;
          setStatus(`Server error: ${data.code || "unknown"}`);
        });
      }

      let lastErr: any = null;
      for (let attempt = 1; attempt <= JOIN_RETRY_LIMIT; attempt++) {
        console.log("[Direct] connect/join attempt", { attempt, roomId: rid, userId: uid });
        try {
          try { usion.game.disconnect?.(); } catch {}
          await sleep(120);
          await usion.game.connectDirect();
          setStatus("Connected, joining room...");
          const joinResp = await usion.game.join(rid);
          if (joinResp?.error) throw new Error(joinResp.error);

          setJoined(true);
          const pids = joinResp?.player_ids || [];
          const waiting = Number(joinResp?.waiting_for || 0);
          setPlayerCount(pids.length);
          setWaitingFor(waiting);
          if (waiting > 0) {
            setStatus(`Waiting for ${waiting} more player(s)... (${pids.length}/2)`);
          } else {
            setStatus("All players connected!");
          }
          console.log("[Direct] connect/join success", { attempt, roomId: rid, waitingFor: waiting, playerCount: pids.length });
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
          const msg = String(err?.message || err);
          console.warn("[Direct] connect/join attempt failed", { attempt, roomId: rid, error: msg });
          try { usion.game.disconnect?.(); } catch {}
          if (!msg.includes("code=1006") || attempt === JOIN_RETRY_LIMIT) {
            throw err;
          }
          setStatus(`Reconnecting... (${attempt}/${JOIN_RETRY_LIMIT})`);
          await sleep(JOIN_RETRY_BACKOFF_MS * attempt);
        }
      }

      if (lastErr) throw lastErr;
    } catch (err: any) {
      setStatus(`Connection failed: ${err.message || String(err)}`);
      console.error("[Direct] Connection error:", err);
    } finally {
      isConnectingRef.current = false;
      setJoining(false);
    }
  }

  useEffect(() => {
    return () => {
      if (inputTimerRef.current) window.clearInterval(inputTimerRef.current);
      try {
        window.Usion?.game?.disconnect?.();
      } catch {}
    };
  }, []);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{ width: "min(760px, 100%)", display: "grid", gap: 12 }}>
        <h1 style={{ margin: 0 }}>Space Craft (Direct Mode v2)</h1>
        <div style={{ color: "#94a3b8", fontSize: 14 }}>
          Room: {roomId || "unknown"} | Tick: {serverTick} | {joined ? "connected" : "not joined"}
        </div>
        {joined && (
          <div style={{
            display: "flex", alignItems: "center", gap: 12, padding: "8px 12px",
            borderRadius: 8, background: gameStarted ? "#064e3b" : "#1e293b", fontSize: 13,
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              background: gameStarted ? "#34d399" : waitingFor > 0 ? "#fbbf24" : "#34d399",
              animation: waitingFor > 0 ? "pulse 1.5s infinite" : "none",
            }} />
            <span style={{ color: "#e2e8f0" }}>
              {gameStarted
                ? `Game in progress - ${playerCount} players`
                : waitingFor > 0
                  ? `Players: ${playerCount}/2 - Waiting for ${waitingFor} more player(s)...`
                  : `Players: ${playerCount}/2 - Ready!`}
            </span>
          </div>
        )}
        {!joined && (
          <button
            onClick={connectAndJoin}
            disabled={joining}
            style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0" }}
          >
            {joining ? "Connecting..." : "Connect + Join (Direct)"}
          </button>
        )}
        <div style={{ color: "#cbd5e1" }}>{status}</div>
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} style={{ border: "1px solid #1e293b", borderRadius: 8, background: "#030712" }} />
        <div style={{ fontSize: 13, color: "#94a3b8" }}>Controls: W/A/D or Arrow Up/Left/Right, Space to fire.</div>
      </div>
    </main>
  );
}

function drawWorld(world: AnyObj | null, canvas: HTMLCanvasElement | null, myId: string): void {
  if (!world || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#030712";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const sx = canvas.width / 100;
  const sy = canvas.height / 100;
  const players = world.players || {};
  const entries = Object.entries(players) as Array<[string, AnyObj]>;
  for (const [pid, p] of entries) {
    const x = Number(p.x || 0) * sx;
    const y = Number(p.y || 0) * sy;
    const angle = Number(p.angle || 0);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = pid === myId ? "#22d3ee" : "#f59e0b";
    if (!p.alive) ctx.fillStyle = "#64748b";
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, 5);
    ctx.lineTo(-6, -5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "11px sans-serif";
    ctx.fillText(`HP ${p.hp} SH ${Math.floor(Number(p.shield || 0))}`, x - 24, y - 10);
  }

  const projectiles = world.projectiles || [];
  ctx.fillStyle = "#f43f5e";
  for (const proj of projectiles) {
    ctx.beginPath();
    ctx.arc(Number(proj.x || 0) * sx, Number(proj.y || 0) * sy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const pickups = world.pickups || [];
  ctx.fillStyle = "#a3e635";
  for (const pu of pickups) {
    ctx.fillRect(Number(pu.x || 0) * sx - 3, Number(pu.y || 0) * sy - 3, 6, 6);
  }
}
