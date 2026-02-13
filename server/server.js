/**
 * Space Craft Direct Mode WebSocket Server - v2 Protocol
 * 
 * Standalone authoritative game server for Direct Mode.
 * Can be deployed to Railway, Render, or any Node.js host.
 */
import { WebSocketServer } from 'ws';
import { URL } from 'url';
import crypto from 'crypto';
import * as Game from './game.js';
import { validateAccessToken } from './auth.js';
import { submitMatchResult } from './webhook.js';

// Configuration from environment
const PORT = process.env.PORT || 8080;
const SERVICE_ID = process.env.SERVICE_ID || 'space-craft';
const JWKS_URL = process.env.JWKS_URL || 'http://localhost:8000/.well-known/jwks.json';
const API_URL = process.env.API_URL || 'http://localhost:8000';
const SIGNING_KEY_ID = process.env.SIGNING_KEY_ID || 'space-craft-key-1';
const SIGNING_SECRET = process.env.SIGNING_SECRET || 'CHANGE_ME_IN_PRODUCTION';
const TICK_RATE_HZ = 20;
const TICK_MS = 1000 / TICK_RATE_HZ;
const SNAPSHOT_INTERVAL_TICKS = 20;
const WS_DEBUG_PROBE = false;

const rooms = new Map(); // roomId -> RoomRuntime

const MIN_PLAYERS = 2; // Space Craft is always a 2-player game

class RoomRuntime {
  constructor(roomId, playerIds, minPlayers) {
    this.roomId = roomId;
    this.playerIds = playerIds;
    this.minPlayers = minPlayers || MIN_PLAYERS;
    this.connectedUserIds = new Set();
    this.sessions = new Map(); // sessionId -> {userId, ws}
    this.inputQueue = [];
    this.running = false;
    this.finished = false;
    this.tickInterval = null;
    // Don't init game state until all players are known
    this.state = null;
    this.lastState = null;
    this.serverTick = 0;
    this.ackSeqByPlayer = {};
  }

  start() {
    if (this.running) return;
    // Now that all players are here, init game state with actual player list
    const allPlayerIds = [...this.connectedUserIds];
    this.playerIds = allPlayerIds;
    this.state = Game.initState(allPlayerIds, hashRoomId(this.roomId));
    this.lastState = structuredClone(this.state);
    for (const pid of allPlayerIds) this.ackSeqByPlayer[pid] = 0;
    this.running = true;
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
    // Notify all clients that the game is starting
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

      for (const { ws } of this.sessions.values()) {
        try { ws.close(4001, 'player_disconnected'); } catch {}
      }
      this.sessions.clear();
      this.connectedUserIds.clear();
      this.inputQueue = [];
      rooms.delete(this.roomId);
      return;
    }

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

    // Apply inputs
    for (const event of this.inputQueue) {
      Game.applyInput(this.state, event.userId, event.payload);
      this.ackSeqByPlayer[event.userId] = Math.max(this.ackSeqByPlayer[event.userId] || 0, event.seq);
    }
    this.inputQueue = [];

    // Simulate
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

    // Broadcast delta
    this.broadcast('state_delta', deltaPayload);

    // Snapshot
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

    // Check terminal
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

