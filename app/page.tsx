"use client";

import { useEffect, useRef, useState } from "react";

type AnyObj = Record<string, any>;
type InputEvent = { seq: number; input_type: string; payload: AnyObj; client_ts: number };

declare global {
  interface Window {
    Usion?: any;
  }
}

const CANVAS_SIZE = 1100;
const INPUT_INTERVAL_MS = 50;
const JOIN_RETRY_LIMIT = Number(process.env.NEXT_PUBLIC_JOIN_RETRY_LIMIT || 4);
const JOIN_RETRY_BACKOFF_MS = 700;
const UI_TICK_UPDATE_EVERY = 4;

function isFireKey(event: KeyboardEvent): boolean {
  return event.code === "KeyE" || event.key.toLowerCase() === "e";
}

function isControlKey(event: KeyboardEvent): boolean {
  const k = event.key.toLowerCase();
  return (
    k === "w" ||
    k === "a" ||
    k === "s" ||
    k === "d" ||
    event.key.startsWith("Arrow") ||
    isFireKey(event)
  );
}

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
  const myUserIdRef = useRef<string>("");
  const animationFrameRef = useRef<number | null>(null);
  const lastUiTickRef = useRef(0);

  const world = predictedRef.current || worldRef.current;
  const players = Object.entries(world?.players || {}) as Array<[string, AnyObj]>;

  useEffect(() => {
    if (window.Usion?._initialized) {
      return;
    }
    if (window.Usion) {
      window.Usion.init();
    }
  }, []);

  useEffect(() => {
    const resetKeys = () => {
      keyStateRef.current = { up: false, down: false, left: false, right: false, fire: false };
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isControlKey(event)) event.preventDefault();
      const key = event.key.toLowerCase();
      if (event.key === "ArrowUp" || key === "w") keyStateRef.current.up = true;
      if (event.key === "ArrowDown" || key === "s") keyStateRef.current.down = true;
      if (event.key === "ArrowLeft" || key === "a") keyStateRef.current.left = true;
      if (event.key === "ArrowRight" || key === "d") keyStateRef.current.right = true;
      if (isFireKey(event)) keyStateRef.current.fire = true;
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (isControlKey(event)) event.preventDefault();
      const key = event.key.toLowerCase();
      if (event.key === "ArrowUp" || key === "w") keyStateRef.current.up = false;
      if (event.key === "ArrowDown" || key === "s") keyStateRef.current.down = false;
      if (event.key === "ArrowLeft" || key === "a") keyStateRef.current.left = false;
      if (event.key === "ArrowRight" || key === "d") keyStateRef.current.right = false;
      if (isFireKey(event)) keyStateRef.current.fire = false;
    };

    const focusWindow = () => window.focus();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", resetKeys);
    window.addEventListener("pointerdown", focusWindow);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", resetKeys);
      window.removeEventListener("pointerdown", focusWindow);
    };
  }, []);

  useEffect(() => {
    const render = () => {
      drawWorld(predictedRef.current || worldRef.current, canvasRef.current, myId);
      animationFrameRef.current = window.requestAnimationFrame(render);
    };
    animationFrameRef.current = window.requestAnimationFrame(render);
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [myId]);

  useEffect(() => {
    const usion = window.Usion;
    if (!usion?.game) return;

    if (gameStarted && joined && !inputTimerRef.current) {
      inputTimerRef.current = window.setInterval(() => {
        const input = buildInputFromKeys();
        pendingInputsRef.current.push(input);
        applyLocalPrediction(input);
        usion.game.realtime("control", input.payload);
      }, INPUT_INTERVAL_MS);
    }

    if (!gameStarted && inputTimerRef.current) {
      window.clearInterval(inputTimerRef.current);
      inputTimerRef.current = null;
    }
  }, [gameStarted, joined, myId]);

  function getConfigRoomId(): string {
    const params = new URLSearchParams(window.location.search);
    const queryRoomId = params.get("roomId");
    if (queryRoomId) return queryRoomId;
    const cfg = window.Usion?.config;
    return cfg?.roomId || "";
  }

  function buildInputFromKeys(): InputEvent {
    const keys = keyStateRef.current;
    const turn = keys.left ? -1 : keys.right ? 1 : 0;
    const thrust = keys.up ? 1 : keys.down ? -0.4 : 0;
    seqRef.current += 1;
    return {
      seq: seqRef.current,
      input_type: "control",
      client_ts: Date.now(),
      payload: { turn, thrust, fire: keys.fire },
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

    me.angle = Number(me.angle || 0) + turn * 4.2 * dt;

    const baseSpeed = 8;
    const maxSpeed = 28;
    const targetSpeed = baseSpeed + thrust * (maxSpeed - baseSpeed);
    const curSpeed = Math.hypot(Number(me.vx || 0), Number(me.vy || 0)) || 0.01;
    const newSpeed = curSpeed + (targetSpeed - curSpeed) * 0.15;

    me.vx = Math.cos(me.angle) * newSpeed;
    me.vy = Math.sin(me.angle) * newSpeed;

    me.x = ((Number(me.x || 0) + me.vx * dt) % 100 + 100) % 100;
    me.y = ((Number(me.y || 0) + me.vy * dt) % 100 + 100) % 100;
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
        pickups: snapshotOrDelta.changed_entities.pickups || worldRef.current.pickups,
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
    myUserIdRef.current = uid;
    setMyId(uid);
    setStatus("Connecting to direct server...");
    isConnectingRef.current = true;
    setJoining(true);

    try {
      if (!handlersBoundRef.current) {
        handlersBoundRef.current = true;

        usion.game.onJoined((data: AnyObj) => {
          if (data?.room_id && data.room_id !== activeRoomIdRef.current) return;
          const pids = Array.from(new Set((data.player_ids || []).map(String)));
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
            const pids = Array.from(new Set((data.player_ids || []).map(String)));
            const joinedPlayerId = String(data.player_id || "");
            if (joinedPlayerId && joinedPlayerId === myUserIdRef.current && pids.length <= 1) {
              return;
            }
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
          setGameStarted(true);
          setPlayerCount((data.player_ids || []).length);
          setWaitingFor(0);
          setStatus("Game started! Fight!");
        });

        usion.game.onRealtime((data: AnyObj) => {
          if (data.room_id !== activeRoomIdRef.current) return;
          if (data.protocol_version === "2") {
            setGameStarted(true);
            const tick = Number(data.server_tick || 0);
            if (tick - lastUiTickRef.current >= UI_TICK_UPDATE_EVERY || tick < lastUiTickRef.current) {
              lastUiTickRef.current = tick;
              setServerTick(tick);
            }
            reconcileFromServer(data);
          }
        });

        usion.game.onStateUpdate((data: AnyObj) => {
          if (data.room_id !== activeRoomIdRef.current) return;
          setGameStarted(true);
          const tick = Number(data.server_tick || 0);
          if (tick - lastUiTickRef.current >= UI_TICK_UPDATE_EVERY || tick < lastUiTickRef.current) {
            lastUiTickRef.current = tick;
            setServerTick(tick);
          }
          reconcileFromServer(data);
        });

        usion.game.onGameFinished((data: AnyObj) => {
          if (data.room_id !== activeRoomIdRef.current) return;
          setGameStarted(false);
          setStatus(`Match ended (${data.reason || "completed"})`);
        });

        usion.game.onError((data: AnyObj) => {
          if (data.room_id && data.room_id !== activeRoomIdRef.current) return;
          const details = [data.code || "unknown", data.reason, data.expectedGt ? `expected>${data.expectedGt}` : ""]
            .filter(Boolean)
            .join(" | ");
          setStatus(`Server error: ${details}`);
        });
      }

      let lastErr: any = null;
      for (let attempt = 1; attempt <= JOIN_RETRY_LIMIT; attempt++) {
        try {
          try {
            usion.game.disconnect?.();
          } catch {}
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
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
          const msg = String(err?.message || err);
          try {
            usion.game.disconnect?.();
          } catch {}
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
    <main
      style={{
        height: "100dvh",
        overflow: "hidden",
        padding: "16px",
        background:
          "radial-gradient(circle at 20% 10%, #0b1a36 0%, #061229 32%, #020617 100%)",
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "min(980px, 100%)",
          height: "100%",
          display: "grid",
          gridTemplateRows: "auto auto auto auto minmax(0, 1fr) auto",
          gap: 10,
          background: "linear-gradient(180deg, rgba(15,23,42,0.95), rgba(2,6,23,0.96))",
          border: "1px solid rgba(71,85,105,0.5)",
          borderRadius: 16,
          padding: 14,
          boxShadow: "0 18px 45px rgba(2, 6, 23, 0.45)",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ margin: 0, color: "#f8fafc", fontWeight: 800, fontSize: "clamp(1.4rem, 2.5vw, 2rem)" }}>
            Space Craft Arena
          </h1>
          <div style={{ color: "#93c5fd", fontSize: 12, fontWeight: 600 }}>Tick {serverTick}</div>
        </div>

        <div style={{ color: "#93c5fd", fontSize: 13 }}>
          Room: {roomId || "unknown"} | {joined ? "connected" : "not joined"}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderRadius: 10,
            border: "1px solid rgba(71,85,105,0.6)",
            background: gameStarted ? "rgba(6,95,70,0.35)" : "rgba(30,41,59,0.7)",
            color: "#e2e8f0",
            fontSize: 13,
            fontWeight: 600,
            padding: "9px 12px",
          }}
        >
          <div
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: gameStarted ? "#34d399" : waitingFor > 0 ? "#fbbf24" : "#34d399",
              boxShadow: "0 0 12px currentColor",
            }}
          />
          <span>
            {gameStarted
              ? `Fight live - ${playerCount} players active`
              : waitingFor > 0
                ? `Players ${playerCount}/2 - waiting for ${waitingFor}`
                : `Players ${playerCount}/2 - ready`}
          </span>
        </div>

        {!joined ? (
          <button
            onClick={connectAndJoin}
            disabled={joining}
            style={{
              height: 42,
              borderRadius: 10,
              border: "1px solid #2563eb",
              background: "linear-gradient(180deg, #3b82f6, #2563eb)",
              color: "#eff6ff",
              fontWeight: 700,
              fontSize: 14,
              cursor: joining ? "progress" : "pointer",
            }}
          >
            {joining ? "Connecting..." : "Connect + Join"}
          </button>
        ) : (
          <div style={{ color: "#dbeafe", fontSize: 13 }}>{status}</div>
        )}

        <div
          style={{
            minHeight: 0,
            display: "grid",
            placeItems: "center",
            borderRadius: 14,
            border: "1px solid rgba(56, 189, 248, 0.25)",
            background: "linear-gradient(180deg, rgba(2,6,23,0.96), rgba(3,7,18,0.96))",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            style={{
              width: "min(calc(100dvh - 320px), calc(100vw - 70px), 760px)",
              height: "auto",
              aspectRatio: "1 / 1",
              display: "block",
              maxHeight: "100%",
            }}
          />
          {!gameStarted && joined && (
            <div
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                background: "rgba(15,23,42,0.75)",
                border: "1px solid rgba(56,189,248,0.4)",
                color: "#bae6fd",
                borderRadius: 8,
                padding: "6px 8px",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Match starts when both players are ready
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: 12, color: "#93c5fd" }}>
          <span>Move: W/A/D or Arrow keys</span>
          <span>Fire: E</span>
          <span>Weapon boosts: yellow crates (W+)</span>
          {players.map(([pid, p]) => (
            <span
              key={pid}
              style={{
                padding: "4px 8px",
                borderRadius: 999,
                border: "1px solid rgba(71,85,105,0.7)",
                background: pid === myId ? "rgba(6,182,212,0.16)" : "rgba(245,158,11,0.14)",
                color: "#e2e8f0",
              }}
            >
              {pid === myId ? "You" : "Enemy"} HP {Math.round(Number(p.hp || 0))} SH {Math.round(Number(p.shield || 0))} W{Math.max(1, Number(p.weaponLevel || 1))}
            </span>
          ))}
        </div>
      </div>
    </main>
  );
}

function drawWorld(world: AnyObj | null, canvas: HTMLCanvasElement | null, myId: string): void {
  if (!world || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const scaleX = width / 100;
  const scaleY = height / 100;

  const spaceGradient = ctx.createLinearGradient(0, 0, 0, height);
  spaceGradient.addColorStop(0, "#08122a");
  spaceGradient.addColorStop(1, "#030712");
  ctx.fillStyle = spaceGradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(56, 189, 248, 0.08)";
  ctx.lineWidth = 1;
  for (let i = 10; i < 100; i += 10) {
    const gx = i * scaleX;
    const gy = i * scaleY;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(width, gy);
    ctx.stroke();
  }

  const tick = Number(world.tick || 0);
  for (let i = 0; i < 28; i++) {
    const x = ((i * 37) % 100) * scaleX + (((tick + i * 11) % 50) / 50) * 0.6;
    const y = ((i * 53) % 100) * scaleY + (((tick + i * 7) % 50) / 50) * 0.6;
    const alpha = 0.3 + ((tick + i * 13) % 10) * 0.03;
    ctx.fillStyle = `rgba(147, 197, 253, ${alpha})`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }

  const pickups = world.pickups || [];
  for (const pickup of pickups) {
    const px = Number(pickup.x || 0) * scaleX;
    const py = Number(pickup.y || 0) * scaleY;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(((world.tick || 0) * 0.04) % (Math.PI * 2));

    ctx.shadowBlur = 16;
    ctx.shadowColor = "rgba(250, 204, 21, 0.7)";
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(9, 0);
    ctx.lineTo(0, 9);
    ctx.lineTo(-9, 0);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = "#1f2937";
    ctx.fillRect(-4, -1.8, 8, 3.6);
    ctx.restore();

    ctx.fillStyle = "#fde68a";
    ctx.font = "bold 11px system-ui";
    ctx.fillText("W+", px - 9, py - 12);
  }

  const projectiles = world.projectiles || [];
  for (const proj of projectiles) {
    const x = Number(proj.x || 0) * scaleX;
    const y = Number(proj.y || 0) * scaleY;
    ctx.shadowBlur = 14;
    ctx.shadowColor = "rgba(244, 63, 94, 0.9)";
    ctx.fillStyle = "#fb7185";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  const players = world.players || {};
  const entries = Object.entries(players) as Array<[string, AnyObj]>;
  for (const [pid, player] of entries) {
    const x = Number(player.x || 0) * scaleX;
    const y = Number(player.y || 0) * scaleY;
    const angle = Number(player.angle || 0);
    const hp = Math.max(0, Number(player.hp || 0));
    const shield = Math.max(0, Number(player.shield || 0));
    const weaponLevel = Math.max(1, Number(player.weaponLevel || 1));

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    if (player.alive) {
      ctx.fillStyle = pid === myId ? "#22d3ee" : "#f59e0b";
      ctx.shadowBlur = 18;
      ctx.shadowColor = pid === myId ? "rgba(34,211,238,0.8)" : "rgba(245,158,11,0.8)";
    } else {
      ctx.fillStyle = "#64748b";
      ctx.shadowBlur = 0;
    }

    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-10, 8);
    ctx.lineTo(-7, 0);
    ctx.lineTo(-10, -8);
    ctx.closePath();
    ctx.fill();

    const velocity = Math.hypot(Number(player.vx || 0), Number(player.vy || 0));
    if (player.alive && velocity > 10) {
      ctx.fillStyle = "rgba(125, 211, 252, 0.95)";
      ctx.beginPath();
      ctx.moveTo(-9, 0);
      ctx.lineTo(-17, 3.5);
      ctx.lineTo(-17, -3.5);
      ctx.closePath();
      ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.restore();

    const barY = y - 18;
    const hpWidth = 32;
    ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
    ctx.fillRect(x - hpWidth / 2, barY, hpWidth, 4);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(x - hpWidth / 2, barY, (hp / 100) * hpWidth, 4);

    ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
    ctx.fillRect(x - hpWidth / 2, barY + 5, hpWidth, 3);
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(x - hpWidth / 2, barY + 5, (shield / 60) * hpWidth, 3);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 12px system-ui";
    const label = pid === myId ? "YOU" : "RIVAL";
    ctx.fillText(`${label} W${weaponLevel}`, x - 20, y - 26);
  }
}
