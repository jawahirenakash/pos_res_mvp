# TableTap POS — MVP starter (hardened)

Responsive restaurant POS starter for the USA and India. Browser app + Express REST API + PostgreSQL. Includes login/roles, menu, orders, kitchen tickets, inventory movements, daily reports, an audit log, and protections against brute force, token forgery, XSS, clickjacking and CORS abuse.

**Not production-certified.** Payments are a local ledger only (no card charging / UPI). Tax is a single configurable percentage and is not a tax-compliance engine. Finish the remaining items at the bottom before live use.

## Requirements
- Node.js 20+ and npm
- Docker Desktop (recommended) or PostgreSQL 15+

## Quick start
1. Extract the ZIP and open a terminal in `tabletap-pos-mvp`.
2. Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell; `cp .env.example .env` on macOS/Linux).
3. Fill in secrets — the app will refuse to start with placeholders or weak values:
   - `JWT_SECRET`: generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` (32+ chars required).
   - `POSTGRES_PASSWORD`: any strong value; keep the password inside `DATABASE_URL` identical.
   - `SEED_OWNER_PASSWORD`: optional — leave blank and the seeder generates one and prints it once.
4. Start the database: `docker compose up -d db`.
5. Install dependencies: `npm install`.
6. Create the schema: `npx prisma migrate dev --name init`.
7. Seed demo data: `npm run db:seed`.
8. Start the server: `npm run dev`.
9. Open `http://localhost:4000`.

Demo login: `owner@tabletap.local` / the `SEED_OWNER_PASSWORD` from your `.env`. The app forces a password change on first sign-in, so the shared seed password cannot survive into real use.

## Deploy to Render
`render.yaml` is a Render Blueprint: one click provisions the Node web service plus a managed PostgreSQL and wires `DATABASE_URL`, a generated `JWT_SECRET`, and a generated `SEED_OWNER_PASSWORD`.

1. Push this repo to GitHub (e.g. `pos_res_mvp`).
2. In the Render dashboard: **New → Blueprint Instance** → select the repo. Render detects `render.yaml` and creates the database + web service.
3. After the first deploy: **Dashboard → posres-mvp → Environment → SEED_OWNER_PASSWORD** to get the demo owner password.
4. Open the service URL and sign in as `owner@tabletap.local` — the app forces a password change on first sign-in.

Notes:
- The free Postgres instance auto-expires after 30 days; upgrade to a paid tier for a persistent app.
- `preDeployCommand` is paid-only, so migrations and the first-run seed run in `startCommand` (`prisma migrate deploy && npm run db:seed && npm start`). With `SEED_SKIP_IF_DATA=1` the seed is skipped once data exists, so restarts and spin-ups never reset the demo data. Set it to `0` (or run `npm run db:seed` from the service **Shell**) to re-seed.
- Redis (shared rate-limit/cache across instances) is optional and paid: add a Render Redis and set `REDIS_URL`. One instance runs fine without it.
- Free web services spin down when idle; the first request after idle takes a few seconds to wake.

## Tests
- `npm test` — unit tests only (config validation, password policy, rate limiter, idempotency). No database required.
- `npm run test:smoke` — live E2E against a running app + database: auth, security headers, forged tokens, password change, order/payment lifecycle, rate limiting, tenant isolation. It restores all data changes when done.
- `npm run test:race` — concurrency proof: fires 40 (or `RACE_N=200`) simultaneous orders and asserts every order number is unique. Confirms the atomic allocator under parallel terminals.

