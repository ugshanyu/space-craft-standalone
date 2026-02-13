import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import * as Game from './server/game.js';
import { validateAccessToken } from './server/auth.js';
import { submitMatchResult } from './server/webhook.js';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const PORT = Number(process.env.PORT || 3000);

const API_URL = (process.env.API_URL || 'https://mobile.mongolai.mn').replace(/\/$/, '');
const JWKS_URL = process.env.JWKS_URL || `${API_URL}/.well-known/jwks.json`;
const SERVICE_ID = process.env.SERVICE_ID || null;
const SIGNING_KEY_ID = process.env.SIGNING_KEY_ID || 'space-craft-key-1';
const SIGNING_SECRET = process.env.SIGNING_SECRET || 'CHANGE_ME_IN_PRODUCTION';
const DEPLOY_REGION = process.env.RAILWAY_REGION || process.env.AWS_REGION || process.env.FLY_REGION || 'unknown';

const MIN_PLAYERS = 2;
const SIM_TICK_HZ = 60;
const SIM_TICK_MS = Math.floor(1000 / SIM_TICK_HZ);
const NETWORK_HZ = Math.max(1, Number(process.env.NETWORK_HZ || 60));
const NETWORK_EVERY_SIM_TICKS = Math.max(1, Math.floor(SIM_TICK_HZ / NETWORK_HZ));
const FULL_SNAPSHOT_INTERVAL_NET_TICKS = Math.max(1, Number(process.env.FULL_SNAPSHOT_INTERVAL_NET_TICKS || NETWORK_HZ));
const MAX_LAG_COMP_MS = 120;
const MAX_CLIENT_INPUT_AGE_MS = 2000;
const NET_PROFILE = {
  deploy_region: DEPLOY_REGION,
  sim_hz: SIM_TICK_HZ,
  net_hz: NETWORK_HZ,
};

const rooms = new Map();

function sendJson(ws, frame) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] unhandledRejection', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[PROCESS] uncaughtException', err);
});

class RoomRuntime {
  constructor(roomId, serviceId) {
    this.roomId = roomId;
    this.serviceId = serviceId || null;

    this.minPlayers = MIN_PLAYERS;
    this.sessions = new Map(); // sessionId -> { userId, ws }
    this.connectedUserIds = new Set();

    this.running = false;
    this.finished = false;
    this.tickHandle = null;
    this.lastTickTime = null; // hrtime for accurate delta

    this.serverTick = 0;
    this.networkTick = 0;
    this.state = null;

    this.latestInputByUser = new Map(); // userId -> payload
    this.lastSeqByUser = {}; // monotonic validation
    this.ackSeqByPlayer = {};
    this.smoothedLagByUser = {};
    this.lastBroadcastState = null;
  }

  get activePlayers() {
    return [...this.connectedUserIds];
  }

  upsertSession(sessionId, userId, ws) {
    this.sessions.set(sessionId, { userId, ws });
    this.connectedUserIds.add(userId);

    // New direct connection can restart seq at 1.
    this.lastSeqByUser[userId] = 0;
    this.ackSeqByPlayer[userId] = 0;
    if (!this.latestInputByUser.has(userId)) {
      this.latestInputByUser.set(userId, { turn: 0, thrust: 0, fire: false, fire_pressed: false, lag_comp_ms: 0 });
    }
  }

  removeSession(sessionId) {
    const removed = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);

    if (removed) {
      const stillConnected = [...this.sessions.values()].some((s) => s.userId === removed.userId);
      if (!stillConnected) {
        this.connectedUserIds.delete(removed.userId);
        delete this.lastSeqByUser[removed.userId];
        delete this.ackSeqByPlayer[removed.userId];
        delete this.smoothedLagByUser[removed.userId];
        this.latestInputByUser.delete(removed.userId);
      }
    }

    if (this.running && !this.finished && this.connectedUserIds.size < this.minPlayers) {
      this.finished = true;
      this.broadcast('match_end', {
        room_id: this.roomId,
        protocol_version: '2',
        server_ts: Date.now(),
        server_tick: this.serverTick,
        winner_ids: [...this.connectedUserIds],
        reason: 'player_disconnected',
        final_stats: buildFinalStats(this.state),
      });
      this.stop();
      rooms.delete(this.roomId);
      return;
    }

