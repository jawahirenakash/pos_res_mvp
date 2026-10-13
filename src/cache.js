import Redis from 'ioredis';

// Read-through cache for the two hot, rarely-changing reads (bootstrap, menu).
// With REDIS_URL set the cache is shared across instances; otherwise it is a
// bounded in-process map (correct for a single instance only).
let redis = null;
if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    redis.on('error', (err) => console.error('Redis error (cache):', err.message));
  } catch (e) {
    console.error('Redis init failed, using in-memory cache:', e.message);
    redis = null;
  }
}

const MAX_KEYS = 5000;
const memory = new Map();

export async function getCache(key) {
  if (redis) {
    const raw = await redis.get(key).catch(() => null);
    if (raw) return JSON.parse(raw);
  }
  const entry = memory.get(key);
  if (entry && entry.exp > Date.now()) return entry.val;
  if (entry) memory.delete(key);
  return null;
}

export async function setCache(key, val, ttlSeconds = 30) {
  if (redis) await redis.setex(key, ttlSeconds, JSON.stringify(val)).catch(() => {});
  if (memory.size >= MAX_KEYS && !memory.has(key)) memory.delete(memory.keys().next().value);
  memory.set(key, { val, exp: Date.now() + ttlSeconds * 1000 });
}

export async function delCache(key) {
  if (redis) await redis.del(key).catch(() => {});
  memory.delete(key);
}
