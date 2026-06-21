/**
 * SMS sender for OTP codes (Sendexa — https://sendexa.co).
 *
 * Until SENDEXA_API_KEY is set, this no-ops (logs only), so local dev and any
 * environment without credentials keep working unchanged. The moment the key
 * is present (e.g. set in Render), real texts start sending with no code change.
 *
 * We keep generating/verifying the OTP ourselves (otp_codes table) and use
 * Sendexa purely as the sender, so codes stay retrievable from the DB/logs.
 *
 * Failure-isolated: a send error never breaks the OTP flow — the code is
 * already persisted in the DB and still logged here as a fallback.
 *
 * Auth: Sendexa uses `Authorization: Basic <token>`, where <token> is the
 * pre-computed value copied from the Sendexa dashboard (set as SENDEXA_API_KEY).
 */
const SENDEXA_API_KEY = process.env.SENDEXA_API_KEY;
const SENDEXA_SENDER_ID = process.env.SENDEXA_SENDER_ID || 'WeMove';
const SENDEXA_SMS_URL = process.env.SENDEXA_SMS_URL || 'https://api.sendexa.co/v1/sms/send';
const smsEnabled = Boolean(SENDEXA_API_KEY);

if (smsEnabled) console.log(`[SMS] Sendexa enabled (sender "${SENDEXA_SENDER_ID}").`);

async function sendOtpSms(phone, code) {
  // Always log so the code stays retrievable from server logs as a fallback.
  console.log(`[OTP] ${phone}: ${code}`);

  if (!smsEnabled) {
    console.log('[SMS] Sendexa not configured — real send skipped.');
    return { sent: false, reason: 'sms_not_configured' };
  }

  try {
    const res = await fetch(SENDEXA_SMS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${SENDEXA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: phone.replace(/^\+/, ''), // Sendexa expects digits only, no leading +
        from: SENDEXA_SENDER_ID,
        message: `Your WeMove verification code is ${code}. It expires in 5 minutes.`,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success !== false) {
      console.log(`[SMS] Sent OTP to ${phone} (requestId=${data.requestId || 'n/a'})`);
      return { sent: true, data };
    }

    console.error(
      `[SMS] Sendexa rejected send to ${phone}: HTTP ${res.status} ${JSON.stringify(data.errors || data)}`
    );
    return { sent: false, reason: 'sendexa_error', status: res.status, data };
  } catch (err) {
    console.error(`[SMS] Failed to send to ${phone}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendOtpSms, smsEnabled };
