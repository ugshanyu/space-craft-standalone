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
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0 && this.finished) {
      this.stop();
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

function handleMessage(ws, session, msg) {
  const { type, payload } = msg;
  const topSeq = msg.seq || 0;
  const topTs = msg.ts || Date.now();

  console.log(`[MSG] type=${type} user=${session.userId?.slice(0,8)} room=${session.roomId?.slice(0,8)}`);

  if (type === 'join') {
    let room = rooms.get(session.roomId);
    if (!room) {
      fetchRoomInfo(session.roomId).then((roomInfo) => {
        let existingRoom = rooms.get(session.roomId);
        if (existingRoom) {
          existingRoom.addSession(session.sessionId, session.userId, ws);
          const w = Math.max(0, existingRoom.minPlayers - existingRoom.connectedUserIds.size);
          ws.send(JSON.stringify({
            type: 'joined',
            payload: {
              room_id: session.roomId,
              player_id: session.userId,
              player_ids: [...existingRoom.connectedUserIds],
              waiting_for: w,
            },
          }));
          existingRoom.broadcast('player_joined', { player_id: session.userId, player_ids: [...existingRoom.connectedUserIds] });
          if (!existingRoom.running && existingRoom.connectedUserIds.size >= existingRoom.minPlayers) {
            console.log(`[ROOM] All ${existingRoom.minPlayers} players connected, starting game in room ${session.roomId}`);
            existingRoom.start();
          }
          return;
        }

        const maxPlayers = roomInfo?.game_config?.max_players || MIN_PLAYERS;
        const newRoom = new RoomRuntime(session.roomId, [], maxPlayers);
        rooms.set(session.roomId, newRoom);
        newRoom.addSession(session.sessionId, session.userId, ws);

        const waiting = Math.max(0, newRoom.minPlayers - newRoom.connectedUserIds.size);
        ws.send(JSON.stringify({
          type: 'joined',
          payload: {
            room_id: session.roomId,
            player_id: session.userId,
            player_ids: [...newRoom.connectedUserIds],
            waiting_for: waiting,
          },
        }));
        newRoom.broadcast('player_joined', { player_id: session.userId, player_ids: [...newRoom.connectedUserIds] });

        if (newRoom.connectedUserIds.size >= newRoom.minPlayers) {
          newRoom.start();
        } else {
          console.log(`[ROOM] Waiting for ${waiting} more player(s) in room ${session.roomId}`);
        }
      });
      return;
    }

    room.addSession(session.sessionId, session.userId, ws);
    const waitingFor = Math.max(0, room.minPlayers - room.connectedUserIds.size);
    ws.send(JSON.stringify({
      type: 'joined',
      payload: {
        room_id: session.roomId,
        player_id: session.userId,
        player_ids: [...room.connectedUserIds],
        waiting_for: waitingFor,
      },
    }));
    room.broadcast('player_joined', { player_id: session.userId, player_ids: [...room.connectedUserIds] });

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
      ws.send(JSON.stringify({ type: 'error', payload: { code: 'INPUT_REJECTED', ...result } }));
    }
  } else if (type === 'ping') {
    const room = rooms.get(session.roomId);
    if (!room) return;
    ws.send(JSON.stringify({
      type: 'pong',
      payload: {
        room_id: session.roomId,
        server_tick: room.serverTick,
        server_ts: Date.now(),
      },
    }));
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

  // Use noServer mode to avoid conflicts with Next.js WebSocket handling
  const wss = new WebSocketServer({ noServer: true });

  // Manually handle upgrade requests - route game WS to our server, ignore Next.js internal WS
  server.on('upgrade', (request, socket, head) => {
    // Let Next.js handle its own WebSocket connections (HMR, etc.)
    if (request.url?.includes('_next')) {
      // Don't handle - let it fall through or destroy
      socket.destroy();
      return;
    }

    console.log(`[WS] Upgrade request: url=${request.url?.slice(0, 80)}`);

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, req) => {

    // Note: req.url includes the path, e.g., /?token=...
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get('token');
    
    let session = { userId: null, roomId: null, sessionId: null };
    let pendingMessages = []; 
    let authComplete = false;

    // Register message handler FIRST, before any async operations
    ws.on('message', (data) => {
      console.log(`[WS] RAW message received from user=${session.userId?.slice(0,8) || '(pending)'}, length=${data.length}`);
      try {
        const msg = JSON.parse(data.toString());
        if (!authComplete) {
          console.log(`[WS] Queuing message (auth pending): type=${msg.type}`);
          pendingMessages.push(msg);
          return;
        }
        handleMessage(ws, session, msg);
      } catch (err) {
        console.error('[WS] Message error:', err.message);
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

    console.log('[WS] Message handler registered, starting auth...');

    if (!token) {
      ws.send(JSON.stringify({ type: 'error', payload: { code: 'NO_TOKEN', message: 'Missing access token' } }));
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
        console.log('[WS] Connection authenticated:', session);

        // Send auth_ok to client so it knows auth succeeded and can send join
        ws.send(JSON.stringify({ type: 'auth_ok', payload: { session_id: session.sessionId, room_id: session.roomId } }));
        console.log('[WS] Sent auth_ok to client');

        if (pendingMessages.length > 0) {
          console.log(`[WS] Processing ${pendingMessages.length} queued message(s)`);
          for (const msg of pendingMessages) {
            handleMessage(ws, session, msg);
          }
          pendingMessages = [];
        }
      })
      .catch((err) => {
        console.error('[WS] Auth failed:', err.message);
        ws.send(JSON.stringify({ type: 'error', payload: { code: 'INVALID_TOKEN', message: err.message } }));
        ws.close();
      });
  });

  server.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${PORT}`);
    console.log(`> WebSocket Server ready on ws://localhost:${PORT}`);
    console.log(`> Config: SERVICE_ID=${SERVICE_ID} API_URL=${API_URL} JWKS_URL=${JWKS_URL}`);
    console.log(`> NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);
  });
});
