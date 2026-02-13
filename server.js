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
const PORT = process.env.PORT || 3000;

// Game Server Config
const SERVICE_ID = process.env.SERVICE_ID || 'space-craft';
const JWKS_URL = process.env.JWKS_URL || 'http://localhost:8000/.well-known/jwks.json';
const API_URL = process.env.API_URL || 'http://localhost:8000';
const SIGNING_KEY_ID = process.env.SIGNING_KEY_ID || 'space-craft-key-1';
const SIGNING_SECRET = process.env.SIGNING_SECRET || 'CHANGE_ME_IN_PRODUCTION';
const TICK_RATE_HZ = 20;
const TICK_MS = 1000 / TICK_RATE_HZ;
const SNAPSHOT_INTERVAL_TICKS = 20;
const MIN_PLAYERS = 2;

const rooms = new Map(); // roomId -> RoomRuntime

function sendJson(ws, frame) {
  const text = JSON.stringify(frame);
  if (ws.readyState !== ws.OPEN) {
    return false;
  }
  ws.send(text, (err) => {
    if (err) {
      console.error('[WS] send_error', err.message);
    }
  });
  return true;
}

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] unhandledRejection', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[PROCESS] uncaughtException', err);
});

class RoomRuntime {
  constructor(roomId, playerIds, minPlayers) {
    this.roomId = roomId;
    this.playerIds = playerIds;
    this.minPlayers = minPlayers || MIN_PLAYERS;
    this.connectedUserIds = new Set();
    this.sessions = new Map();
    this.inputQueue = [];
    this.running = false;
    this.finished = false;
    this.tickInterval = null;
    this.state = null;
    this.lastState = null;
    this.serverTick = 0;
    this.ackSeqByPlayer = {};
  }

  start() {
    if (this.running) return;
    const allPlayerIds = [...this.connectedUserIds];
    this.playerIds = allPlayerIds;
    this.state = Game.initState(allPlayerIds, hashRoomId(this.roomId));
    this.lastState = structuredClone(this.state);
    for (const pid of allPlayerIds) this.ackSeqByPlayer[pid] = 0;
    this.running = true;
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
    this.broadcast('game_start', { player_ids: allPlayerIds, room_id: this.roomId });
  }

  stop() {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  addSession(sessionId, userId, ws) {
    this.sessions.set(sessionId, { userId, ws });
    this.connectedUserIds.add(userId);
  }

  removeSession(sessionId) {
    const removed = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);

    if (removed) {
      const stillConnected = [...this.sessions.values()].some((s) => s.userId === removed.userId);
      if (!stillConnected) {
        this.connectedUserIds.delete(removed.userId);
        delete this.ackSeqByPlayer[removed.userId];
      }
    }

    // If a running match loses a participant, end and clean up room state.
    if (this.running && !this.finished && this.sessions.size < this.minPlayers) {
      this.finished = true;
      const finalStats = {};
      if (this.state?.players) {
        for (const [pid, p] of Object.entries(this.state.players)) {
          finalStats[pid] = p.stats;
        }
      }
      const survivors = [...new Set([...this.sessions.values()].map((s) => s.userId))];
      this.broadcast('match_end', {
        room_id: this.roomId,
        protocol_version: '2',
        server_ts: Date.now(),
        server_tick: this.serverTick,
        winner_ids: survivors,
        reason: 'player_disconnected',
        final_stats: finalStats,
      });
      this.stop();

      // Close surviving sockets and drop the room immediately.
      for (const { ws } of this.sessions.values()) {
        try { ws.close(4001, 'player_disconnected'); } catch {}
      }
      this.sessions.clear();
      this.connectedUserIds.clear();
      this.inputQueue = [];
      rooms.delete(this.roomId);
      return;
    }

    // Always destroy empty rooms to avoid leaked tick loops and stale state.
    if (this.sessions.size === 0) {
      this.stop();
      this.connectedUserIds.clear();
      this.inputQueue = [];
      rooms.delete(this.roomId);
    }
  }

