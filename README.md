# EVE Healthcare — Diagnostic Bookings API

A backend service for booking diagnostic tests at diagnostic centres, with simulated payments and an **idempotent** payment webhook.

**Stack:** Node.js 20+, Express 5, PostgreSQL (through `pg`, using plain SQL), zod for validation, JWT (`jsonwebtoken`) and `bcryptjs`, pino for structured logs, Swagger UI for API docs, and Jest with Supertest for tests.

**Docker is not used.** Everything runs directly on your machine with Node and a local PostgreSQL.

---

## 1. Running locally

### Prerequisites
- Node.js 20 or newer
- PostgreSQL 13 or newer, running locally

### Setup

```bash
git clone <this repo> && cd EveHealthcareSolution
npm install
cp .env.example .env        # adjust DATABASE_URL etc. if needed
```

Create the databases. Run this once, as a PostgreSQL superuser:

```bash
psql -U postgres -c "CREATE USER eve WITH PASSWORD 'eve';"
psql -U postgres -c "CREATE DATABASE eve OWNER eve;"
psql -U postgres -c "CREATE DATABASE eve_test OWNER eve;"   # used by the tests
```

### Migrate, seed, run

```bash
npm run migrate     # applies migrations/*.sql
npm run seed        # admin user + sample centres/tests
npm start           # http://localhost:3000   (or: npm run dev  -> auto-restart)
```

- Swagger UI: http://localhost:3000/docs. The raw spec is at `/openapi.json`.
- Seeded admin login: `admin@eve.health` / `admin12345`. You can override it with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables.

### Tests

```bash
npm test
```

The tests run against **real PostgreSQL**, using `TEST_DATABASE_URL` (default `postgres://eve:eve@localhost:5432/eve_test`). Each test file rebuilds the schema, so don't point this at a database you care about.

The suite has 75 tests in 7 files: API tests with Supertest, unit tests for the booking state machine, and concurrency tests. The concurrency tests cover:
- 8 simultaneous deliveries of the same webhook
- 5 parallel payments for one booking
- 5 parallel requests with the same `Idempotency-Key`, repeated over several rounds because the outcome depends on timing

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgres://eve:eve@localhost:5432/eve` | Postgres connection |
| `TEST_DATABASE_URL` | `postgres://eve:eve@localhost:5432/eve_test` | Database used by `npm test` (wiped on every run) |
| `JWT_SECRET` | dev value | Signs access tokens. **Change it in any real deployment.** |
| `JWT_EXPIRES_IN_SECONDS` | `3600` | Token lifetime |
| `WEBHOOK_SECRET` | dev value | Shared HMAC secret with the payment provider |
| `PAYMENT_SUCCESS_RATE` | `0.8` | Chance that a simulated payment succeeds when no outcome is forced |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `10` | Per-IP limit on `/auth/signup` and `/auth/login` |
| `LOG_LEVEL` | `info` | pino log level |

---

## 2. API

Endpoints marked 🔒 need `Authorization: Bearer <token>`. Endpoints marked 👑 also need an admin user. Trailing slashes are optional on every path.

**Errors** always have the shape `{"detail": "..."}`. Validation errors return `422` and add `"errors": [{"path", "message"}]`, where `path` is the body field, query parameter or header at fault. Malformed JSON returns `400`; a body over 100 KB returns `413`.

**List endpoints** are paginated with `?limit=` (1–100, default 20) and `?offset=`, and return `{"items", "total", "limit", "offset"}`. The one exception is `GET /centres/:id/tests/`, which returns a plain array: a centre's offerings are a short, bounded list.

| Method | Path | Description |
|---|---|---|
| POST | `/auth/signup` | Create an account (rate limited) |
| POST | `/auth/login` | Get a JWT (rate limited) |
| GET 🔒 | `/auth/me` | Current user |
| GET | `/tests/?search=` | Test catalogue (`search` is a case-insensitive substring match) |
| POST 👑 | `/tests/` | Add a test to the catalogue |
| GET | `/centres/?city=&test_id=&include_inactive=` | List centres |
| GET | `/centres/:id` | Centre with the tests it offers and their prices |
| POST 👑 | `/centres/` | Create a centre |
| PATCH 👑 | `/centres/:id` | Update or deactivate a centre |
| GET | `/centres/:id/tests/` | Tests offered by a centre |
| PUT 👑 | `/centres/:id/tests/` | Add a test to a centre, or change its price or availability (upsert) |
| POST 🔒 | `/bookings/` | Book a test |
| GET 🔒 | `/bookings/?status=` | My bookings (admins see all bookings) |
| GET 🔒 | `/bookings/:id` | One booking |
| POST 🔒 | `/bookings/:id/cancel` | Cancel a booking |
| POST 🔒 | `/payments/` | Simulated payment (supports the `Idempotency-Key` header) |
| POST | `/payments/webhook/` | Provider callback, signed with HMAC (`X-Webhook-Signature`) |
| GET | `/health` | Liveness check |

