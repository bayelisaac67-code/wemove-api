/**
 * SMS sender for OTP codes (Twilio).
 *
 * Until the TWILIO_* env vars are set, this no-ops (logs only), so local dev
 * and any environment without credentials keep working unchanged. The moment
 * TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER are present
 * (e.g. set in Render), real texts start sending with no code change.
 *
 * Failure-isolated: a Twilio error never breaks the OTP flow — the code is
 * already persisted in the DB and still logged here as a fallback.
 */
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
const twilioEnabled = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);

let client = null;
if (twilioEnabled) {
  try {
    client = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log('[SMS] Twilio enabled.');
  } catch (err) {
    console.error('[SMS] Failed to init Twilio client:', err.message);
  }
}

async function sendOtpSms(phone, code) {
  // Always log so the code stays retrievable from server logs as a fallback.
  console.log(`[OTP] ${phone}: ${code}`);

  if (!client) {
    if (!twilioEnabled) console.log('[SMS] Twilio not configured — real send skipped.');
    return { sent: false, reason: 'twilio_not_configured' };
  }

  try {
    const result = await client.messages.create({
      body: `Your WeMove verification code is ${code}. It expires in 5 minutes.`,
      from: TWILIO_PHONE_NUMBER,
      to: phone,
    });
    console.log(`[SMS] Sent OTP to ${phone} (sid=${result.sid})`);
    return { sent: true, sid: result.sid };
  } catch (err) {
    console.error(`[SMS] Failed to send to ${phone}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendOtpSms, twilioEnabled };
