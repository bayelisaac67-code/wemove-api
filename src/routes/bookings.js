const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requireVerified } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const pricingEngine = require('../services/pricingEngine');
const { notify, TYPES } = require('../services/notifications');

// POST /api/bookings — passenger requests a seat
router.post(
  '/',
  authenticate,
  requireVerified,
  [
    // UUID-shape check (not strict isUUID): the seed corridor/pickup-point IDs
    // use a non-spec version nibble; DB foreign keys enforce real referential integrity.
    body('trip_id').matches(/^[0-9a-fA-F-]{36}$/),
    body('pickup_point_id').matches(/^[0-9a-fA-F-]{36}$/),
    body('dropoff_point_id').matches(/^[0-9a-fA-F-]{36}$/),
    body('seats').isInt({ min: 1, max: 4 }),
    body('payment_method').isIn(['CASH', 'MOMO', 'GHANAPAY']),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { trip_id, pickup_point_id, dropoff_point_id, seats, payment_method } = req.body;

    const trip = (await query('SELECT * FROM trips WHERE id=$1 AND status=$2', [trip_id, 'PUBLISHED'])).rows[0];
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found or not available' });
    if (trip.available_seats < seats) return res.status(409).json({ success: false, error: 'Not enough seats available' });

    const perSeatPrice = await pricingEngine.calculatePrice({
      corridorId: trip.corridor_id,
      pickupPointId: pickup_point_id,
      dropoffPointId: dropoff_point_id,
      confirmedSeats: trip.total_seats - trip.available_seats,
    });

    const bookingId = uuidv4();
    const booking = (
      await query(
        `INSERT INTO bookings (id, trip_id, passenger_id, seats, pickup_point_id, dropoff_point_id,
         per_seat_price, total_price, status, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REQUESTED',$9) RETURNING *`,
        [bookingId, trip_id, req.user.id, seats, pickup_point_id, dropoff_point_id, perSeatPrice, perSeatPrice * seats, payment_method]
      )
    ).rows[0];

    if (['MOMO', 'GHANAPAY'].includes(payment_method)) {
      await query(
        `INSERT INTO payments (id, booking_id, method, amount, commission_amount, driver_payout_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING')`,
        [uuidv4(), bookingId, payment_method, perSeatPrice * seats,
          perSeatPrice * seats * parseFloat(process.env.COMMISSION_RATE || 0.15),
          perSeatPrice * seats * (1 - parseFloat(process.env.COMMISSION_RATE || 0.15))]
      );
    }

    await notify({
      userId: trip.driver_id,
      type: TYPES.NEW_SEAT_REQUEST,
      payload: { title: 'New ride request', message: `${seats} seat(s) requested on your trip`, booking_id: bookingId, trip_id },
      channel: 'PUSH',
    });

    res.status(201).json({ success: true, booking });
  })
);

// GET /api/bookings/:id — passenger views a booking (status + trip/driver detail)
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const booking = (await query(
    `SELECT b.id, b.status, b.seats, b.per_seat_price, b.total_price, b.payment_method,
            b.pickup_point_id, b.dropoff_point_id,
            t.departure_time, t.status AS trip_status,
            COALESCE(u.preferred_name, u.full_name) AS driver_name, u.phone AS driver_phone,
            v.make AS vehicle_make, v.model AS vehicle_model, v.colour AS vehicle_colour, v.plate_number,
            pp1.name AS pickup_point_name, pp2.name AS dropoff_point_name
     FROM bookings b
     JOIN trips t ON b.trip_id = t.id
     JOIN users u ON t.driver_id = u.id
     JOIN vehicles v ON t.vehicle_id = v.id
     JOIN pickup_points pp1 ON b.pickup_point_id = pp1.id
     JOIN pickup_points pp2 ON b.dropoff_point_id = pp2.id
     WHERE b.id = $1 AND b.passenger_id = $2`,
    [req.params.id, req.user.id]
  )).rows[0];

  if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
  res.json({ success: true, booking });
}));