### Example walkthrough

```bash
# sign up + log in
curl -X POST localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"riya@example.com","full_name":"Riya","password":"password123"}'
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"riya@example.com","password":"password123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')

# browse
curl 'localhost:3000/centres/?city=mumbai'
curl localhost:3000/centres/1

# book (times may include an offset; stored and returned in UTC)
curl -X POST localhost:3000/bookings/ -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"centre_id":1,"test_id":1,"appointment_at":"2030-01-15T10:30:00+05:30"}'
# -> 201 {"id":1,"amount":"349.00","status":"PENDING","appointment_at":"2030-01-15T05:00:00.000Z",...}

# pay
curl -X POST localhost:3000/payments/ -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: 6f1c0a' -H 'Content-Type: application/json' \
  -d '{"booking_id":1,"simulate_outcome":"SUCCESS"}'
# -> 201 {"status":"SUCCESS","booking_status":"CONFIRMED","provider_reference":"pay_...",...}
#    Repeating it with the same Idempotency-Key -> 200 with the same payment, no second charge.
#    (The key must be 1-128 characters; a blank or longer value is a 422.)
```

`simulate_outcome` is optional:
- `SUCCESS` or `FAILED` forces that result.
- `PENDING` leaves the payment in flight, so the provider settles it later through the webhook.
- If you leave it out, the outcome is random, using `PAYMENT_SUCCESS_RATE`.

### Webhook

```http
POST /payments/webhook/
Content-Type: application/json
X-Webhook-Signature: hex(HMAC-SHA256(WEBHOOK_SECRET, raw_body))

{"event_id":"evt_123","payment_reference":"pay_...","status":"SUCCESS","amount":"349.00","failure_reason":null}
```

`npm run webhook` plays the provider role. It signs the body and retries with exponential backoff on network errors and 5xx responses:

```bash
# create a payment with "simulate_outcome":"PENDING", then:
npm run webhook -- pay_xxx SUCCESS 349.00 --event-id evt_demo --repeat 3
# 200 {"event_id":"evt_demo","result":"processed","payment_status":"SUCCESS","booking_status":"CONFIRMED","detail":null}
# 200 {"event_id":"evt_demo","result":"duplicate",...,"detail":"Event already received; no changes made"}
# 200 {"event_id":"evt_demo","result":"duplicate",...}
```

| Situation | Response |
|---|---|
| New event, applied | `200 result=processed` |
| Same `event_id` again (replay) | `200 result=duplicate`, nothing changes |
| Same `event_id` with a *different* payload | `409` |
| New event for an already-settled payment (late or conflicting) | `200 result=ignored`. The event is recorded, but the state is not changed. |
| Bad or missing signature | `401`, nothing recorded |
| Unknown `payment_reference` | `404` |
| `amount` ≠ payment amount | `400`, nothing recorded |
| Malformed body | `400` (bad JSON) or `422` (schema) |
| `failure_reason` sent with `status=SUCCESS` | `422`, nothing recorded |

Replays return 2xx on purpose. A provider keeps retrying until it gets a success response, so an idempotent duplicate should be acknowledged rather than rejected.

---

## 3. Database design

The schema lives in `migrations/001_initial_schema.sql`. `src/migrate.js` is a small runner that applies each SQL file once, inside a transaction, and records it in a `schema_migrations` table.

