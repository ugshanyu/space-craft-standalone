"use client";

import { useEffect, useRef, useState } from "react";

type AnyObj = Record<string, any>;
type InputEvent = { seq: number; payload: AnyObj; client_ts: number };

declare global {
  interface Window {
    Usion?: any;
  }
}

/* ───── constants ───── */
const CANVAS_SIZE = 1100;
const INPUT_SEND_MS = 16; // ~60 Hz input send rate for tighter steering sync
const JOIN_RETRY_LIMIT = Number(process.env.NEXT_PUBLIC_JOIN_RETRY_LIMIT || 4);
const JOIN_RETRY_BACKOFF_MS = 700;
const UI_REFRESH_MS = 250; // React UI refresh rate (~4 Hz)

// Physics – MUST match server/game.js
const TURN_RATE = 4.2;
const BASE_SPEED = 8;
const MAX_SPEED = 28;
const EASE_FACTOR = 0.15;
const SERVER_DT = 0.05; // 50 ms server tick

/* ───── helpers ───── */

function isFireKey(e: KeyboardEvent) {
  return e.code === "KeyE" || e.key.toLowerCase() === "e";
}

function isControlKey(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  return k === "w" || k === "a" || k === "s" || k === "d" || e.key.startsWith("Arrow") || isFireKey(e);
}

/** Frame-rate-independent ease that matches the 20 Hz server physics. */
function ease(dt: number) {
  return 1 - Math.pow(1 - EASE_FACTOR, dt / SERVER_DT);
}

function wrap100(v: number) {
  return ((v % 100) + 100) % 100;
}

function wrapDelta100(from: number, to: number) {
  let d = to - from;
  if (d > 50) d -= 100;
  if (d < -50) d += 100;
  return d;
}

function blendAngle(from: number, to: number, alpha: number) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * alpha;
}

/** Fast shallow clone of game state — much cheaper than structuredClone. */
function cloneState(s: AnyObj): AnyObj {
  const players: AnyObj = {};
  for (const pid of Object.keys(s.players)) {
    const p = s.players[pid];
    players[pid] = { ...p, stats: { ...p.stats } };
  }
  return {
    ...s,
    players,
    projectiles: s.projectiles.map((p: AnyObj) => ({ ...p })),
    pickups: s.pickups.map((p: AnyObj) => ({ ...p })),
  };
}

/** Advance one player by dt seconds using the given turn/thrust. */
function simPlayer(me: AnyObj, turn: number, thrust: number, dt: number) {
  me.angle += turn * TURN_RATE * dt;
  const target = BASE_SPEED + thrust * (MAX_SPEED - BASE_SPEED);
  const cur = Math.hypot(me.vx || 0, me.vy || 0) || 0.01;
  const speed = cur + (target - cur) * ease(dt);
  me.vx = Math.cos(me.angle) * speed;
  me.vy = Math.sin(me.angle) * speed;
  me.x = ((me.x + me.vx * dt) % 100 + 100) % 100;
  me.y = ((me.y + me.vy * dt) % 100 + 100) % 100;
}

