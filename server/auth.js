/**
 * JWT Token Validation - Direct Mode v2
 * 
 * Validates RS256 tokens issued by Usion backend using JWKS.
 */
import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';

const jwksCacheByUrl = new Map();
const AUTH_DIAG = process.env.AUTH_DIAG === '1';
const JWKS_TIMEOUT_MS = Number(process.env.JWKS_TIMEOUT_MS || 15000);
const JWKS_CACHE_MAX_AGE_MS = Number(process.env.JWKS_CACHE_MAX_AGE_MS || 300000);
const JWKS_COOLDOWN_MS = Number(process.env.JWKS_COOLDOWN_MS || 1000);

function getJWKS(jwksUrl, forceRefresh = false) {
  if (forceRefresh) {
    jwksCacheByUrl.delete(jwksUrl);
  }
  let cached = jwksCacheByUrl.get(jwksUrl);
  if (!cached) {
    cached = createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: JWKS_TIMEOUT_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
    });
    jwksCacheByUrl.set(jwksUrl, cached);
  }
  return cached;
}

function isJwksRetryableError(err) {
  const name = err?.name || '';
  const msg = String(err?.message || '');
  return (
    name === 'JWSSignatureVerificationFailed' ||
    name === 'JWKSNoMatchingKey' ||
    msg.includes('signature verification failed') ||
    msg.includes('no applicable key') ||
    msg.includes('no matching key')
  );
}

export async function validateAccessToken(token, {
  jwksUrl,
  expectedIssuer = 'usion-backend',
  expectedAudiencePrefix = 'usion-game-service:',
  expectedServiceId = null,
  expectedRoomId = null,
}) {
  let tokenServiceId = null;
  try {
    const decoded = decodeJwt(token);
    tokenServiceId = decoded?.service_id ? String(decoded.service_id) : null;
  } catch {
    tokenServiceId = null;
  }

  const resolvedServiceId = expectedServiceId || tokenServiceId;
  if (!resolvedServiceId) {
    throw new Error('Token missing service_id and expectedServiceId is not configured');
  }
  const expectedAudience = `${expectedAudiencePrefix}${resolvedServiceId}`;

  // Optional diagnostics (disabled by default to reduce auth path latency/log noise).
  if (AUTH_DIAG) {
    try {
      const decoded = decodeJwt(token);
      const now = Math.floor(Date.now() / 1000);
      console.log('[AUTH] Token claims:', decoded);
      console.log('[AUTH] Time check: now=', now, 'iat=', decoded.iat, 'exp=', decoded.exp,
        'iat_diff=', now - decoded.iat, 'exp_remaining=', decoded.exp - now);
    } catch (e) {
      console.error('[AUTH] Failed to decode token:', e.message);
    }
  }

  try {
    const verifyOptions = {
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ['RS256'],
      clockTolerance: 60, // Allow 60 seconds of clock skew
    };

    let verified;
    try {
      const jwks = getJWKS(jwksUrl);
      verified = await jwtVerify(token, jwks, verifyOptions);
    } catch (err) {
      if (!isJwksRetryableError(err)) throw err;
      // Backend restarts can rotate key material under the same kid.
      // Force-refresh JWKS and retry once before failing auth.
      const refreshedJwks = getJWKS(jwksUrl, true);
      verified = await jwtVerify(token, refreshedJwks, verifyOptions);
    }
    const { payload } = verified;

    // Additional claim checks
    if (payload.service_id !== resolvedServiceId) {
      throw new Error(`Token service_id mismatch: ${payload.service_id} != ${resolvedServiceId}`);
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