```
users
  id, email (unique, lower-cased), full_name, password_hash, is_admin

diagnostic_centres                    diagnostic_tests (catalogue)
  id, name, address, city, is_active    id, name (unique), description
  unique(name, city)                          │
        │                                     │
        └──────── centre_tests ───────────────┘   "test X at centre Y costs ₹P"
                   centre_id, test_id, price NUMERIC(10,2) CHECK > 0, is_available
                   unique(centre_id, test_id)

bookings
  id, user_id, centre_id, test_id, appointment_at TIMESTAMPTZ
  amount NUMERIC(10,2)          ← price snapshot taken at booking time
  status booking_status ENUM(PENDING, CONFIRMED, FAILED, CANCELLED)
  UNIQUE (user_id, centre_id, test_id, appointment_at) WHERE status IN (PENDING, CONFIRMED)

payments
  id, booking_id, user_id, amount, status payment_status ENUM(PENDING, SUCCESS, FAILED)
  provider_reference (unique)   ← what the provider sends back in webhooks
  idempotency_key, UNIQUE (user_id, idempotency_key)
  failure_reason, processed_at
  UNIQUE (booking_id) WHERE status IN (PENDING, SUCCESS)

webhook_events
  id, event_id (unique), payment_id, status, payload_hash (sha256), result, received_at
```

Key decisions:
- **Catalogue and price list are separate tables.** A test such as "CBC" exists once; each centre sets its own price in `centre_tests`.
- **A booking stores the price it was made at.** Later price changes don't touch existing bookings, and a payment always charges `booking.amount`. The client never sends an amount.
- **Money is `NUMERIC(10,2)` in Postgres and a decimal string in Node** (`"349.00"`). Comparisons go through integer cents (`src/money.js`), so floats never touch money.
- **The database enforces the invariants that matter under concurrency:**
  - one pending-or-successful payment per booking (partial unique index), so a booking can't be paid twice;
  - one active booking per user, centre, test and time (partial unique index);
  - a unique `webhook_events.event_id`, so an event is applied at most once;
  - a unique `(user_id, idempotency_key)`, so a client retry can't create a second payment.
- **Timestamps are `TIMESTAMPTZ`.** Foreign keys on users, bookings and payments use `RESTRICT`, so financial history can't be deleted by accident.
- **Plain SQL with `pg`, no ORM.** The row locks (`FOR UPDATE`), partial indexes and transactions are central to correctness here, and I wanted them visible in the code.

### Booking state machine

```
            pay SUCCESS
 PENDING ───────────────► CONFIRMED
   │  ▲  \                    │
   │  │   \ pay FAILED        │ cancel
   │  │    ▼                  ▼
   │  └── FAILED ───────► CANCELLED
   │   retry payment  cancel   ▲
   └───────────────────────────┘ cancel
```

All transitions go through `ALLOWED_TRANSITIONS` in `src/services/bookings.js`. An illegal transition returns `409 Conflict`. Payments only move from `PENDING` to `SUCCESS` or `FAILED` and never move again, so a late or replayed provider event can't flip a settled payment.

### How webhook idempotency works (`src/services/payments.js`)

1. **Event deduplication.** The `event_id` is inserted into `webhook_events` (UNIQUE) in the **same transaction** as the state change. Two things follow from that:
   - A replay finds the stored row and returns `duplicate`.
   - If processing crashes, the transaction rolls back and nothing is recorded, so the provider's retry is processed normally instead of being swallowed as a duplicate. There is a test for this case.
2. **State-level idempotency.** A *different* event that targets an already-settled payment is recorded as `ignored`. It cannot change the payment or the booking.
3. **Concurrency.** The booking and payment rows are locked with `SELECT … FOR UPDATE`, always in the order booking → payment, to avoid deadlocks. If two simultaneous deliveries of the same event race, the unique constraint makes the slower one fail. That error is caught and the delivery is answered as `duplicate`.
4. **Integrity checks.**
   - The HMAC signature is verified, with a constant-time comparison, over the **raw** request bytes before the body is trusted.
   - The payload `amount` must match the payment amount.
   - If the same `event_id` arrives with a different payload, the request gets a 409; the stored `payload_hash` is what detects this.
   - A `SUCCESS` event may not carry a `failure_reason`; that combination is rejected as a `422`.

The same care applies to client retries on `POST /payments/`. A repeated `Idempotency-Key` is checked once up front, and checked **again after the booking row lock is taken**. Without the second check, a retry that was queued behind the original request would see a booking that is already paid and fail with `409` instead of receiving the original payment back.

---

## 4. Edge cases handled