// PATCH /api/bookings/:id/accept — driver accepts
router.patch('/:id/accept', authenticate, requireVerified, asyncHandler(async (req, res) => {
  const booking = (await query(
    `SELECT b.*, t.driver_id FROM bookings b JOIN trips t ON b.trip_id=t.id WHERE b.id=$1`,
    [req.params.id]
  )).rows[0];

  if (!booking || booking.driver_id !== req.user.id) return res.status(404).json({ success: false, error: 'Booking not found' });
  if (booking.status !== 'REQUESTED') return res.status(400).json({ success: false, error: 'Booking not in REQUESTED state' });

  await query("UPDATE bookings SET status='CONFIRMED' WHERE id=$1", [booking.id]);
  await query('UPDATE trips SET available_seats = available_seats - $1 WHERE id=$2', [booking.seats, booking.trip_id]);
  await query("UPDATE payments SET status='HELD' WHERE booking_id=$1 AND status='PENDING'", [booking.id]);

  await notify({
    userId: booking.passenger_id,
    type: TYPES.REQUEST_ACCEPTED,
    payload: { title: 'Ride confirmed! 🎉', message: 'Your seat request was accepted', booking_id: booking.id, trip_id: booking.trip_id },
    channel: 'PUSH',
  });

  res.json({ success: true, message: 'Booking confirmed' });
}));

// PATCH /api/bookings/:id/reject — driver rejects
router.patch('/:id/reject', authenticate, requireVerified, asyncHandler(async (req, res) => {
  const booking = (await query(
    `SELECT b.*, t.driver_id FROM bookings b JOIN trips t ON b.trip_id=t.id WHERE b.id=$1`,
    [req.params.id]
  )).rows[0];

  if (!booking || booking.driver_id !== req.user.id) return res.status(404).json({ success: false, error: 'Booking not found' });

  await query("UPDATE bookings SET status='REJECTED' WHERE id=$1", [booking.id]);
  await query("UPDATE payments SET status='REFUNDED' WHERE booking_id=$1 AND status IN ('PENDING','HELD')", [booking.id]);

  await notify({
    userId: booking.passenger_id,
    type: TYPES.REQUEST_REJECTED,
    payload: { title: 'Ride request declined', message: 'Your seat request was not accepted — any payment is refunded', booking_id: booking.id, trip_id: booking.trip_id },
    channel: 'PUSH',
  });

  res.json({ success: true, message: 'Booking rejected' });
}));

// DELETE /api/bookings/:id — passenger cancels
router.delete('/:id', authenticate, requireVerified, asyncHandler(async (req, res) => {
  const booking = (await query(
    'SELECT b.*, t.driver_id FROM bookings b JOIN trips t ON b.trip_id=t.id WHERE b.id=$1 AND b.passenger_id=$2',
    [req.params.id, req.user.id]
  )).rows[0];
  if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
  if (!['REQUESTED', 'CONFIRMED'].includes(booking.status)) return res.status(400).json({ success: false, error: 'Cannot cancel' });

  await query("UPDATE bookings SET status='CANCELLED_BY_PASSENGER' WHERE id=$1", [booking.id]);
  if (booking.status === 'CONFIRMED') {
    await query('UPDATE trips SET available_seats = available_seats + $1 WHERE id=$2', [booking.seats, booking.trip_id]);
  }
  await query("UPDATE payments SET status='REFUNDED' WHERE booking_id=$1 AND status='HELD'", [booking.id]);

  await notify({
    userId: booking.driver_id,
    type: TYPES.PASSENGER_CANCELLED,
    payload: { title: 'A passenger cancelled', message: 'A passenger cancelled their booking on your trip', booking_id: booking.id, trip_id: booking.trip_id },
    channel: 'PUSH',
  });

  res.json({ success: true, message: 'Booking cancelled' });
}));

module.exports = router;
