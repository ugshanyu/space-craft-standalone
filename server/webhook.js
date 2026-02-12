/**
 * Signed Webhook for Match Result Submission - Direct Mode v2
 * 
 * Implements HMAC-SHA256 signature as specified.
 */
import crypto from 'crypto';
import fetch from 'node-fetch';

function buildCanonicalString(timestamp, method, path, bodyBytes) {
  const bodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

function computeSignature(secret, canonical) {
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export async function submitMatchResult({
  apiUrl,
  serviceId,
  signingKeyId,
  signingSecret,
  roomId,
  sessionId,
  winnerIds,
  participants,
  reason = 'completed',
  finalStats = {},
}) {
  const path = '/games/direct/results';
  const endpoint = `${apiUrl.replace(/\/$/, '')}${path}`;
  const idempotencyKey = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));

  const body = {
    room_id: roomId,
    session_id: sessionId,
    service_id: serviceId,
    winner_ids: winnerIds,
    participants,
    reason,
    final_stats: finalStats,
    ended_at: new Date().toISOString(),
  };
  const bodyBytes = Buffer.from(JSON.stringify(body), 'utf-8');

  const canonical = buildCanonicalString(timestamp, 'POST', path, bodyBytes);
  const signature = computeSignature(signingSecret, canonical);

  const headers = {
    'Content-Type': 'application/json',
    'X-Usion-Service-Id': serviceId,
    'X-Usion-Key-Id': signingKeyId,
    'X-Usion-Signature': signature,
    'X-Usion-Timestamp': timestamp,
    'X-Idempotency-Key': idempotencyKey,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: bodyBytes,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook failed (${response.status}): ${text}`);
  }

  const result = await response.json();
  console.log('[WEBHOOK] Match result submitted:', {
    roomId,
    matchId: result.match_id,
    duplicate: result.duplicate,
  });
  return result;
}