- **Validation (zod):** bad email, short password, blank names, malformed datetimes, ids sent as strings, non-positive prices or prices with more than 2 decimal places, unknown enum values and out-of-range pagination all return `422`. Malformed JSON returns `400` and an oversized body `413`. Unknown fields are stripped, so for example signup cannot set `is_admin`. Free-text filters have a length cap, and `%` / `_` in `?search=` are matched literally rather than as SQL wildcards.
- **Auth:**
  - A missing, invalid or expired token returns `401`.
  - Non-admins calling catalogue write endpoints get `403`.
  - Login returns the same error for an unknown email and a wrong password.
  - Email addresses are case-insensitive.
  - Login and signup are rate limited, returning `429` with a `Retry-After` header.
- **Ownership:** another user's booking returns `404`, for viewing, cancelling and paying alike. The response doesn't reveal whether that booking id exists.
- **Bookings:**
  - Appointments in the past are rejected.
  - Unknown centres or tests are rejected.
  - A test the centre doesn't offer, or has marked unavailable, is rejected.
  - Inactive centres are rejected.
  - A duplicate active booking is rejected. The slot can be booked again after a cancellation.
- **Payments:**
  - Paying for a CONFIRMED or CANCELLED booking is rejected, and so is paying when the appointment time has already passed.
  - A second payment is rejected while one is in progress, including when the requests arrive concurrently.
  - Cancelling is blocked while a payment is pending.
  - Reusing an `Idempotency-Key` for a different booking returns `409`.
  - Retrying after a FAILED payment is allowed.
- **Webhook:** see the table above.

## 5. Bonus items included

- **Swagger / OpenAPI:** `/docs`.
- **Tests:** 75 tests (unit, API and concurrency).
- **Structured JSON logging (pino):** every request is logged with an `X-Request-ID`. That id is propagated through `AsyncLocalStorage`, so service-level logs carry it too, including every booking status change.
- **Pagination:** on all list endpoints.
- **Rate limiting:** on the auth endpoints.
- **Webhook retry handling:** failed processing is not recorded, so it can be retried safely, and the provider-simulator script retries with backoff.
- **SQL migrations, a seed script and graceful shutdown.**

## 6. Assumptions

- Admins are created with `npm run seed` or directly in the database. Public signup only ever creates patients.
- A booking belongs to the logged-in user. There are no family-member profiles.
- `POST /payments/` stands in for the payment provider. With `simulate_outcome=PENDING` it behaves like an asynchronous provider that reports back through the webhook.
- Admins can view every booking but can't pay for one on a patient's behalf.
- A confirmed booking can be cancelled. Refunds are out of scope.
- Centres have no capacity or time slots, so any future time can be booked.
- A datetime without a timezone is read as UTC.

## 7. What I would do with more time

- **Shared state across instances.** The rate limiter is in-memory, so each process counts separately. Redis would fix that, and could also cache the centre and catalogue lists.
- **Queue-based webhooks.** Store the raw event, acknowledge it quickly, and process it in the background with retries and a dead-letter queue.
- **Webhook replay protection.** Put a timestamp inside the signed payload so a captured request can't be replayed later.
- **Reconciliation and refunds.** A job for payments stuck in `PENDING`, and a refund flow for cancelled confirmed bookings.
- **Slots and capacity,** with database-level protection against overbooking.
- **Auth hardening.** Refresh tokens, revocation, email verification and password reset.
- **Case-insensitive test names.** `diagnostic_tests.name` is unique, but "cbc" and "CBC" count as different names. A unique index on `lower(name)` would close that gap.
- **Audit trail** for booking and payment status changes, plus TypeScript, linting and CI against a Postgres service.

---

## Project layout

```
src/
  server.js            starts the HTTP server (graceful shutdown)
  app.js               express app: middleware, routes, docs, error handler
  config.js            settings from env / .env
  db.js                pg pool + withTransaction helper
  migrate.js           tiny SQL migration runner
  schemas.js           zod request schemas (validation + coercion)
  money.js             decimal-string money helpers
  errors.js            domain errors → HTTP status
  logger.js            pino + request-id context
  middleware/          auth, validate, rateLimit, requestContext, errorHandler
  routes/              thin HTTP layer: auth, centres, bookings, payments
  services/            business logic: auth, centres, bookings (state machine), payments (+ webhook)
migrations/            001_initial_schema.sql
scripts/               migrate.js, seed.js, sendWebhook.js (provider simulator)
tests/                 Jest + Supertest suite
openapi.yaml           API spec served at /docs
```
