# Space Craft Direct Mode Server

Standalone WebSocket game server implementing Direct Mode v2 protocol.

## Architecture

- **Authoritative Simulation**: Server runs the game loop at 20 TPS
- **JWT Authentication**: Validates tokens via Usion backend JWKS
- **Signed Webhooks**: Submits match results with HMAC-SHA256 signatures
- **Protocol v2**: Full compliance with Direct Mode v2 spec

## Setup

```bash
cd server
npm install
cp .env.example .env
# Edit .env with your configuration
npm run dev
```

## Production Deployment

### Railway

```bash
railway login
railway init
railway add
railway up
```

Set environment variables in Railway dashboard.

### Render

Create a new Web Service:
- Build Command: `cd server && npm install`
- Start Command: `cd server && npm start`
- Add environment variables

### Environment Variables

- `PORT` - WebSocket server port (default: 8080)
- `SERVICE_ID` - Usion service ID (e.g., `space-craft`)
- `JWKS_URL` - Usion JWKS endpoint (e.g., `https://api.usion.app/.well-known/jwks.json`)
- `API_URL` - Usion API base URL (e.g., `https://api.usion.app`)
- `SIGNING_KEY_ID` - Webhook signing key ID (must match service config)
- `SIGNING_SECRET` - Webhook signing secret (must match service config)

## Protocol

### Client → Server

- `join` - Join room
- `input` - Send player input (seq, payload: {turn, thrust, fire})
- `ping` - Heartbeat
- `leave` - Leave room

### Server → Client

- `joined` - Join confirmation
- `player_joined` - Another player joined
- `player_left` - Player disconnected
- `state_delta` - Incremental state update (every tick)
- `state_snapshot` - Full state snapshot (every 20 ticks)
- `match_end` - Game finished
- `pong` - Heartbeat response
- `error` - Error message

## Testing

Start the server and connect via the Space Craft frontend with `connectionMode: "direct"` and the appropriate `ws_url`.

WebSocket endpoint: `ws://localhost:8080?token=<ACCESS_TOKEN>`
