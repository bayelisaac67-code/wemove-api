const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireVerified } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// GET /api/users/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user });
}));

// PATCH /api/users/me — update profile
router.patch('/me',
  authenticate,
  [body('full_name').optional().notEmpty(), body('preferred_name').optional().notEmpty(), body('email').optional().isEmail()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { full_name, preferred_name, email, emergency_contact } = req.body;
    const result = await query(
      `UPDATE users SET
        full_name = COALESCE($1, full_name),
        preferred_name = COALESCE($2, preferred_name),
        email = COALESCE($3, email),
        emergency_contact = COALESCE($4, emergency_contact),
        updated_at = NOW()
       WHERE id=$5 RETURNING *`,
      [full_name, preferred_name, email, emergency_contact ? JSON.stringify(emergency_contact) : null, req.user.id]
    );
    res.json({ success: true, user: result.rows[0] });
  })
);

// GET /api/users/me/trips — trip history
router.get('/me/trips', authenticate, asyncHandler(async (req, res) => {
  const bookings = await query(
    `SELECT b.*, t.departure_time, t.status AS trip_status, t.corridor_id,
            pp1.name AS pickup_name, pp2.name AS dropoff_name
     FROM bookings b
     JOIN trips t ON b.trip_id = t.id
     JOIN pickup_points pp1 ON b.pickup_point_id = pp1.id
     JOIN pickup_points pp2 ON b.dropoff_point_id = pp2.id
     WHERE b.passenger_id=$1 ORDER BY t.departure_time DESC`,
    [req.user.id]
  );
  res.json({ success: true, bookings: bookings.rows });
}));

module.exports = router;