## Scaling for many terminals and restaurants
- **Atomic order numbers** (`src/order-number.js`): a single `INSERT … ON CONFLICT DO UPDATE … RETURNING` on `RestaurantOrderCounter` serializes allocation per restaurant, so hundreds of terminals can order at once with zero collisions (verified by `test:race`). The old `max(orderNumber) + 1` retry loop is gone.
- **Shared rate limiting & caching** (`src/rate-limit.js`, `src/cache.js`): set `REDIS_URL` to share limits and cached reads across app instances; without it the app uses an in-process fallback (correct for one instance only). Raise `RATE_LIMIT_GLOBAL` when many terminals share one NAT IP.
- **Idempotent writes** (`src/idempotency.js`): send an `Idempotency-Key` header on `POST`/`PATCH` to safely retry orders and payments without double-charging or duplicate records.
- **Bounded list queries**: `GET /api/orders` accepts `status` and `limit` (1–200, default 100).
- **Run more instances**: put the app behind a load balancer, set `TRUST_PROXY=1`, enable the bundled Redis (`docker compose --profile scale up -d`), and tune DB pooling with `connection_limit`/`pool_timeout` on `DATABASE_URL` (use PgBouncer for high connection counts).

## Security done in this pass
- **Boot guard** (`src/validate.js`): rejects missing, short, placeholder and low-entropy `JWT_SECRET` values; the old `.env.example` placeholder can no longer boot the server.
- **Headers** (`helmet`): CSP (`default-src 'self'`, no inline scripts), `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `nosniff`, no-referrer, same-origin COOP, HSTS only in production.
- **CORS off by default** (the UI is same-origin). Allowlist via `CORS_ORIGINS` for separate frontends.
- **Rate limiting** (`src/rate-limit.js`): per-IP global cap (default 1200/min, `RATE_LIMIT_GLOBAL`) plus 10 login attempts per 15 min per (IP, email). Uses Redis when `REDIS_URL` is set so limits are shared across instances. **Account lockout**: 8 failed logins → 15 min lock, persisted in the DB.
- **Passwords**: 12+ chars with letters and numbers; `POST /api/auth/change-password`; seeded account is flagged `mustChangePassword` until the user sets a private one. No hardcoded credentials left in the HTML.
- **Tokens**: JWT with issuer/audience claims, `HS256`, 8h expiry; forged/wrongly-issued tokens rejected (verified in tests).
- **Input validation** (zod) on every endpoint, including the orders `status` filter, and bounded payment/stock amounts.
- **Race-safe order numbering** (`src/order-number.js`): atomic per-restaurant counter instead of a `findFirst + 1` retry loop; collision-free under concurrent terminals.
- **Idempotency** (`src/idempotency.js`): repeat `POST`/`PATCH` requests with the same `Idempotency-Key` replay the first successful response instead of writing again.
- **Read caching** (`src/cache.js`): `/api/bootstrap` (30s) and `/api/menu` (60s) are cached and invalidated on menu changes; Redis-backed when configured.
- **Audit log**: `AuditLog` table records logins (success/failure/block), password changes, order create/status, payments, stock movements and menu changes, with actor, entity, detail JSON and IP.
- **DB exposure**: Postgres container binds to `127.0.0.1` only; `POSTGRES_PASSWORD` is required from `.env` (no public default creds).

## Accepted / remaining items
- `npm audit` reports 1 advisory (CVSS 0.0, dev-only): `deepmerge-ts < 8` inside the **Prisma CLI** (`prisma` → `@prisma/config`). It is not used at runtime and is not reachable from request data. Optional cleanup: `npm audit fix --force` (downgrades `prisma`/`@prisma/client` to 6.12).
- JWT is still stored in `localStorage` (browser-only). CSP mitigates XSS; a refresh-token/session strategy, MFA and staff administration remain roadmap items.
- Payments/UPI, jurisdiction tax (US state/local or India GST), thermal printers, offline sync and backups are not implemented (see below).

## Main files
```
prisma/schema.prisma  Database models and relations (incl. AuditLog)
prisma/seed.js        Demo restaurant, owner, menu, tables, ingredients
src/server.js         REST API, validation, order calculations, reports
src/auth.js           JWT authentication and role checks
src/validate.js       Pure config-/password-validation helpers
src/config.js         Loads and guards environment configuration
src/rate-limit.js     Rate limiter (Redis-backed, in-process fallback)
src/cache.js          Read cache for bootstrap/menu (Redis + memory fallback)
src/idempotency.js    Idempotency-key middleware for safe write retries
src/order-number.js   Atomic per-restaurant order-number allocation
src/audit.js          Fire-and-forget audit log writer
src/db.js             Prisma database client
public/               Responsive app shell (billing, kitchen, inventory, reports)
test/                 Unit tests + live smoke suite
scripts/              smoke.mjs (E2E), concurrency.mjs (race proof), cleanup-db.mjs
```

## UI (design system)
- **Style**: Flat 2.0 surfaces + Bento grids (reports/inventory) + glass accents on the header, login card and modals.
- **Design tokens** (`public/styles.css`): three layers — primitive (palette, spacing, radii, motion) → semantic (color roles like `--text-muted`, `--danger`) → component. `:root[data-theme="dark"]` switches the whole scheme; the dark palette is authored to meet WCAG AA (4.5:1 body / 3:1 large), verified in both themes.
- **Themes**: light default, dark + system detection, and a manual toggle (persisted as `localStorage.tabletap_theme`). The theme is applied before first paint by `public/theme.js` (external, CSP-safe) to avoid a flash of the wrong theme.
- **CSP-compatible rendering**: the app's strict CSP (`style-src 'self'`, no inline scripts) means progress/stock/ranked bars are painted via CSSOM (`element.style.width`) instead of inline `style` attributes. Keep new UI code on external scripts and CSSOM writes.
- **Accessibility & motion**: visible focus rings, `aria-label`s, role/status announcements, `prefers-reduced-motion` support and responsive breakpoints at 1050px/650px (the kitchen view collapses to a grid at 650px).

## API endpoints
Except `/api/health` and `/api/auth/login`, routes require `Authorization: Bearer <JWT>`.
- `POST /api/auth/login` — sign in (rate-limited, account lockout)
- `POST /api/auth/change-password` — change password, clears `mustChangePassword`
- `GET /api/bootstrap`, `GET /api/me` — restaurant/menu/user setup
- `GET/POST /api/menu`; `PATCH /api/menu/:id/availability`
- `GET /api/orders` — optional `status` filter and `limit` (1–200, default 100)
- `POST /api/orders`; `PATCH /api/orders/:id/status` (send `Idempotency-Key` to make retries safe)
- `POST /api/orders/:id/payments` — **manual ledger entry only**, no actual money collection (returns `demoMode: true`)
- `GET /api/kitchen`
- `GET /api/inventory`; `POST /api/inventory/:id/movement`
- `GET /api/reports/daily`

## Database models
`Restaurant`, `User` (incl. lockout/force-change fields), `Category`, `MenuItem`, `DiningTable`, `Order`, `OrderItem`, `Payment`, `Ingredient`, `StockMovement`, `AuditLog`, `RestaurantOrderCounter`. Prices/totals use decimal columns; order lines snapshot name and price. Operational records carry `restaurantId`; tenant isolation is enforced per query and covered by a smoke test, but additional account-management work is needed before offering multi-tenant SaaS.

## USA and India configuration
Configure each restaurant's country, currency and timezone. One `taxRate` is demo-only; before launch implement US state/city/local sales tax or India CGST/SGST/IGST with professional tax review.

## Must-do before live use
1. Staff management (create users per role), MFA, session refresh/rotation, and password reset by email.
2. Refund/void flows with reasons, shift/cash reconciliation, receipt/thermal-printer integration.
3. Payment-provider sandbox integration with verified webhooks (never mark paid on a browser request alone).
4. Jurisdiction-aware tax engine and compliant invoices for the first launch region.
5. Recipe-level stock deduction, purchase receiving, counts and reconciliation.
6. Offline queue/sync, automated CI tests, monitoring, backups and restore drills.
7. Deploy over HTTPS behind a reverse proxy (`TRUST_PROXY=1`, HSTS active) and run a security review.