  enqueueInput(userId, seq, inputType, payload, clientTs) {
    if (this.finished) return { accepted: false, reason: 'MATCH_FINISHED' };
    const lastSeq = this.ackSeqByPlayer[userId] || 0;
    if (seq <= lastSeq) return { accepted: false, reason: 'NON_MONOTONIC_SEQ', expectedGt: lastSeq };
    this.inputQueue.push({ userId, seq, inputType, payload, clientTs });
    this.inputQueue.sort((a, b) => a.seq - b.seq || a.userId.localeCompare(b.userId));
    return { accepted: true, queued: this.inputQueue.length };
  }

  tick() {
    if (this.finished || !this.state) return;
    this.serverTick++;

    for (const event of this.inputQueue) {
      Game.applyInput(this.state, event.userId, event.payload);
      this.ackSeqByPlayer[event.userId] = Math.max(this.ackSeqByPlayer[event.userId] || 0, event.seq);
    }
    this.inputQueue = [];

    const prev = this.lastState;
    Game.tick(this.state, TICK_MS);

    const delta = Game.buildDelta(prev, this.state);
    this.lastState = structuredClone(this.state);

    const deltaPayload = {
      room_id: this.roomId,
      protocol_version: '2',
      server_ts: Date.now(),
      server_tick: this.serverTick,
      ack_seq_by_player: this.ackSeqByPlayer,
      state_hash: hashState(this.state),
      ...delta,
    };

    this.broadcast('state_delta', deltaPayload);

    if (this.serverTick % SNAPSHOT_INTERVAL_TICKS === 0) {
      const snapshot = {
        room_id: this.roomId,
        protocol_version: '2',
        server_ts: Date.now(),
        server_tick: this.serverTick,
        ack_seq_by_player: this.ackSeqByPlayer,
        state_hash: hashState(this.state),
        full_state: structuredClone(this.state),
      };
      this.broadcast('state_snapshot', snapshot);
    }

    const result = Game.isTerminal(this.state);
    if (result.terminal) {
      this.finished = true;
      this.handleMatchEnd(result);
    }
  }

  async handleMatchEnd(result) {
    const finalStats = {};
    for (const [pid, p] of Object.entries(this.state.players)) {
      finalStats[pid] = p.stats;
    }

    const matchEndPayload = {
      room_id: this.roomId,
      protocol_version: '2',
      server_ts: Date.now(),
      server_tick: this.serverTick,
      winner_ids: result.winnerIds,
      reason: result.reason,
      final_stats: finalStats,
    };
    this.broadcast('match_end', matchEndPayload);

    try {
      await submitMatchResult({
        apiUrl: API_URL,
        serviceId: SERVICE_ID,
        signingKeyId: SIGNING_KEY_ID,
        signingSecret: SIGNING_SECRET,
        roomId: this.roomId,
        sessionId: [...this.sessions.keys()][0] || crypto.randomUUID(),
        winnerIds: result.winnerIds,
        participants: this.playerIds,
        reason: result.reason,
        finalStats,
      });
    } catch (err) {
      console.error('[WEBHOOK] Failed to submit result:', err.message);
    }

    this.stop();
  }

  broadcast(type, payload) {
    const message = JSON.stringify({ type, payload });
    for (const { ws } of this.sessions.values()) {
      if (ws.readyState === 1) ws.send(message);
    }
  }
}

function hashRoomId(roomId) {
  return parseInt(crypto.createHash('sha256').update(roomId).digest('hex').slice(0, 12), 16);
}

function hashState(state) {
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
}