/* ═══════════════════════════════════════════════════════ */

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /* ── React state (UI shell, updated at low Hz) ── */
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

  /* ── Refs (hot game-loop path, full frequency) ── */
  const worldRef = useRef<AnyObj | null>(null); // authoritative server state
  const renderRef = useRef<AnyObj | null>(null); // continuously simulated draw state
  const pendingRef = useRef<InputEvent[]>([]);
  const keysRef = useRef({ up: false, down: false, left: false, right: false, fire: false });
  const seqRef = useRef(0);
  const lastAckRef = useRef(0);
  const inputTimerRef = useRef<number | null>(null);
  const uiTimerRef = useRef<number | null>(null);
  const connectingRef = useRef(false);
  const boundRef = useRef(false);
  const roomIdRef = useRef("");
  const myIdRef = useRef("");
  const animRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const joinedRef = useRef(false);
  const lastServerMs = useRef(performance.now());
  const lastFrameMs = useRef(performance.now());
  const serverTickRef = useRef(0);
  const lastFrameKeyRef = useRef("");

  /* ── SDK init ── */
  useEffect(() => {
    if (window.Usion?._initialized) return;
    window.Usion?.init?.();
  }, []);

  /* ── Keyboard ── */
  useEffect(() => {
    const reset = () => {
      keysRef.current = { up: false, down: false, left: false, right: false, fire: false };
    };
    const down = (e: KeyboardEvent) => {
      if (isControlKey(e)) e.preventDefault();
      const k = e.key.toLowerCase();
      if (e.key === "ArrowUp" || k === "w") keysRef.current.up = true;
      if (e.key === "ArrowDown" || k === "s") keysRef.current.down = true;
      if (e.key === "ArrowLeft" || k === "a") keysRef.current.left = true;
      if (e.key === "ArrowRight" || k === "d") keysRef.current.right = true;
      if (isFireKey(e)) keysRef.current.fire = true;
    };
    const up = (e: KeyboardEvent) => {
      if (isControlKey(e)) e.preventDefault();
      const k = e.key.toLowerCase();
      if (e.key === "ArrowUp" || k === "w") keysRef.current.up = false;
      if (e.key === "ArrowDown" || k === "s") keysRef.current.down = false;
      if (e.key === "ArrowLeft" || k === "a") keysRef.current.left = false;
      if (e.key === "ArrowRight" || k === "d") keysRef.current.right = false;
      if (isFireKey(e)) keysRef.current.fire = false;
    };
    const focus = () => window.focus();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    window.addEventListener("pointerdown", focus);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pointerdown", focus);
    };
  }, []);

  /* ══════════ 60 fps render loop ══════════
   * Local player is advanced every frame using current key state.
   * Remote players + projectiles are extrapolated from last server snapshot.
   */
  useEffect(() => {
    lastFrameMs.current = performance.now();

    const render = () => {
      const now = performance.now();
      const dt = Math.min((now - lastFrameMs.current) / 1000, 0.1);
      lastFrameMs.current = now;

      // Advance local player at render framerate — zero-delay movement
      const state = renderRef.current;
      if (state && startedRef.current && myIdRef.current) {
        const me = state.players?.[myIdRef.current];
        if (me?.alive) {
          const k = keysRef.current;
          simPlayer(
            me,
            k.left ? -1 : k.right ? 1 : 0,
            k.up ? 1 : k.down ? -0.4 : 0,
            dt,
          );
        }
      }

      const dtRemote = Math.min((now - lastServerMs.current) / 1000, 0.15);
      drawWorld(state, canvasRef.current, myIdRef.current, dtRemote);
      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    };
  }, []);

  /* ══════════ Input send interval (~30 Hz) ══════════ */
  useEffect(() => {
    const usion = window.Usion;
    if (!usion?.game) return;

    if (gameStarted && joined && !inputTimerRef.current) {
      inputTimerRef.current = window.setInterval(() => {
        if (!startedRef.current) return;
        const k = keysRef.current;
        seqRef.current++;
        const input: InputEvent = {
          seq: seqRef.current,
          client_ts: Date.now(),
          payload: {
            turn: k.left ? -1 : k.right ? 1 : 0,
            thrust: k.up ? 1 : k.down ? -0.4 : 0,
            fire: k.fire,
          },
        };
        pendingRef.current.push(input);
        usion.game.realtime("control", input.payload);
      }, INPUT_SEND_MS);
    }

    if (!gameStarted && inputTimerRef.current) {
      clearInterval(inputTimerRef.current);
      inputTimerRef.current = null;
    }
  }, [gameStarted, joined]);

  /* ══════════ Low-frequency UI refresh ══════════ */
  useEffect(() => {
    if (gameStarted && !uiTimerRef.current) {
      uiTimerRef.current = window.setInterval(() => {
        setServerTick(serverTickRef.current);
        const s = renderRef.current || worldRef.current;
        if (s?.players) {
          setUiPlayers(Object.entries(s.players) as [string, AnyObj][]);
        }
      }, UI_REFRESH_MS);
    }
    if (!gameStarted && uiTimerRef.current) {
      clearInterval(uiTimerRef.current);
      uiTimerRef.current = null;
    }
    return () => {
      if (uiTimerRef.current) {
        clearInterval(uiTimerRef.current);
        uiTimerRef.current = null;
      }
    };
  }, [gameStarted]);

  /* ══════════ Server reconciliation ══════════ */
  function reconcile(data: AnyObj) {
    const full = data.full_state;
    if (full) {
      worldRef.current = full;
    } else if (worldRef.current && data.changed_entities) {
      const w = worldRef.current;
      const ce = data.changed_entities;
      worldRef.current = {
        ...w,
        ...ce,
        players: ce.players || w.players,
        projectiles: ce.projectiles || w.projectiles,
        pickups: ce.pickups || w.pickups,
      };
    }
    if (!worldRef.current) return;

    const id = myIdRef.current;
    const ack = Number(data.ack_seq_by_player?.[id] || 0);
    lastAckRef.current = Math.max(lastAckRef.current, ack);
    pendingRef.current = pendingRef.current.filter((e) => e.seq > lastAckRef.current);

    // Rebuild render state from authoritative + replay pending inputs
    const rs = cloneState(worldRef.current);
    for (const ev of pendingRef.current) {
      const me = rs.players?.[id];
      if (me?.alive) {
        simPlayer(me, Number(ev.payload.turn || 0), Number(ev.payload.thrust || 0), SERVER_DT);
      }
    }

    // Smooth local reconciliation: keep visual continuity and avoid snap-back jitter.
    const prevLocal = renderRef.current?.players?.[id];
    const nextLocal = rs.players?.[id];
    if (prevLocal?.alive && nextLocal?.alive) {
      const dx = wrapDelta100(prevLocal.x, nextLocal.x);
      const dy = wrapDelta100(prevLocal.y, nextLocal.y);
      const posErr = Math.hypot(dx, dy);
      const alpha = posErr > 10 ? 1 : 0.22;

      nextLocal.x = wrap100(prevLocal.x + dx * alpha);
      nextLocal.y = wrap100(prevLocal.y + dy * alpha);
      nextLocal.angle = blendAngle(Number(prevLocal.angle || 0), Number(nextLocal.angle || 0), alpha);
      nextLocal.vx = Number(prevLocal.vx || 0) + (Number(nextLocal.vx || 0) - Number(prevLocal.vx || 0)) * alpha;
      nextLocal.vy = Number(prevLocal.vy || 0) + (Number(nextLocal.vy || 0) - Number(prevLocal.vy || 0)) * alpha;
    }

    renderRef.current = rs;
    lastServerMs.current = performance.now();
  }

  /* ──────── connect & join ──────── */

  function getConfigRoomId(): string {
    const params = new URLSearchParams(window.location.search);
    return params.get("roomId") || window.Usion?.config?.roomId || "";
  }

  async function sleep(ms: number) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async function connectAndJoin() {
    if (connectingRef.current) return;
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
    roomIdRef.current = rid;
    const uid = String(usion.user?.getId?.() || "");
    myIdRef.current = uid;
    setDisplayId(uid);
    setStatus("Connecting to direct server...");
    connectingRef.current = true;
    setJoining(true);

    try {
      if (!boundRef.current) {
        boundRef.current = true;

        usion.game.onJoined((d: AnyObj) => {
          if (d?.room_id && d.room_id !== roomIdRef.current) return;
          const pids = Array.from(new Set((d.player_ids || []).map(String)));
          const w = Number(d.waiting_for || 0);
          setJoined(true);
          joinedRef.current = true;
          setPlayerCount(pids.length);
          setWaitingFor(w);
          setStatus(
            w > 0
              ? `Waiting for ${w} more player(s)... (${pids.length}/2)`
              : "All players connected!",
          );
        });

        usion.game.onPlayerJoined?.((d: AnyObj) => {
          if (d?.room_id && d.room_id !== roomIdRef.current) return;
          const pids = Array.from(new Set((d.player_ids || []).map(String)));
          const jp = String(d.player_id || "");
          if (jp && jp === myIdRef.current && pids.length <= 1) return;
          const w =
            d.waiting_for !== undefined
              ? Number(d.waiting_for || 0)
              : Math.max(0, 2 - pids.length);
          setPlayerCount(pids.length);
          setWaitingFor(w);
          setStatus(
            w > 0
              ? `Player joined! Waiting for ${w} more... (${pids.length}/2)`
              : "All players connected! Starting...",
          );
        });

        usion.game.onGameStart((d: AnyObj) => {
          if (d?.room_id && d.room_id !== roomIdRef.current) return;
          setGameStarted(true);
          startedRef.current = true;
          setPlayerCount((d.player_ids || []).length);
          setWaitingFor(0);
          setStatus("Game started! Fight!");
        });

        usion.game.onRealtime((d: AnyObj) => {
          if (d.room_id !== roomIdRef.current) return;
          if (d.protocol_version === "2") {
            const frameKey = `${d.server_tick || 0}:${d.server_ts || 0}`;
            if (frameKey === lastFrameKeyRef.current) return;
            lastFrameKeyRef.current = frameKey;
            if (!startedRef.current) {
              setGameStarted(true);
              startedRef.current = true;
            }
            serverTickRef.current = Number(d.server_tick || 0);
            reconcile(d);
          }
        });

        usion.game.onStateUpdate((d: AnyObj) => {
          if (d.room_id !== roomIdRef.current) return;
          const frameKey = `${d.server_tick || 0}:${d.server_ts || 0}`;
          if (frameKey === lastFrameKeyRef.current) return;
          lastFrameKeyRef.current = frameKey;
          if (!startedRef.current) {
            setGameStarted(true);
            startedRef.current = true;
          }
          serverTickRef.current = Number(d.server_tick || 0);
          reconcile(d);
        });

        usion.game.onGameFinished((d: AnyObj) => {
          if (d.room_id !== roomIdRef.current) return;
          setGameStarted(false);
          startedRef.current = false;
          setStatus(`Match ended (${d.reason || "completed"})`);
        });

        usion.game.onError((d: AnyObj) => {
          if (d.room_id && d.room_id !== roomIdRef.current) return;
          const details = [
            d.code || "unknown",
            d.reason,
            d.expectedGt ? `expected>${d.expectedGt}` : "",
          ]
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
          const jr = await usion.game.join(rid);
          if (jr?.error) throw new Error(jr.error);

          setJoined(true);
          joinedRef.current = true;
          const pids = jr?.player_ids || [];
          const w = Number(jr?.waiting_for || 0);
          setPlayerCount(pids.length);
          setWaitingFor(w);
          setStatus(
            w > 0
              ? `Waiting for ${w} more player(s)... (${pids.length}/2)`
              : "All players connected!",
          );
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
          try {
            usion.game.disconnect?.();
          } catch {}
          if (
            !String(err?.message || err).includes("code=1006") ||
            attempt === JOIN_RETRY_LIMIT
          ) {
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
      connectingRef.current = false;
      setJoining(false);
    }
  }

  /* ── Cleanup ── */
  useEffect(() => {
    return () => {
      if (inputTimerRef.current) clearInterval(inputTimerRef.current);
      if (uiTimerRef.current) clearInterval(uiTimerRef.current);
      try {
        window.Usion?.game?.disconnect?.();
      } catch {}
    };
  }, []);

  /* ═══════════ JSX ═══════════ */
  const players = uiPlayers;
  const myIdDisplay = displayId;

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
          background:
            "linear-gradient(180deg, rgba(15,23,42,0.95), rgba(2,6,23,0.96))",
          border: "1px solid rgba(71,85,105,0.5)",
          borderRadius: 16,
          padding: 14,
          boxShadow: "0 18px 45px rgba(2, 6, 23, 0.45)",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
          }}
        >
          <h1
            style={{
              margin: 0,
              color: "#f8fafc",
              fontWeight: 800,
              fontSize: "clamp(1.4rem, 2.5vw, 2rem)",
            }}
          >
            Space Craft Arena
          </h1>
          <div style={{ color: "#93c5fd", fontSize: 12, fontWeight: 600 }}>
            Tick {serverTick}
          </div>
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
            background: gameStarted
              ? "rgba(6,95,70,0.35)"
              : "rgba(30,41,59,0.7)",
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
              background: gameStarted
                ? "#34d399"
                : waitingFor > 0
                  ? "#fbbf24"
                  : "#34d399",
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
            background:
              "linear-gradient(180deg, rgba(2,6,23,0.96), rgba(3,7,18,0.96))",
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

        <div
          style={{
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
            alignItems: "center",
            fontSize: 12,
            color: "#93c5fd",
          }}
        >
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
                background:
                  pid === myIdDisplay
                    ? "rgba(6,182,212,0.16)"
                    : "rgba(245,158,11,0.14)",
                color: "#e2e8f0",
              }}
            >
              {pid === myIdDisplay ? "You" : "Enemy"} HP{" "}
              {Math.round(Number(p.hp || 0))} SH{" "}
              {Math.round(Number(p.shield || 0))} W
              {Math.max(1, Number(p.weaponLevel || 1))}
            </span>
          ))}
        </div>
      </div>
    </main>
  );
}

