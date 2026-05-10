import type { RequestHandler } from 'express';
import { getRequestClientAddress } from './web-security.js';

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Simple token-bucket rate limiter per client IP.
 * No external dependency — in-memory only.
 */
export function createRateLimitMiddleware(opts?: {
  windowMs?: number;
  maxRequests?: number;
}): RequestHandler {
  const windowMs = opts?.windowMs ?? 60_000;
  const maxRequests = opts?.maxRequests ?? 120;

  const buckets = new Map<string, RateLimitBucket>();

  setInterval(() => {
    const cutoff = Date.now() - windowMs * 2;
    for (const [key, bucket] of buckets) {
      if (bucket.lastRefill < cutoff) buckets.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const clientKey = getRequestClientAddress({
      ip: req.ip,
      socketRemoteAddress: req.socket?.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
    });

    const now = Date.now();
    let bucket = buckets.get(clientKey);
    if (!bucket) {
      bucket = { tokens: maxRequests, lastRefill: now };
      buckets.set(clientKey, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    if (elapsed >= windowMs) {
      bucket.tokens = maxRequests;
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      res.setHeader('X-RateLimit-Remaining', String(bucket.tokens));
      next();
    } else {
      const retryAfter = Math.ceil((windowMs - (now - bucket.lastRefill)) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests, please try again later' });
    }
  };
}
