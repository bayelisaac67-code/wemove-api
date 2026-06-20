const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');

// POST /api/auth/send-otp
router.post(
  '/send-otp',
  [body('phone').matches(/^\+[1-9]\d{7,14}$/).withMessage('Valid international number required (+<country code><number>)')],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { phone } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + parseInt(process.env.OTP_EXPIRY_SECONDS || 300) * 1000);

    await query(
      `INSERT INTO otp_codes (phone, code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, attempts = 0`,
      [phone, otp, expiresAt]
    );

    // TODO: send via Twilio in production
    console.log(`[OTP] ${phone}: ${otp}`);

    res.json({
      success: true,
      message: 'OTP sent',
      // In development (no Twilio), return the code so it can be entered during testing.
      ...(process.env.NODE_ENV !== 'production' && { devCode: otp }),
    });
  })
);

// POST /api/auth/verify-otp
router.post(
  '/verify-otp',
  [
    body('phone').matches(/^\+[1-9]\d{7,14}$/),
    body('code').isLength({ min: 6, max: 6 }).isNumeric(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { phone, code } = req.body;
    const result = await query(
      'SELECT * FROM otp_codes WHERE phone = $1 AND expires_at > NOW() AND attempts < 3',
      [phone]
    );

    if (!result.rows.length) {
      return res.status(400).json({ success: false, error: 'Code expired or too many attempts' });
    }

    const record = result.rows[0];
    if (record.code !== code) {
      await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1', [phone]);
      return res.status(400).json({ success: false, error: 'Wrong code' });
    }

    await query('DELETE FROM otp_codes WHERE phone = $1', [phone]);

    let user = (await query('SELECT * FROM users WHERE phone = $1', [phone])).rows[0];
    const isNew = !user;

    if (isNew) {
      const id = uuidv4();
      user = (
        await query(
          `INSERT INTO users (id, phone, verification_status, account_status, reliability_score, role_flags)
           VALUES ($1, $2, 'UNVERIFIED', 'ACTIVE', 50, ARRAY['PASSENGER'])
           RETURNING *`,
          [id, phone]
        )
      ).rows[0];
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });

    res.json({ success: true, token, user, isNew });
  })
);

module.exports = router;
