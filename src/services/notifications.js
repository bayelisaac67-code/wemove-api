/**
 * WeMove in-API notification helper.
 * Writes to the `notifications` table and stub-dispatches PUSH/SMS.
 * Real FCM/Twilio can be dropped into sendPush/sendSMS later without
 * touching any call sites. Every call is failure-isolated so a
 * notification error never breaks the core request transaction.
 *
 * Notification types mirror wemove-notifications/src/notify.js (PRD §11).
 */
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');

const TYPES = {
  OTP: 'N-01',
  VERIFICATION: 'N-02',
  NEW_SEAT_REQUEST: 'N-03',
  REQUEST_ACCEPTED: 'N-04',
  REQUEST_REJECTED: 'N-05',
  BOOKING_CONFIRMED: 'N-06',
  TRIP_REMINDER: 'N-07',
  DRIVER_EN_ROUTE: 'N-08',
  TRIP_CANCELLED: 'N-09',
  PASSENGER_CANCELLED: 'N-10',
  WAIT_STARTED: 'N-11',
  NO_SHOW: 'N-12',
  TRIP_COMPLETED: 'N-13',
  RATE_TRIP: 'N-14',
  PAYMENT_UPDATE: 'N-15',
  PAYOUT_UPDATE: 'N-16',
  SOS_ACKNOWLEDGED: 'N-17',
  RECURRING_CONFIRM: 'N-18',
  RELIABILITY_WARN: 'N-19',
};

async function sendPush(userId, payload) {
  // TODO: wire firebase-admin when FCM credentials are configured.
  console.log(`[PUSH] → user:${userId}`, payload.title || payload.type || '');
}

async function sendSMS(userId, message) {
  // TODO: wire Twilio when credentials are configured.
  const { rows } = await query('SELECT phone FROM users WHERE id=$1', [userId]);
  console.log(`[SMS] → ${rows[0]?.phone}: ${message}`);
}

/**
 * Persist + dispatch a single notification. Never throws.
 * @param {{userId:string, type:string, payload:object, channel:'PUSH'|'SMS'|'IN_APP'}} opts
 */
async function notify({ userId, type, payload = {}, channel = 'PUSH' }) {
  try {
    await query(
      'INSERT INTO notifications (id, user_id, type, payload, channel) VALUES ($1,$2,$3,$4,$5)',
      [uuidv4(), userId, type, JSON.stringify(payload), channel]
    );
    if (channel === 'PUSH') await sendPush(userId, payload);
    else if (channel === 'SMS') await sendSMS(userId, payload.message || '');
  } catch (err) {
    console.error('[notify] failed:', err.message);
  }
}

/** Notify many users with the same type/payload/channel. Never throws. */
async function notifyMany(userIds, type, payload, channel = 'PUSH') {
  await Promise.all((userIds || []).map((userId) => notify({ userId, type, payload, channel })));
}

module.exports = { notify, notifyMany, TYPES };