async function fetchRoomInfo(roomId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
  try {
    const resp = await fetch(`${API_URL}/games/rooms/${encodeURIComponent(roomId)}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      return null;
    }
    const data = await resp.json();
    return data;
  } catch (err) {
    clearTimeout(timeout);
    console.error('[ROOM] Error fetching room info:', err.message);
    return null;
  }
}

function handleMessage(ws, session, msg) {
  const { type, payload } = msg;
  const topSeq = msg.seq || 0;
  const topTs = msg.ts || Date.now();

  if (type === 'join') {
    let room = rooms.get(session.roomId);
    if (!room) {
      room = new RoomRuntime(session.roomId, [], MIN_PLAYERS);
      rooms.set(session.roomId, room);
    }

    // Idempotent join: same session reconnect/join retries should not duplicate state.
    if (room.sessions.has(session.sessionId)) {
      const waitingFor = Math.max(0, room.minPlayers - room.connectedUserIds.size);
      sendJson(ws, {
        type: 'joined',
        payload: {
          room_id: session.roomId,
          player_id: session.userId,
          player_ids: [...room.connectedUserIds],
          waiting_for: waitingFor,
        },
      });
      return;
    }

    room.addSession(session.sessionId, session.userId, ws);
    const waitingFor = Math.max(0, room.minPlayers - room.connectedUserIds.size);
    sendJson(ws, {
      type: 'joined',
      payload: {
        room_id: session.roomId,
        player_id: session.userId,
        player_ids: [...room.connectedUserIds],
        waiting_for: waitingFor,
      },
    });
    room.broadcast('player_joined', {
      player_id: session.userId,
      player_ids: [...room.connectedUserIds],
      waiting_for: waitingFor,
    });

    if (!room.running && room.connectedUserIds.size >= room.minPlayers) {
      room.start();
    }
  } else if (type === 'input') {
    const room = rooms.get(session.roomId);
    if (!room || !room.running) return;
    
    const inputPayload = (payload && payload.action_data) || payload || {};
    const inputType = (payload && payload.action_type) || payload?.input_type || 'control';

    const result = room.enqueueInput(
      session.userId,
      topSeq,
      inputType,
      inputPayload,
      topTs
    );
    if (!result.accepted) {
      sendJson(ws, { type: 'error', payload: { code: 'INPUT_REJECTED', ...result } });
    }
  } else if (type === 'ping') {
    const room = rooms.get(session.roomId);
    const serverTick = room ? room.serverTick : 0;
    sendJson(ws, {
      type: 'pong',
      payload: {
        room_id: session.roomId,
        server_tick: serverTick,
        server_ts: Date.now(),
      },
    });
  } else if (type === 'leave') {
    const room = rooms.get(session.roomId);
    if (room) {
      room.removeSession(session.sessionId);
      room.broadcast('player_left', { player_id: session.userId });
    }
    ws.close();
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
    if (reqUrl.pathname.startsWith('/_next/')) {
      return;
    }

    // Only accept the direct game websocket endpoint.
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
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get('token');
    
    let session = { userId: null, roomId: null, sessionId: null };
    let pendingMessages = [];
    let authComplete = false;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!authComplete) {
          pendingMessages.push(msg);
          return;
        }
        handleMessage(ws, session, msg);
      } catch (err) {
        console.error('[WS] message_parse_error', err.message);
      }
    });

    ws.on('close', () => {
      if (session.roomId && session.sessionId) {
        const room = rooms.get(session.roomId);
        if (room) {
          room.removeSession(session.sessionId);
          room.broadcast('player_left', { player_id: session.userId });
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] ws_error', err.message);
    });

    if (!token) {
      sendJson(ws, { type: 'error', payload: { code: 'NO_TOKEN', message: 'Missing access token' } });
      ws.close();
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
        authComplete = true;
        if (ws.readyState !== ws.OPEN) return;

        if (pendingMessages.length > 0) {
          for (const msg of pendingMessages) {
            handleMessage(ws, session, msg);
          }
          pendingMessages = [];
        }
      })
      .catch((err) => {
        console.error('[WS] auth_failed', err.message);
        sendJson(ws, { type: 'error', payload: { code: 'INVALID_TOKEN', message: err.message } });
        ws.close();
      });
  });

  server.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${PORT}`);
  });
});
