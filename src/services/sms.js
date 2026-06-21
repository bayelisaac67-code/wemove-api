/**
 * SMS sender for OTP codes (Arkesel — https://arkesel.com).
 *
 * Uses Arkesel's v1 GET API: ?action=send-sms&api_key=&to=&from=&sms=
 * No-ops (logs only) until ARKESEL_API_KEY is set, so local dev keeps working.
 * A send error never breaks the OTP flow — code is already persisted in the DB.
 */
const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY;
const ARKESEL_SENDER_ID = process.env.ARKESEL_SENDER_ID || 'WeMove';
const smsEnabled = Boolean(ARKESEL_API_KEY);

if (smsEnabled) console.log(`[SMS] Arkesel enabled (sender "${ARKESEL_SENDER_ID}").`);

async function sendOtpSms(phone, code) {
  console.log(`[OTP] ${phone}: ${code}`);

  if (!smsEnabled) {
    console.log('[SMS] Arkesel not configured — real send skipped.');
    return { sent: false, reason: 'sms_not_configured' };
  }

  try {
    const params = new URLSearchParams({
      action: 'send-sms',
      api_key: ARKESEL_API_KEY,
      to: phone, // E.164 format e.g. +233597303721
      from: ARKESEL_SENDER_ID,
      sms: `Your WeMove code is ${code}. Expires in 5 minutes.`,
    });

    const res = await fetch(`https://sms.arkesel.com/sms/api?${params}`);
    const data = await res.json().catch(() => ({}));

    if (data.code === 'ok') {
      console.log(`[SMS] Sent OTP to ${phone}`);
      return { sent: true, data };
    }

    console.error(`[SMS] Arkesel rejected send to ${phone}: ${JSON.stringify(data)}`);
    return { sent: false, reason: 'arkesel_error', data };
  } catch (err) {
    console.error(`[SMS] Failed to send to ${phone}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendOtpSms, smsEnabled };
