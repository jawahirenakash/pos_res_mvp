import Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

// A single Redis client shared by every limiter. If REDIS_URL is unset (or the
// connection is unusable) we fall back to an in-process limiter, which is correct
// for a single instance but NOT shared across replicas.
let redis = null;
if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    redis.on('error', (err) => console.error('Redis error (rate limit):', err.message));
  } catch (e) {
    console.error('Redis init failed, using in-memory rate limiting:', e.message);
    redis = null;
  }
}

const limiters = new Map();

export function rateLimit({ windowMs, max, scope = 'global', keyFn, message = 'Too many requests. Please slow down.' }) {
  const keyPrefix = `rl:${scope}`;
  if (!limiters.has(keyPrefix)) {
    const duration = Math.max(1, Math.floor(windowMs / 1000));
    const limiter = redis
      ? new RateLimiterRedis({ storeClient: redis, keyPrefix, points: max, duration, inMemoryBlockOnConsumed: max, inMemoryBlockDuration: duration })
      : new RateLimiterMemory({ keyPrefix, points: max, duration });
    limiters.set(keyPrefix, limiter);
  }
  const limiter = limiters.get(keyPrefix);

  return async (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    try {
      const result = await limiter.consume(key);
      res.setHeader('RateLimit-Limit', max);
      res.setHeader('RateLimit-Remaining', result.remainingPoints);
      next();
    } catch (rejRes) {
      // rate-limiter-flexible throws RateLimiterRes only when the limit is hit;
      // anything else is a store/connection error, which we fail open on so a
      // Redis hiccup cannot take the whole API down.
      if (!(rejRes instanceof RateLimiterRes)) return next();
      res.setHeader('RateLimit-Limit', max);
      res.setHeader('RateLimit-Remaining', 0);
      res.setHeader('Retry-After', Math.ceil(rejRes.msBeforeNext / 1000) || 1);
      return res.status(429).json({ error: message });
    }
  };
}