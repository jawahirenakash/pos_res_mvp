import { randomUUID } from 'crypto';

// Process-local replay cache. In a multi-replica deployment back this with Redis
// (SET key value NX EX) so all instances share the same idempotency keys.
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const cache = new Map();

function put(key, entry) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, entry);
}

function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.exp <= Date.now()) { cache.delete(key); return null; }
  return entry;
}

export function idempotencyMiddleware() {
  return (req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'PATCH') return next();
    const key = req.get('Idempotency-Key');
    req.idempotencyKey = key || randomUUID();
    if (!key) return next();

    const scoped = `${req.user?.restaurantId || 'anon'}:${key}`;
    const cached = get(scoped);
    if (cached) {
      res.setHeader('Idempotency-Replay', 'true');
      return res.status(cached.status).json(cached.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only replay successful responses; never let a transient 4xx/5xx stick.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        put(scoped, { status: res.statusCode, body, exp: Date.now() + TTL_MS });
      }
      return originalJson(body);
    };
    next();
  };
}