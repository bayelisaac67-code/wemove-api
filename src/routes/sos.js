const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.post('/',
  authenticate,
  [body('lat').isFloat(), body('lng').isFloat()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { lat, lng, trip_id, booking_id } = req.body;

    const event = (await query(
      `INSERT INTO sos_events (id, user_id, trip_id, booking_id, location, status)
       VALUES ($1,$2,$3,$4,$5,'OPEN') RETURNING *`,
      [uuidv4(), req.user.id, trip_id || null, booking_id || null, JSON.stringify({ lat, lng })]
    )).rows[0];

    // TODO: alert admin via push/SMS

    res.status(201).json({ success: true, event, message: 'SOS received — help is on the way' });
  })
);

module.exports = router;
