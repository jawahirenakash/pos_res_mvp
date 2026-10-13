import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSecret, checkPassword, parseOrigins, loadConfig } from '../src/validate.js';
import { rateLimit } from '../src/rate-limit.js';
import { idempotencyMiddleware } from '../src/idempotency.js';

const GOOD_SECRET = 'a3f9c1d47b2e8056f1c9a4d7e0b3825f6a1c9d4e7b0285f3a6c9d1e4b7082f5a';

test('checkSecret rejects missing, short, placeholder and low-entropy values', () => {
  assert.match(checkSecret(''), /required/);
  assert.match(checkSecret(undefined), /required/);
  assert.match(checkSecret('short-secret'), /at least/);
  // The exact value that used to ship in .env.example must no longer pass.
  assert.match(checkSecret('replace-with-a-random-secret-at-least-24-characters'), /placeholder/);
  assert.match(checkSecret('CHANGE-ME-please-change-me-now-change-me'), /placeholder/);
  assert.match(checkSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /predictable/);
});

test('checkSecret accepts a real random secret', () => {
  assert.equal(checkSecret(GOOD_SECRET), null);
});

test('checkPassword enforces length and character mix', () => {
  assert.match(checkPassword('short1A'), /at least/);
  assert.match(checkPassword('abcdefghijklmnop'), /letters and numbers/);
  assert.match(checkPassword('1234567890123456'), /letters and numbers/);
  assert.equal(checkPassword('TtRFB8QC9v6fxS7'), null);
});

test('parseOrigins trims, drops blanks and splits on commas', () => {
  assert.deepEqual(parseOrigins(' https://a.example , ,https://b.example '), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins(undefined), []);
});

test('loadConfig fails fast without a usable JWT_SECRET', () => {
  assert.throws(() => loadConfig({}), /JWT_SECRET/);
  assert.throws(() => loadConfig({ JWT_SECRET: 'replace-with-a-random-secret-at-least-24-characters' }), /placeholder/);
});

test('loadConfig builds a config object from the environment', () => {
  const cfg = loadConfig({ JWT_SECRET: GOOD_SECRET, PORT: '5000', NODE_ENV: 'production', CORS_ORIGINS: 'https://pos.example', TRUST_PROXY: '1' });
  assert.equal(cfg.port, 5000);
  assert.equal(cfg.isProd, true);
  assert.deepEqual(cfg.corsOrigins, ['https://pos.example']);
  assert.equal(cfg.trustProxy, true);
  assert.equal(cfg.globalRateLimit, 1200);
  assert.equal(loadConfig({ JWT_SECRET: GOOD_SECRET, RATE_LIMIT_GLOBAL: '9000' }).globalRateLimit, 9000);
});

test('rateLimit allows up to the limit and then returns 429', async () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 2, scope: 'test' });
  const make = () => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json() { return this; } };
    return { req: { ip: '10.0.0.1' }, res, nexted: false };
  };
  const calls = [make(), make(), make()];
  for (const c of calls) await limiter(c.req, c.res, () => { c.nexted = true; });
  assert.equal(calls[0].res.statusCode, 200);
  assert.equal(calls[1].res.statusCode, 200);
  assert.equal(calls[2].res.statusCode, 429);
  assert.equal(calls[1].nexted, true);
  assert.equal(calls[2].nexted, false);
  assert.equal(calls[2].res.headers['Retry-After'] > 0, true);
});

test('idempotency replays a successful response for a repeated key', () => {
  const mw = idempotencyMiddleware();
  const makeReq = (key) => ({ method: 'POST', user: { restaurantId: 'rest-a' }, get: (n) => (n === 'Idempotency-Key' ? key : undefined) });
  const makeRes = () => ({ headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

  // First call runs the handler and caches the 201 body.
  const r1 = makeRes();
  let nexted1 = false;
  mw(makeReq('key-1'), r1, () => { nexted1 = true; r1.status(201); r1.json({ id: 'order-1' }); });
  assert.equal(nexted1, true);
  assert.equal(r1.headers['Idempotency-Replay'], undefined);

  // Second call with the same key must NOT run the handler; it replays the body.
  const r2 = makeRes();
  let nexted2 = false;
  mw(makeReq('key-1'), r2, () => { nexted2 = true; });
  assert.equal(nexted2, false);
  assert.equal(r2.statusCode, 201);
  assert.deepEqual(r2.body, { id: 'order-1' });
  assert.equal(r2.headers['Idempotency-Replay'], 'true');
});

test('idempotency does not cache failed responses and is scoped per restaurant', () => {
  const mw = idempotencyMiddleware();
  const req = (key, rid) => ({ method: 'POST', user: { restaurantId: rid }, get: (n) => (n === 'Idempotency-Key' ? key : undefined) });
  const res = () => ({ headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

  // A 400 must not be cached, so a retry runs the handler again.
  const bad = res();
  mw(req('key-2', 'rest-a'), bad, () => { bad.status(400); bad.json({ error: 'bad' }); });
  const retry = res();
  let retried = false;
  mw(req('key-2', 'rest-a'), retry, () => { retried = true; });
  assert.equal(retried, true);

  // The same key from a different restaurant must not see the other tenant's result.
  const a = res();
  mw(req('key-3', 'rest-a'), a, () => { a.status(201); a.json({ id: 'a-only' }); });
  const b = res();
  let bRan = false;
  mw(req('key-3', 'rest-b'), b, () => { bRan = true; b.status(201); b.json({ id: 'b-only' }); });
  assert.equal(bRan, true);
  assert.deepEqual(b.body, { id: 'b-only' });
});
