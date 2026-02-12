/**
 * JWT Token Validation - Direct Mode v2
 * 
 * Validates RS256 tokens issued by Usion backend using JWKS.
 */
import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';

let jwksCache = null;

function getJWKS(jwksUrl) {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(jwksUrl));
  }
  return jwksCache;
}

export async function validateAccessToken(token, {
  jwksUrl,
  expectedIssuer = 'usion-backend',
  expectedAudiencePrefix = 'usion-game-service:',
  expectedServiceId,
  expectedRoomId = null,
}) {
  const jwks = getJWKS(jwksUrl);
  const expectedAudience = `${expectedAudiencePrefix}${expectedServiceId}`;

  // Debug: decode without verification to inspect claims
  try {
    const decoded = decodeJwt(token);
    const now = Math.floor(Date.now() / 1000);
    console.log('[AUTH] Token claims:', decoded); // Log ALL claims
    console.log('[AUTH] Time check: now=', now, 'iat=', decoded.iat, 'exp=', decoded.exp,
      'iat_diff=', now - decoded.iat, 'exp_remaining=', decoded.exp - now);
  } catch (e) {
    console.error('[AUTH] Failed to decode token:', e.message);
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ['RS256'],
      clockTolerance: 60, // Allow 60 seconds of clock skew
    });

    // Additional claim checks
    if (payload.service_id !== expectedServiceId) {
      throw new Error(`Token service_id mismatch: ${payload.service_id} != ${expectedServiceId}`);
    }

    if (expectedRoomId && payload.room_id !== expectedRoomId) {
      throw new Error(`Token room_id mismatch: ${payload.room_id} != ${expectedRoomId}`);
    }

    if (!payload.permissions || !payload.permissions.includes('play')) {
      throw new Error("Token missing 'play' permission");
    }

    if (!payload.session_id) {
      throw new Error("Token missing session_id");
    }

    return payload;
  } catch (err) {
    throw new Error(`Token validation failed: ${err.message}`);
  }
}