    // Submit webhook
    try {
      await submitMatchResult({
        apiUrl: API_URL,
        serviceId: SERVICE_ID,
        signingKeyId: SIGNING_KEY_ID,
        signingSecret: SIGNING_SECRET,
        roomId: this.roomId,
        sessionId: [...this.sessions.keys()][0] || crypto.randomUUID(), // Use first session ID
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

// WebSocket Server
const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `ws://localhost:${PORT}`);
  if (url.pathname !== '/ws' && url.pathname !== '/' && url.pathname !== '/debug-ws') {
    ws.close(1008, 'invalid path');
    return;
  }
  const token = url.searchParams.get('token');
  let session = { userId: null, roomId: null, sessionId: null };
  let pendingMessages = []; // Queue messages until auth completes
  let authComplete = false;

  if (url.pathname === '/debug-ws') {
    if (!WS_DEBUG_PROBE) {
      ws.close(1008, 'debug probe disabled');
      return;
    }

    ws.send(JSON.stringify({
      type: 'debug_connected',
      payload: { ts: Date.now(), has_token: !!token },
    }));

    if (token) {
      validateAccessToken(token, {
        jwksUrl: JWKS_URL,
        expectedServiceId: SERVICE_ID,
      })
        .then((payload) => {
          ws.send(JSON.stringify({
            type: 'debug_token_ok',
            payload: {
              user_id: payload.sub,
              room_id: payload.room_id,
              session_id: payload.session_id,
              iat: payload.iat,
              exp: payload.exp,
            },
          }));
        })
        .catch((err) => {
          ws.send(JSON.stringify({
            type: 'debug_token_error',
            payload: { message: err.message },
          }));
        });
    }

    ws.on('message', (data) => {
      ws.send(JSON.stringify({
        type: 'debug_echo',
        payload: { ts: Date.now(), len: data.length || 0, text: data.toString() },
      }));
    });
    return;
  }

  if (!token) {
    ws.send(JSON.stringify({ type: 'error', payload: { code: 'NO_TOKEN', message: 'Missing access token' } }));
    ws.close();
    return;
  }

  // Validate token
  validateAccessToken(token, {
    jwksUrl: JWKS_URL,
    expectedServiceId: SERVICE_ID,
  })
    .then((payload) => {
      session.userId = payload.sub;
      session.roomId = payload.room_id;
      session.sessionId = payload.session_id;
      authComplete = true;
      const now = Math.floor(Date.now() / 1000);
      

      // SDK does not require an auth_ok frame for direct mode.
      // Keep connection open and wait for client "join".
      if (ws.readyState !== 1) return;

      // Process any messages that arrived while authenticating
      if (pendingMessages.length > 0) {
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

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!authComplete) {
        // Queue message until auth completes
        pendingMessages.push(msg);
        return;
      }
      handleMessage(ws, session, msg);
    } catch (err) {
      console.error('[WS] Message error:', err.message);
      ws.send(JSON.stringify({ type: 'error', payload: { code: 'INVALID_MESSAGE', message: err.message } }));
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
    console.error('[WS] Error:', err.message);
  });
});

async function fetchRoomInfo(roomId) {
  try {
    const resp = await fetch(`${API_URL}/games/rooms/${encodeURIComponent(roomId)}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      return null;
    }
    const data = await resp.json();
    return data;
  } catch (err) {
    console.error('[ROOM] Error fetching room info:', err.message);
    return null;
  }
}

function handleMessage(ws, session, msg) {
  const { type, payload } = msg;
  // SDK sends seq/ts/room_id at top level, extract them
  const topSeq = msg.seq || 0;
  const topTs = msg.ts || Date.now();

  if (type === 'join') {
    let room = rooms.get(session.roomId);
    if (!room) {
      room = new RoomRuntime(session.roomId, [], MIN_PLAYERS);
      rooms.set(session.roomId, room);
    }

    // Idempotent join for retries/reconnect races.
    if (room.sessions.has(session.sessionId)) {
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
      return;
    }

    // Room already exists - add this player
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
    room.broadcast('player_joined', {
      player_id: session.userId,
      player_ids: [...room.connectedUserIds],
      waiting_for: waitingFor,
    });

    // Start if enough unique players are now connected
    if (!room.running && room.connectedUserIds.size >= room.minPlayers) {
      room.start();
    }
  } else if (type === 'input') {
    const room = rooms.get(session.roomId);
    if (!room || !room.running) return;
    
    const inputPayload = (payload && payload.action_data) || payload || {};
    const inputType = (payload && payload.action_type) || payload?.input_type || 'control';
    
    // Only log if there is an actual action (non-zero)
    if (inputPayload.turn !== 0 || inputPayload.thrust !== 0 || inputPayload.fire) {
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
    const serverTick = room ? room.serverTick : 0;
    ws.send(JSON.stringify({
      type: 'pong',
      payload: {
        room_id: session.roomId,
        server_tick: serverTick,
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

console.log(`[SERVER] Space Craft Direct Mode WebSocket Server running on port ${PORT}`);
