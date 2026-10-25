// HS256 JSON Web Tokens with node:crypto only: the receiver issues and verifies its own tokens, so a
// single symmetric secret is enough and a library would add nothing. base64url is a Buffer encoding
// in Node, and the signature comparison is constant-time so a forged one leaks nothing by timing.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtClaims {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  [claim: string]: unknown;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function hmac(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${HEADER}.${payload}`;
  return `${input}.${hmac(input, secret)}`;
}

/** Claims of a well-formed, correctly signed, unexpired token; null otherwise. */
export function verifyJwt(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = Buffer.from(hmac(`${header}.${payload}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown };
    if (head.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}