    if (this.sessions.size === 0) {
      this.stop();
      rooms.delete(this.roomId);
    }
  }

  enqueueInput(userId, seq, payload) {
    if (!this.running || this.finished) {
      return { accepted: false, reason: 'ROOM_NOT_RUNNING' };
    }

    const safeSeq = Number(seq || 0);
    const lastSeq = Number(this.lastSeqByUser[userId] || 0);
    if (safeSeq <= lastSeq) {
      // Drop stale/duplicate packets silently.
      return { accepted: false, reason: 'STALE_INPUT' };
    }

    this.lastSeqByUser[userId] = safeSeq;
    this.ackSeqByPlayer[userId] = safeSeq;

    const now = Date.now();
    const clientSentAtMs = Number(payload?.client_sent_at_ms || 0);
    let lagCompMs = Number(this.smoothedLagByUser[userId] || 0);
    if (clientSentAtMs > 0) {
      const ageMs = now - clientSentAtMs;
      if (ageMs >= 0 && ageMs <= MAX_CLIENT_INPUT_AGE_MS) {
        const prev = Number(this.smoothedLagByUser[userId] || ageMs);
        lagCompMs = Math.max(0, Math.min(MAX_LAG_COMP_MS, prev * 0.8 + ageMs * 0.2));
        this.smoothedLagByUser[userId] = lagCompMs;
      }
    }

    this.latestInputByUser.set(userId, {
      turn: Number(payload?.turn || 0),
      thrust: Number(payload?.thrust || 0),
      fire: Boolean(payload?.fire),
      fire_pressed: Boolean(payload?.fire_pressed),
      lag_comp_ms: lagCompMs,
    });
    return { accepted: true };
  }

  maybeStart() {
    if (this.running || this.finished) return;
    if (this.connectedUserIds.size < this.minPlayers) return;

    const players = this.activePlayers.slice(0, 2);
    this.state = Game.initState(players, hashRoomId(this.roomId));
    this.running = true;
    this.serverTick = 0;
    this.networkTick = 0;

    this.broadcast('game_start', {
      room_id: this.roomId,
      player_ids: players,
      ...NET_PROFILE,
    });

    this.lastTickTime = process.hrtime.bigint();
    this._scheduleNextTick();
  }

  _scheduleNextTick() {
    if (!this.running || this.finished) return;
    const now = process.hrtime.bigint();
    const elapsedSinceTickStartNs = Number(now - this.lastTickTime);
    const targetNs = SIM_TICK_MS * 1_000_000;
    // Target: next tick fires SIM_TICK_MS after the current tick started
    // Subtract elapsed processing time to self-correct for drift
    const delayMs = Math.max(0, Math.round((targetNs - elapsedSinceTickStartNs) / 1_000_000));
    this.tickHandle = setTimeout(() => this.tick(), delayMs);
  }

  stop() {
    this.running = false;
    if (this.tickHandle) {
      clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
    this.lastTickTime = null;
    this.lastBroadcastState = null;
  }

  tick() {
    if (!this.running || this.finished || !this.state) return;

    const now = process.hrtime.bigint();
    // Use actual elapsed time, clamped to avoid spiral-of-death
    const actualDtMs = this.lastTickTime
      ? Math.min(Number(now - this.lastTickTime) / 1_000_000, SIM_TICK_MS * 2)
      : SIM_TICK_MS;
    this.lastTickTime = now;

    this.serverTick += 1;

    for (const [pid, input] of this.latestInputByUser.entries()) {
      Game.applyInput(this.state, pid, input);
      if (input && input.fire_pressed) {
        input.fire_pressed = false;
      }
    }

    Game.tick(this.state, actualDtMs);

    if (this.serverTick % NETWORK_EVERY_SIM_TICKS === 0) {
      this.networkTick += 1;
      const networkState = toNetworkState(this.state);
      const payloadBase = {
        room_id: this.roomId,
        protocol_version: '2',
        server_ts: Date.now(),
        server_tick: this.serverTick,
        ack_seq_by_player: this.ackSeqByPlayer,
        ...NET_PROFILE,
      };

      const shouldSendFullSnapshot = (
        !this.lastBroadcastState ||
        this.networkTick % FULL_SNAPSHOT_INTERVAL_NET_TICKS === 0
      );
      if (shouldSendFullSnapshot) {
        this.broadcast('state_snapshot', {
          ...payloadBase,
          full_state: networkState,
        });
      } else {
        const delta = buildDelta(this.lastBroadcastState, networkState);
        this.broadcast('state_delta', {
          ...payloadBase,
          changed_entities: delta.changed_entities,
          removed_entities: delta.removed_entities,
        });
      }
      this.lastBroadcastState = networkState;
    }

    const terminal = Game.isTerminal(this.state);
    if (!terminal.terminal) {
      this._scheduleNextTick();
      return;
    }

    this.finished = true;
    this.handleMatchEnd(terminal).catch((err) => {
      console.error('[MATCH_END] error', err?.message || err);
    });
  }

  async handleMatchEnd(terminal) {
    const finalStats = buildFinalStats(this.state);

    this.broadcast('match_end', {
      room_id: this.roomId,
      protocol_version: '2',
      server_ts: Date.now(),
      server_tick: this.serverTick,
      winner_ids: terminal.winnerIds,
      reason: terminal.reason,
      final_stats: finalStats,
    });

    try {
      if (!this.serviceId) throw new Error('Missing service_id for result submission');
      await submitMatchResult({
        apiUrl: API_URL,
        serviceId: this.serviceId,
        signingKeyId: SIGNING_KEY_ID,
        signingSecret: SIGNING_SECRET,
        roomId: this.roomId,
        sessionId: [...this.sessions.keys()][0] || crypto.randomUUID(),
        winnerIds: terminal.winnerIds,
        participants: this.activePlayers,
        reason: terminal.reason,
        finalStats,
      });
    } catch (err) {
      console.error('[WEBHOOK] submit failed', err?.message || err);
    }

    this.stop();
  }

  broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const { ws } of this.sessions.values()) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch { }
      }
    }
  }
}

