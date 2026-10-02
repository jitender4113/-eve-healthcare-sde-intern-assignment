const crypto = require('crypto');
const config = require('../config');
const { pool, withTransaction } = require('../db');
const { BadRequest, Conflict, NotFound, isUniqueViolation } = require('../errors');
const { logger } = require('../logger');
const { toCents } = require('../money');
const { getBookingForUser, hasPendingPayment, setBookingStatus } = require('./bookings');

const PAYMENT_COLUMNS =
  'id, booking_id, user_id, amount, status, provider_reference, idempotency_key, failure_reason, created_at, processed_at';

function toPaymentResponse(payment, bookingStatus) {
  const { user_id: _u, idempotency_key: _k, ...rest } = payment;
  return { ...rest, booking_status: bookingStatus };
}

async function findByIdempotencyKey(db, userId, key) {
  const { rows } = await db.query(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key],
  );
  return rows[0];
}

async function bookingStatusOf(db, bookingId) {
  const { rows } = await db.query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
  return rows[0].status;
}

/** Stand-in for the external payment provider's decision. */
function simulateProvider() {
  if (Math.random() < config.paymentSuccessRate) return { outcome: 'SUCCESS', reason: null };
  const reasons = ['Card declined', 'Insufficient funds', 'Bank timeout'];
  return { outcome: 'FAILED', reason: reasons[Math.floor(Math.random() * reasons.length)] };
}

/**
 * Settle a payment (and its booking). Payments only ever move
 * PENDING -> SUCCESS | FAILED, so a replayed or out-of-order event can never
 * flip a settled payment. Returns "processed" or "ignored". Caller holds row locks.
 */
async function applyPaymentOutcome(db, payment, booking, outcome, failureReason = null) {
  if (payment.status !== 'PENDING') {
    if (payment.status !== outcome) {
      logger.warn(
        { payment_id: payment.id, current: payment.status, received: outcome },
        'conflicting payment outcome ignored',
      );
    }
    return 'ignored';
  }

  const reason = outcome === 'FAILED' ? failureReason || 'Payment failed' : null;
  const { rows } = await db.query(
    `UPDATE payments SET status = $2, failure_reason = $3, processed_at = now(), updated_at = now()
     WHERE id = $1 RETURNING ${PAYMENT_COLUMNS}`,
    [payment.id, outcome, reason],
  );
  Object.assign(payment, rows[0]);

  // Cancelling is blocked while a payment is pending, so the booking is
  // always PENDING here; guard anyway rather than corrupt state.
  if (booking.status === 'PENDING') {
    await setBookingStatus(db, booking, outcome === 'SUCCESS' ? 'CONFIRMED' : 'FAILED');
  } else {
    logger.error(
      { payment_id: payment.id, booking_status: booking.status },
      'payment settled for booking in unexpected state',
    );
  }
  logger.info({ payment_id: payment.id, status: outcome }, 'payment settled');
  return 'processed';
}

/**
 * Start a simulated payment and (unless PENDING is requested) settle it right
 * away. Returns { payment, created }. Replaying an Idempotency-Key returns the
 * original payment with created=false.
 */
async function createPayment(user, { booking_id, simulate_outcome }, idempotencyKey) {
  // Fast path: a plain retry of a request we already finished.
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(pool, user.id, idempotencyKey);
    if (existing) return replayIdempotentPayment(pool, existing, booking_id);
  }

  try {
    return await withTransaction(async (client) => {
      const booking = await getBookingForUser(client, booking_id, user, { lock: true });
      // Admins may view any booking but must not pay on a patient's behalf.
      if (booking.user_id !== user.id) throw NotFound('Booking not found');

      // Slow path: the same key may be in flight on another connection. Those
      // requests queue on the booking lock above, so by the time we get it the
      // winner has committed. Check the key again *before* the status checks,
      // otherwise a legitimate retry fails with "already paid" instead of
      // getting the original payment back.
      if (idempotencyKey) {
        const existing = await findByIdempotencyKey(client, user.id, idempotencyKey);
        if (existing) return replayIdempotentPayment(client, existing, booking_id);
      }

      if (booking.status === 'CONFIRMED') throw Conflict('Booking is already paid');
      if (booking.status === 'CANCELLED') throw Conflict('Cannot pay for a cancelled booking');
      if (await hasPendingPayment(client, booking.id)) {
        throw Conflict('A payment for this booking is already in progress');
      }
      if (new Date(booking.appointment_at) <= new Date()) {
        throw Conflict('Cannot pay for a booking whose appointment time has passed');
      }

      if (booking.status === 'FAILED') await setBookingStatus(client, booking, 'PENDING'); // retry

      const { rows } = await client.query(
        `INSERT INTO payments (booking_id, user_id, amount, provider_reference, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${PAYMENT_COLUMNS}`,
        // The amount always comes from the booking, never from the client.
        [booking.id, user.id, booking.amount, `pay_${crypto.randomUUID().replace(/-/g, '')}`, idempotencyKey ?? null],
      );
      const payment = rows[0];

      if (simulate_outcome === 'SUCCESS' || simulate_outcome === 'FAILED') {
        await applyPaymentOutcome(client, payment, booking, simulate_outcome, 'Simulated failure');
      } else if (!simulate_outcome) {
        const { outcome, reason } = simulateProvider();
        await applyPaymentOutcome(client, payment, booking, outcome, reason);
      } // PENDING: settled later by the provider webhook

      return { payment: toPaymentResponse(payment, booking.status), created: true };
    });
  } catch (err) {
    // Lost a race with a concurrent request carrying the same Idempotency-Key.
    if (idempotencyKey && isUniqueViolation(err, 'uq_payment_user_idempotency_key')) {
      const existing = await findByIdempotencyKey(pool, user.id, idempotencyKey);
      return replayIdempotentPayment(pool, existing, booking_id);
    }
    throw err;
  }
}

