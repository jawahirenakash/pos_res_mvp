// Pure, side-effect-free validation helpers. Safe to unit test without env or a database.

export const PASSWORD_MIN = 12;
export const SECRET_MIN = 32;

// Values that ship in .env.example / docs and must never be used as a real secret.
const PLACEHOLDER_PATTERNS = [
  /^replace[-_ ]?with/i,
  /^change[-_ ]?me/i,
  /^your[-_ ]?(secret|key)/i,
  /^secret$/i,
  /^test$/i,
  /placeholder/i,
  /example/i
];

// Returns null when the secret is acceptable, otherwise a human-readable reason.
export function checkSecret(secret) {
  if (typeof secret !== 'string' || !secret.trim()) return 'JWT_SECRET is required. Copy .env.example to .env and set it.';
  const value = secret.trim();
  if (value.length < SECRET_MIN) return `JWT_SECRET must be at least ${SECRET_MIN} characters of random data.`;
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(value))) return 'JWT_SECRET is still an example placeholder. Generate a real random secret.';
  if (new Set(value).size < 10) return 'JWT_SECRET looks too predictable. Generate 32+ random characters.';
  return null;
}

// Returns null when the password meets policy, otherwise a human-readable reason.
export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password must include both letters and numbers.';
  return null;
}

export function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function loadConfig(env = {}) {
  const secretProblem = checkSecret(env.JWT_SECRET);
  if (secretProblem) throw new Error(secretProblem);
  const nodeEnv = env.NODE_ENV || 'development';
  return {
    env: nodeEnv,
    isProd: nodeEnv === 'production',
    port: Number(env.PORT || 4000),
    jwtSecret: String(env.JWT_SECRET).trim(),
    tokenTtl: env.TOKEN_TTL || '8h',
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    trustProxy: ['1', 'true', 'yes'].includes(String(env.TRUST_PROXY || '').toLowerCase()),
    // Coarse per-IP flood guard. Many terminals usually share one NAT IP, so the
    // default is deliberately generous; the strict limits live on login and per user.
    globalRateLimit: Number(env.RATE_LIMIT_GLOBAL || 1200),
    businessName: env.BUSINESS_NAME || 'TableTap Demo Restaurant'
  };
}