function toNetworkState(state) {
  if (!state) return null;
  const players = {};
  for (const [pid, p] of Object.entries(state.players || {})) {
    players[pid] = {
      id: String(p.id || pid),
      x: Number(p.x || 0),
      y: Number(p.y || 0),
      vx: Number(p.vx || 0),
      vy: Number(p.vy || 0),
      angle: Number(p.angle || 0),
      hp: Number(p.hp || 0),
      shield: Number(p.shield || 0),
      weaponLevel: Number(p.weaponLevel || 1),
      alive: Boolean(p.alive),
    };
  }
  return {
    phase: String(state.phase || 'playing'),
    tick: Number(state.tick || 0),
    remainingMs: Number(state.remainingMs || 0),
    players,
    projectiles: (state.projectiles || []).map((x) => ({
      id: String(x.id || ''),
      ownerId: String(x.ownerId || ''),
      x: Number(x.x || 0),
      y: Number(x.y || 0),
      vx: Number(x.vx || 0),
      vy: Number(x.vy || 0),
      ttlMs: Number(x.ttlMs || 0),
      fireSeq: Number.isFinite(Number(x.fireSeq)) ? Number(x.fireSeq) : undefined,
    })),
    pickups: (state.pickups || []).map((x) => ({
      id: String(x.id || ''),
      x: Number(x.x || 0),
      y: Number(x.y || 0),
      type: String(x.type || ''),
    })),
  };
}

function buildFinalStats(state) {
  if (!state?.players) return {};
  const out = {};
  for (const [pid, p] of Object.entries(state.players)) {
    out[pid] = p.stats || {};
  }
  return out;
}

function entityMapById(items) {
  const out = new Map();
  for (const item of items || []) {
    if (item && item.id !== undefined && item.id !== null) {
      out.set(String(item.id), item);
    }
  }
  return out;
}

