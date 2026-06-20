const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { notify, notifyMany, TYPES } = require('../services/notifications');

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

    // Alert all admins, and confirm receipt to the reporting user.
    const admins = (await query('SELECT id FROM users WHERE is_admin=true')).rows.map((r) => r.id);
    await notifyMany(
      admins,
      TYPES.SOS_ACKNOWLEDGED,
      { title: '🆘 SOS reported', message: `SOS from ${req.user.full_name || req.user.phone}`, sos_id: event.id, location: { lat, lng } },
      'PUSH'
    );
    await notify({
      userId: req.user.id,
      type: TYPES.SOS_ACKNOWLEDGED,
      payload: { title: 'SOS received — help is on the way', message: 'Your SOS was received. Our team is responding.' },
      channel: 'SMS',
    });

    res.status(201).json({ success: true, event, message: 'SOS received — help is on the way' });
  })
);

module.exports = router;
