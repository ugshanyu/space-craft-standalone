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
const WS_DIAG = process.env.WS_DIAG !== '0';
const WS_INPUT_TRACE = process.env.WS_INPUT_TRACE === '1';
const WS_DEBUG_PROBE = process.env.WS_DEBUG_PROBE === '1';
const READY_STATE = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
let connectionSeq = 0;

const rooms = new Map(); // roomId -> RoomRuntime

function readyStateName(ws) {
  return READY_STATE[ws.readyState] || String(ws.readyState);
}

function shortId(value, size = 8) {
  if (!value) return '(none)';
  const s = String(value);
  return s.length > size ? s.slice(0, size) : s;
}

function diag(cid, event, details = undefined) {
  if (!WS_DIAG) return;
  if (details !== undefined) {
    console.log(`[WS][${cid}] ${event}`, details);
  } else {
    console.log(`[WS][${cid}] ${event}`);
  }
}

function sendJson(ws, cid, frame, label) {
  const text = JSON.stringify(frame);
  const state = readyStateName(ws);
  if (ws.readyState !== ws.OPEN) {
    diag(cid, `send_skip:${label}`, { state, bytes: text.length });
    return false;
  }
  ws.send(text, (err) => {
    if (err) {
      console.error(`[WS][${cid}] send_error:${label}`, err.message);
    } else {
      diag(cid, `send_ok:${label}`, { bytes: text.length });
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
    console.log('[ROOM] Game started:', this.roomId, 'players:', allPlayerIds);
    this.broadcast('game_start', { player_ids: allPlayerIds, room_id: this.roomId });
  }

  stop() {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    console.log('[ROOM] Stopped:', this.roomId);
  }

  addSession(sessionId, userId, ws) {
    this.sessions.set(sessionId, { userId, ws });
    this.connectedUserIds.add(userId);
    console.log(`[ROOM] Session added: room=${this.roomId} session=${sessionId} user=${userId} (${this.connectedUserIds.size}/${this.minPlayers} players)`);
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
      console.log(`[ROOM] Closed room due to player disconnect: ${this.roomId}`);
      return;
    }

    // Always destroy empty rooms to avoid leaked tick loops and stale state.
    if (this.sessions.size === 0) {
      this.stop();
      this.connectedUserIds.clear();
      this.inputQueue = [];
      rooms.delete(this.roomId);
      console.log(`[ROOM] Removed empty room: ${this.roomId}`);
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
  console.log(`[ROOM] Fetching room info for ${roomId} from ${API_URL}...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
  try {
    const resp = await fetch(`${API_URL}/games/rooms/${encodeURIComponent(roomId)}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.log(`[ROOM] Failed to fetch room info (${resp.status}), using fallback`);
      return null;
    }
    const data = await resp.json();
    console.log(`[ROOM] Got room info:`, { playerCount: data.player_ids?.length, status: data.status });
    return data;
  } catch (err) {
    clearTimeout(timeout);
    console.error('[ROOM] Error fetching room info:', err.message);
    return null;
  }
}

function handleMessage(ws, session, msg, ctx = {}) {
  const cid = ctx.cid || 'na';
  const { type, payload } = msg;
  const topSeq = msg.seq || 0;
  const topTs = msg.ts || Date.now();

  if (type !== 'input' || WS_INPUT_TRACE) {
    diag(cid, 'message', {
      type,
      seq: topSeq,
      ts: topTs,
      sessionId: shortId(session.sessionId),
      userId: shortId(session.userId),
      roomId: shortId(session.roomId),
      state: readyStateName(ws),
    });
  }

  if (type === 'join') {
    let room = rooms.get(session.roomId);
    if (!room) {
      room = new RoomRuntime(session.roomId, [], MIN_PLAYERS);
      rooms.set(session.roomId, room);
      diag(cid, 'room_created', { roomId: session.roomId, minPlayers: room.minPlayers });
    }

    // Idempotent join: same session reconnect/join retries should not duplicate state.
    if (room.sessions.has(session.sessionId)) {
      const waitingFor = Math.max(0, room.minPlayers - room.connectedUserIds.size);
      sendJson(ws, cid, {
        type: 'joined',
        payload: {
          room_id: session.roomId,
          player_id: session.userId,
          player_ids: [...room.connectedUserIds],
          waiting_for: waitingFor,
        },
      }, 'joined(idempotent)');
      diag(cid, 'join_idempotent', { waitingFor, connected: room.connectedUserIds.size });
      return;
    }

    room.addSession(session.sessionId, session.userId, ws);
    const waitingFor = Math.max(0, room.minPlayers - room.connectedUserIds.size);
    sendJson(ws, cid, {
      type: 'joined',
      payload: {
        room_id: session.roomId,
        player_id: session.userId,
        player_ids: [...room.connectedUserIds],
        waiting_for: waitingFor,
      },
    }, 'joined');
    diag(cid, 'join_accepted', {
      roomId: session.roomId,
      connectedUsers: room.connectedUserIds.size,
      sessions: room.sessions.size,
      waitingFor,
    });
    room.broadcast('player_joined', {
      player_id: session.userId,
      player_ids: [...room.connectedUserIds],
      waiting_for: waitingFor,
    });

    if (!room.running && room.connectedUserIds.size >= room.minPlayers) {
      console.log(`[ROOM] All ${room.minPlayers} players connected, starting game in room ${session.roomId}`);
      room.start();
    }
  } else if (type === 'input') {
    const room = rooms.get(session.roomId);
    if (!room || !room.running) return;
    
    const inputPayload = (payload && payload.action_data) || payload || {};
    const inputType = (payload && payload.action_type) || payload?.input_type || 'control';
    
    if (inputPayload.turn !== 0 || inputPayload.thrust !== 0 || inputPayload.fire) {
      // console.log(`[INPUT] User=${session.userId} Type=${inputType}`);
    }

    const result = room.enqueueInput(
      session.userId,
      topSeq,
      inputType,
      inputPayload,
      topTs
    );
    if (!result.accepted) {
      sendJson(ws, cid, { type: 'error', payload: { code: 'INPUT_REJECTED', ...result } }, 'input_rejected');
      diag(cid, 'input_rejected', result);
    } else if (WS_INPUT_TRACE && (inputPayload.turn !== 0 || inputPayload.thrust !== 0 || inputPayload.fire)) {
      diag(cid, 'input_accepted', { seq: topSeq, queued: result.queued, inputType });
    }
  } else if (type === 'ping') {
    const room = rooms.get(session.roomId);
    const serverTick = room ? room.serverTick : 0;
    sendJson(ws, cid, {
      type: 'pong',
      payload: {
        room_id: session.roomId,
        server_tick: serverTick,
        server_ts: Date.now(),
      },
    }, 'pong');
  } else if (type === 'leave') {
    const room = rooms.get(session.roomId);
    if (room) {
      room.removeSession(session.sessionId);
      room.broadcast('player_left', { player_id: session.userId });
    }
    diag(cid, 'leave_requested', { sessionId: shortId(session.sessionId), roomId: shortId(session.roomId) });
    ws.close();
  } else {
    diag(cid, 'unknown_message_type', { type });
  }
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  // Use noServer mode to avoid conflicts with Next.js WebSocket handling.
  // Disable permessage-deflate to avoid proxy/transport edge cases that can
  // cause abnormal close(1006) before first client message is processed.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const debugWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  // Manually handle upgrade requests - route game WS to our server, ignore Next.js internal WS
  server.on('upgrade', (request, socket, head) => {
    const cid = `${Date.now().toString(36)}-${(++connectionSeq).toString(36)}`;
    request.__cid = cid;

    // Avoid matching query strings; only skip actual Next.js upgrade paths.
    const reqUrl = new URL(request.url || '/', `http://localhost:${PORT}`);
    if (reqUrl.pathname.startsWith('/_next/')) {
      diag(cid, 'upgrade_skip_next', { path: reqUrl.pathname });
      return;
    }

    if (reqUrl.pathname === '/debug-ws') {
      if (!WS_DEBUG_PROBE) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      diag(cid, 'upgrade_debug_ws', {
        url: request.url?.slice(0, 120),
        origin: request.headers.origin || '(none)',
      });
      debugWss.handleUpgrade(request, socket, head, (ws) => {
        debugWss.emit('connection', ws, request);
      });
      return;
    }

    diag(cid, 'upgrade_request', {
      url: request.url?.slice(0, 120),
      path: reqUrl.pathname,
      hasToken: !!reqUrl.searchParams.get('token'),
      origin: request.headers.origin || '(none)',
      ua: (request.headers['user-agent'] || '').slice(0, 120),
      xff: request.headers['x-forwarded-for'] || '(none)',
      via: request.headers.via || '(none)',
      socketRemote: `${socket.remoteAddress || '(unknown)'}:${socket.remotePort || '(unknown)'}`,
    });

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  debugWss.on('connection', async (ws, req) => {
    const cid = req.__cid || `${Date.now().toString(36)}-${(++connectionSeq).toString(36)}`;
    const openedAt = Date.now();
    const reqUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
    const token = reqUrl.searchParams.get('token');

    diag(cid, 'debug_connection_open', {
      path: reqUrl.pathname,
      hasToken: !!token,
      readyState: readyStateName(ws),
    });

    sendJson(ws, cid, {
      type: 'debug_connected',
      payload: {
        ts: Date.now(),
        path: reqUrl.pathname,
        has_token: !!token,
      },
    }, 'debug_connected');

    if (token) {
      try {
        const payload = await validateAccessToken(token, {
          jwksUrl: JWKS_URL,
          expectedServiceId: SERVICE_ID,
        });
        sendJson(ws, cid, {
          type: 'debug_token_ok',
          payload: {
            user_id: payload.sub,
            room_id: payload.room_id,
            session_id: payload.session_id,
            iat: payload.iat,
            exp: payload.exp,
          },
        }, 'debug_token_ok');
      } catch (err) {
        sendJson(ws, cid, {
          type: 'debug_token_error',
          payload: { message: err?.message || String(err) },
        }, 'debug_token_error');
      }
    }

    ws.on('message', (data) => {
      sendJson(ws, cid, {
        type: 'debug_echo',
        payload: {
          ts: Date.now(),
          len: data.length || 0,
          text: data.toString(),
        },
      }, 'debug_echo');
    });

    ws.on('close', (code, reasonBuf) => {
      diag(cid, 'debug_closed', {
        code,
        reason: reasonBuf ? reasonBuf.toString() : '(none)',
        uptimeMs: Date.now() - openedAt,
      });
    });

    ws.on('error', (err) => {
      console.error(`[WS][${cid}] debug_ws_error`, err.message);
    });
  });

  wss.on('connection', (ws, req) => {
    const cid = req.__cid || `${Date.now().toString(36)}-${(++connectionSeq).toString(36)}`;
    const openedAt = Date.now();
    let messageCount = 0;
    let bytesIn = 0;
    let queuedCount = 0;

    // Note: req.url includes the path, e.g., /?token=...
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get('token');
    
    let session = { userId: null, roomId: null, sessionId: null };
    let pendingMessages = []; 
    let authComplete = false;
    const authStartedAt = Date.now();

    const tcp = ws._socket;
    if (tcp) {
      try {
        tcp.setNoDelay(true);
        tcp.setKeepAlive(true, 15000);
      } catch {}
      diag(cid, 'connection_open', {
        remote: `${tcp.remoteAddress || '(unknown)'}:${tcp.remotePort || '(unknown)'}`,
        local: `${tcp.localAddress || '(unknown)'}:${tcp.localPort || '(unknown)'}`,
        encrypted: !!tcp.encrypted,
        readyState: readyStateName(ws),
      });
      tcp.on('timeout', () => diag(cid, 'tcp_timeout'));
      tcp.on('end', () => diag(cid, 'tcp_end'));
      tcp.on('error', (err) => console.error(`[WS][${cid}] tcp_error`, err.message));
      tcp.on('close', (hadError) => diag(cid, 'tcp_close', { hadError }));
    } else {
      diag(cid, 'connection_open', { note: 'no underlying tcp socket info', readyState: readyStateName(ws) });
    }

    // Register message handler FIRST, before any async operations
    ws.on('message', (data) => {
      messageCount += 1;
      bytesIn += data.length || 0;
      diag(cid, 'frame_in', { len: data.length || 0, count: messageCount, authComplete, state: readyStateName(ws) });
      try {
        const msg = JSON.parse(data.toString());
        if (!authComplete) {
          queuedCount += 1;
          diag(cid, 'queue_pre_auth', { type: msg.type, queuedCount });
          pendingMessages.push(msg);
          return;
        }
        handleMessage(ws, session, msg, { cid });
      } catch (err) {
        console.error(`[WS][${cid}] message_parse_error`, err.message);
      }
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      if (session.roomId && session.sessionId) {
        const room = rooms.get(session.roomId);
        if (room) {
          room.removeSession(session.sessionId);
          room.broadcast('player_left', { player_id: session.userId });
        }
      }
      diag(cid, 'closed', {
        code,
        reason: reason || '(none)',
        user: session.userId || '(unknown)',
        room: session.roomId || '(unknown)',
        uptimeMs: Date.now() - openedAt,
        framesIn: messageCount,
        bytesIn,
        queuedBeforeAuth: queuedCount,
        activeRooms: rooms.size,
        rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      });
    });

    ws.on('error', (err) => {
      console.error(`[WS][${cid}] ws_error`, err.message);
    });

    diag(cid, 'auth_start', { hasToken: !!token });

    if (!token) {
      sendJson(ws, cid, { type: 'error', payload: { code: 'NO_TOKEN', message: 'Missing access token' } }, 'no_token');
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
        diag(cid, 'auth_ok', {
          authMs: Date.now() - authStartedAt,
          userId: payload.sub,
          roomId: payload.room_id,
          sessionId: payload.session_id,
          jti: payload.jti,
          iat: payload.iat,
          exp: payload.exp,
          state: readyStateName(ws),
        });

        // SDK does not require an auth_ok frame for direct mode.
        // Keep the connection passive until the client sends "join".
        if (ws.readyState !== ws.OPEN) {
          diag(cid, 'auth_ok_socket_not_open', { readyState: readyStateName(ws) });
          return;
        }

        if (pendingMessages.length > 0) {
          diag(cid, 'process_queued', { count: pendingMessages.length });
          for (const msg of pendingMessages) {
            handleMessage(ws, session, msg, { cid });
          }
          pendingMessages = [];
        }
      })
      .catch((err) => {
        console.error(`[WS][${cid}] auth_failed`, err.message);
        sendJson(ws, cid, { type: 'error', payload: { code: 'INVALID_TOKEN', message: err.message } }, 'auth_failed');
        ws.close();
      });
  });

  server.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${PORT}`);
    console.log(`> WebSocket Server ready on ws://localhost:${PORT}`);
    console.log(`> Config: SERVICE_ID=${SERVICE_ID} API_URL=${API_URL} JWKS_URL=${JWKS_URL}`);
    console.log(`> NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);
    console.log(`> WS_DIAG=${WS_DIAG} WS_INPUT_TRACE=${WS_INPUT_TRACE}`);
    console.log(`> WS_DEBUG_PROBE=${WS_DEBUG_PROBE}`);
  });
});