function shallowEqualEntity(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function buildDelta(prevState, nextState) {
  const changed = {};
  const removed = { projectiles: [], pickups: [] };

  if (!prevState) {
    return {
      changed_entities: {
        phase: nextState.phase,
        tick: nextState.tick,
        remainingMs: nextState.remainingMs,
        players: nextState.players,
        projectiles: nextState.projectiles,
        pickups: nextState.pickups,
      },
      removed_entities: removed,
    };
  }

  if (prevState.phase !== nextState.phase) {
    changed.phase = nextState.phase;
  }
  if (prevState.tick !== nextState.tick) {
    changed.tick = nextState.tick;
  }
  if (prevState.remainingMs !== nextState.remainingMs) {
    changed.remainingMs = nextState.remainingMs;
  }

  const playerPatch = {};
  const prevPlayers = prevState.players || {};
  const nextPlayers = nextState.players || {};
  for (const [pid, p] of Object.entries(nextPlayers)) {
    if (!prevPlayers[pid] || !shallowEqualEntity(prevPlayers[pid], p)) {
      playerPatch[pid] = p;
    }
  }
  if (Object.keys(playerPatch).length > 0) {
    changed.players = playerPatch;
  }

  const prevProjectiles = entityMapById(prevState.projectiles || []);
  const nextProjectiles = entityMapById(nextState.projectiles || []);
  const projectilePatch = [];
  for (const [id, pr] of nextProjectiles.entries()) {
    const prev = prevProjectiles.get(id);
    if (!prev || !shallowEqualEntity(prev, pr)) {
      projectilePatch.push(pr);
    }
  }
  for (const id of prevProjectiles.keys()) {
    if (!nextProjectiles.has(id)) removed.projectiles.push(id);
  }
  if (projectilePatch.length > 0) {
    changed.projectiles = projectilePatch;
  }

  const prevPickups = entityMapById(prevState.pickups || []);
  const nextPickups = entityMapById(nextState.pickups || []);
  const pickupPatch = [];
  for (const [id, pu] of nextPickups.entries()) {
    const prev = prevPickups.get(id);
    if (!prev || !shallowEqualEntity(prev, pu)) {
      pickupPatch.push(pu);
    }
  }
  for (const id of prevPickups.keys()) {
    if (!nextPickups.has(id)) removed.pickups.push(id);
  }
  if (pickupPatch.length > 0) {
    changed.pickups = pickupPatch;
  }

  return {
    changed_entities: changed,
    removed_entities: removed,
  };
}

function hashRoomId(roomId) {
  return parseInt(crypto.createHash('sha256').update(roomId).digest('hex').slice(0, 12), 16);
}

function handleMessage(ws, session, msg) {
  const type = msg?.type;
  const payload = msg?.payload || {};
  const seq = Number(msg?.seq || 0);

  if (type === 'join') {
    let room = rooms.get(session.roomId);
    if (!room) {
      room = new RoomRuntime(session.roomId, session.serviceId);
      rooms.set(session.roomId, room);
    }

    room.upsertSession(session.sessionId, session.userId, ws);

    const waitingFor = Math.max(0, room.minPlayers - room.connectedUserIds.size);
    sendJson(ws, {
      type: 'joined',
      payload: {
        room_id: room.roomId,
        player_id: session.userId,
        player_ids: room.activePlayers,
        waiting_for: waitingFor,
        ...NET_PROFILE,
      },
    });

    room.broadcast('player_joined', {
      room_id: room.roomId,
      player_id: session.userId,
      player_ids: room.activePlayers,
      waiting_for: waitingFor,
    });

    room.maybeStart();
    return;
  }

  if (type === 'input') {
    const room = rooms.get(session.roomId);
    if (!room) return;

    const inputPayload = payload?.action_data || payload || {};
    room.enqueueInput(session.userId, seq, inputPayload);
    return;
  }

  if (type === 'ping') {
    const room = rooms.get(session.roomId);
    sendJson(ws, {
      type: 'pong',
      payload: {
        room_id: session.roomId,
        server_tick: room?.serverTick || 0,
        server_ts: Date.now(),
        ...NET_PROFILE,
      },
    });
    return;
  }

  if (type === 'leave') {
    const room = rooms.get(session.roomId);
    if (room) {
      room.removeSession(session.sessionId);
      room.broadcast('player_left', {
        room_id: room.roomId,
        player_id: session.userId,
      });
    }
    try { ws.close(); } catch { }
  }
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://localhost:${PORT}`);
    if (reqUrl.pathname.startsWith('/_next/')) return;

    if (reqUrl.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const token = url.searchParams.get('token');

    const session = {
      userId: null,
      roomId: null,
      sessionId: null,
      serviceId: null,
    };

    let authComplete = false;
    const buffered = [];

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (!authComplete) {
          buffered.push(msg);
          return;
        }
        handleMessage(ws, session, msg);
      } catch (err) {
        console.error('[WS] parse_error', err?.message || err);
      }
    });

    ws.on('close', () => {
      if (!session.roomId || !session.sessionId) return;
      const room = rooms.get(session.roomId);
      if (!room) return;
      room.removeSession(session.sessionId);
      room.broadcast('player_left', {
        room_id: room.roomId,
        player_id: session.userId,
      });
    });

    ws.on('error', (err) => {
      console.error('[WS] socket_error', err?.message || err);
    });

    if (!token) {
      sendJson(ws, { type: 'error', payload: { code: 'NO_TOKEN', message: 'Missing access token' } });
      try { ws.close(); } catch { }
      return;
    }

    validateAccessToken(token, {
      jwksUrl: JWKS_URL,
      expectedServiceId: SERVICE_ID,
    })
      .then((payload) => {
        session.userId = payload.sub;
        session.roomId = payload.room_id;
        session.sessionId = payload.session_id;
        session.serviceId = payload.service_id || null;
        authComplete = true;

        if (ws.readyState !== 1) return;
        for (const msg of buffered) handleMessage(ws, session, msg);
        buffered.length = 0;
      })
      .catch((err) => {
        console.error('[WS] auth_failed', err?.message || err);
        sendJson(ws, { type: 'error', payload: { code: 'INVALID_TOKEN', message: err?.message || 'Invalid token' } });
        try { ws.close(); } catch { }
      });
  });

  server.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${PORT}`);
    console.log(`[GAME] region=${DEPLOY_REGION}`);
    console.log(
      `[GAME] sim=${SIM_TICK_HZ}Hz net=${NETWORK_HZ}Hz full_snapshot_every=${FULL_SNAPSHOT_INTERVAL_NET_TICKS} net_ticks`
    );
  });
});
