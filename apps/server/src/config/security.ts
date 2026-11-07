export const SESSION_POLICY = Object.freeze({
  cookieName: 'owntake_session',
  csrfHeader: 'x-csrf-token',
  ttlMs: 12 * 60 * 60 * 1000,
  maxSessions: 100,
  secretBytes: 32,
});

export const CONTENT_SECURITY_POLICY = Object.freeze({
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'blob:', 'data:'],
  mediaSrc: ["'self'", 'blob:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
});