/* ═══════════════════════════════════════════════════
 *  Canvas renderer
 *  Local player position is already advanced every frame in the render loop,
 *  so it's drawn as-is. Remote entities are extrapolated from last server
 *  update using their velocity.
 * ═══════════════════════════════════════════════════ */

function drawWorld(
  world: AnyObj | null,
  canvas: HTMLCanvasElement | null,
  myId: string,
  dtRemote: number,
): void {
  if (!world || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const sx = W / 100;
  const sy = H / 100;
  const safeDt = Math.min(dtRemote, 0.15);

  // Background — solid fill is cheaper than gradient at 60 fps
  ctx.fillStyle = "#060e1f";
  ctx.fillRect(0, 0, W, H);

  // Grid — batch into a single path
  ctx.strokeStyle = "rgba(56, 189, 248, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 10; i < 100; i += 10) {
    const gx = i * sx;
    const gy = i * sy;
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, H);
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
  }
  ctx.stroke();

  // Stars — static pattern (no per-tick jitter)
  ctx.fillStyle = "rgba(147, 197, 253, 0.35)";
  for (let i = 0; i < 28; i++) {
    ctx.fillRect(((i * 37) % 100) * sx, ((i * 53) % 100) * sy, 1.5, 1.5);
  }

  // Pickups
  for (const pickup of world.pickups || []) {
    const px = Number(pickup.x || 0) * sx;
    const py = Number(pickup.y || 0) * sy;

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

  // Projectiles — batch shadow state
  ctx.shadowBlur = 14;
  ctx.shadowColor = "rgba(244, 63, 94, 0.9)";
  ctx.fillStyle = "#fb7185";
  for (const proj of world.projectiles || []) {
    let px =
      (Number(proj.x || 0) + Number(proj.vx || 0) * safeDt) % 100;
    let py =
      (Number(proj.y || 0) + Number(proj.vy || 0) * safeDt) % 100;
    if (px < 0) px += 100;
    if (py < 0) py += 100;
    ctx.beginPath();
    ctx.arc(px * sx, py * sy, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // Players
  const entries = Object.entries(world.players || {}) as [string, AnyObj][];
  for (const [pid, player] of entries) {
    const isMe = pid === myId;

    // Local player: position already advanced in render loop
    // Remote player: extrapolate from last server snapshot
    let px: number, py: number;
    if (isMe) {
      px = Number(player.x || 0);
      py = Number(player.y || 0);
    } else {
      px =
        ((Number(player.x || 0) + Number(player.vx || 0) * safeDt) % 100 +
          100) %
        100;
      py =
        ((Number(player.y || 0) + Number(player.vy || 0) * safeDt) % 100 +
          100) %
        100;
    }

    const x = px * sx;
    const y = py * sy;
    const angle = Number(player.angle || 0);
    const hp = Math.max(0, Number(player.hp || 0));
    const shield = Math.max(0, Number(player.shield || 0));
    const wl = Math.max(1, Number(player.weaponLevel || 1));

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    if (player.alive) {
      ctx.fillStyle = isMe ? "#22d3ee" : "#f59e0b";
      ctx.shadowBlur = 18;
      ctx.shadowColor = isMe
        ? "rgba(34,211,238,0.8)"
        : "rgba(245,158,11,0.8)";
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

    if (
      player.alive &&
      Math.hypot(Number(player.vx || 0), Number(player.vy || 0)) > 10
    ) {
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

    // HP bar
    const barY = y - 18;
    const bw = 32;
    ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
    ctx.fillRect(x - bw / 2, barY, bw, 4);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(x - bw / 2, barY, (hp / 100) * bw, 4);

    // Shield bar
    ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
    ctx.fillRect(x - bw / 2, barY + 5, bw, 3);
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(x - bw / 2, barY + 5, (shield / 60) * bw, 3);

    // Label
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 12px system-ui";
    ctx.fillText(`${isMe ? "YOU" : "RIVAL"} W${wl}`, x - 20, y - 26);
  }
}