/** Answer a repeated Idempotency-Key with the original payment (HTTP 200, no new charge). */
async function replayIdempotentPayment(db, existing, bookingId) {
  if (existing.booking_id !== bookingId) {
    throw Conflict('Idempotency-Key was already used for a different booking');
  }
  const status = await bookingStatusOf(db, existing.booking_id);
  return { payment: toPaymentResponse(existing, status), created: false };
}

// ---------------------------------------------------------------- webhook

// Fingerprint of the event contents, used to tell a harmless redelivery apart
// from a different payload re-using an event_id. Field order is fixed and
// `amount` is already normalised by the schema ("349" and "349.00" hash alike).
function hashWebhookPayload(payload) {
  const canonical = JSON.stringify({
    amount: payload.amount,
    event_id: payload.event_id,
    failure_reason: payload.failure_reason ?? null,
    payment_reference: payload.payment_reference,
    status: payload.status,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function duplicateResult(db, event, digest) {
  if (event.payload_hash !== digest) {
    throw Conflict('event_id was already used with a different payload');
  }
  const { rows } = await db.query(
    `SELECT p.status AS payment_status, b.status AS booking_status
     FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = $1`,
    [event.payment_id],
  );
  return {
    event_id: event.event_id,
    result: 'duplicate',
    ...rows[0],
    detail: 'Event already received; no changes made',
  };
}

async function findEvent(db, eventId) {
  const { rows } = await db.query(
    'SELECT event_id, payment_id, payload_hash FROM webhook_events WHERE event_id = $1',
    [eventId],
  );
  return rows[0];
}

/**
 * Idempotently apply a provider event. Three layers of protection:
 *  1. event_id is UNIQUE and is inserted in the same transaction as the state
 *     change: an event is applied at most once, and if processing fails nothing
 *     is recorded, so the provider's retry is processed normally;
 *  2. payments only move PENDING -> final, so a *different* event can't change
 *     a settled payment;
 *  3. booking and payment rows are locked (SELECT ... FOR UPDATE, always
 *     booking first) so concurrent deliveries are serialised.
 */
async function processWebhook(payload) {
  const digest = hashWebhookPayload(payload);
  try {
    return await withTransaction(async (client) => {
      const existingEvent = await findEvent(client, payload.event_id);
      if (existingEvent) return duplicateResult(client, existingEvent, digest);

      const lookup = await client.query(
        'SELECT id, booking_id, amount FROM payments WHERE provider_reference = $1',
        [payload.payment_reference],
      );
      const target = lookup.rows[0];
      if (!target) throw NotFound('Payment not found for this payment_reference');
      if (toCents(payload.amount) !== toCents(target.amount)) {
        throw BadRequest('Webhook amount does not match the payment amount');
      }

      // Lock order booking -> payment matches createPayment (no deadlocks), and
      // re-reading after the lock means we act on the latest committed state.
      const booking = (
        await client.query('SELECT id, status FROM bookings WHERE id = $1 FOR UPDATE', [target.booking_id])
      ).rows[0];
      const payment = (
        await client.query(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`, [target.id])
      ).rows[0];

      const result = await applyPaymentOutcome(
        client, payment, booking, payload.status, payload.failure_reason,
      );
      await client.query(
        `INSERT INTO webhook_events (event_id, payment_id, status, payload_hash, result)
         VALUES ($1, $2, $3, $4, $5)`,
        [payload.event_id, payment.id, payload.status, digest, result],
      );
      logger.info({ event_id: payload.event_id, payment_id: payment.id, result }, 'webhook processed');
      return {
        event_id: payload.event_id,
        result,
        payment_status: payment.status,
        booking_status: booking.status,
        detail:
          result === 'ignored'
            ? `Payment already ${payment.status}; event recorded but not applied`
            : null,
      };
    });
  } catch (err) {
    // The same event was delivered concurrently and the other delivery won.
    if (isUniqueViolation(err, 'webhook_events_event_id_key')) {
      return duplicateResult(pool, await findEvent(pool, payload.event_id), digest);
    }
    throw err;
  }
}

module.exports = { createPayment, processWebhook };
