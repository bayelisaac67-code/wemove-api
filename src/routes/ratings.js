const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requireVerified } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.post('/',
  authenticate,
  requireVerified,
  [body('booking_id').isUUID(), body('ratee_id').isUUID(), body('stars').isInt({ min: 1, max: 5 })],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { booking_id, ratee_id, stars, reason_tags, comment } = req.body;

    const existing = await query('SELECT id FROM ratings WHERE booking_id=$1 AND rater_id=$2', [booking_id, req.user.id]);
    if (existing.rows.length) return res.status(409).json({ success: false, error: 'Already rated this booking' });

    await query(
      `INSERT INTO ratings (id, booking_id, rater_id, ratee_id, stars, reason_tags, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), booking_id, req.user.id, ratee_id, stars, reason_tags || [], comment || null]
    );

    // recompute reliability score for ratee
    const scores = await query('SELECT AVG(stars)*20 AS score FROM ratings WHERE ratee_id=$1', [ratee_id]);
    await query('UPDATE users SET reliability_score=$1 WHERE id=$2', [Math.round(scores.rows[0].score), ratee_id]);

    res.status(201).json({ success: true, message: 'Rating submitted' });
  })
);

module.exports = router;
