const router = require('express').Router();
const { body, query: queryParam, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requireVerified } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const matchingEngine = require('../../src/services/matchingEngine');
const pricingEngine = require('../../src/services/pricingEngine');
const { notify, notifyMany, TYPES } = require('../services/notifications');

// GET /api/trips/search — passenger searches for trips
router.get(
  '/search',
  authenticate,
  requireVerified,
  asyncHandler(async (req, res) => {
    const { corridor_id, direction, pickup_point_id, dropoff_point_id, desired_time, seats = 1 } = req.query;

    const trips = await matchingEngine.findEligibleTrips({
      corridorId: corridor_id,
      direction,
      pickupPointId: pickup_point_id,
      dropoffPointId: dropoff_point_id,
      desiredTime: desired_time,
      seats: parseInt(seats),
      passengerId: req.user.id,
    });

    res.json({ success: true, trips });
  })
);

// POST /api/trips — driver publishes a trip
router.post(
  '/',
  authenticate,
  requireVerified,
  [
    body('corridor_id').isUUID(),
    body('direction').isIn(['FORWARD', 'REVERSE']),
    body('origin_point_id').isUUID(),
    body('destination_point_id').isUUID(),
    body('departure_time').isISO8601(),
    body('total_seats').isInt({ min: 1, max: 7 }),
    body('vehicle_id').isUUID(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    if (!req.user.role_flags.includes('DRIVER')) {
      return res.status(403).json({ success: false, error: 'Driver account required' });
    }

    const { corridor_id, direction, origin_point_id, destination_point_id, departure_time, total_seats, vehicle_id, recurring_template_id } = req.body;

    if (new Date(departure_time) <= new Date()) {
      return res.status(400).json({ success: false, error: 'Departure time must be in the future' });
    }

    const priceRange = await pricingEngine.getPriceRange({ corridorId: corridor_id, originId: origin_point_id, destinationId: destination_point_id });

    const trip = (
      await query(
        `INSERT INTO trips (id, driver_id, vehicle_id, corridor_id, direction, origin_point_id, destination_point_id,
         departure_time, total_seats, available_seats, status, recurring_template_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'PUBLISHED',$10) RETURNING *`,
        [uuidv4(), req.user.id, vehicle_id, corridor_id, direction, origin_point_id, destination_point_id, departure_time, total_seats, recurring_template_id || null]
      )
    ).rows[0];

    res.status(201).json({ success: true, trip, priceRange });
  })
);

// PATCH /api/trips/:id/start
router.patch('/:id/start', authenticate, requireVerified, asyncHandler(async (req, res) => {
  const trip = (await query('SELECT * FROM trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
  if (trip.status !== 'PUBLISHED') return res.status(400).json({ success: false, error: 'Trip not in PUBLISHED state' });

  const updated = (await query("UPDATE trips SET status='IN_PROGRESS' WHERE id=$1 RETURNING *", [trip.id])).rows[0];
  res.json({ success: true, trip: updated });
}));

// PATCH /api/trips/:id/complete
router.patch('/:id/complete', authenticate, requireVerified, asyncHandler(async (req, res) => {
  const trip = (await query('SELECT * FROM trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
  if (trip.status !== 'IN_PROGRESS') return res.status(400).json({ success: false, error: 'Trip must be IN_PROGRESS' });

  // Capture confirmed passengers before the status flips.
  const passengers = (await query(
    "SELECT passenger_id FROM bookings WHERE trip_id=$1 AND status='CONFIRMED'", [trip.id]
  )).rows.map((r) => r.passenger_id);

  await query("UPDATE trips SET status='COMPLETED' WHERE id=$1", [trip.id]);
  // release payments for all confirmed bookings
  await query(`UPDATE payments SET status='RELEASED' WHERE booking_id IN
    (SELECT id FROM bookings WHERE trip_id=$1 AND status='CONFIRMED' AND payment_method != 'CASH')`, [trip.id]);
  await query("UPDATE bookings SET status='COMPLETED' WHERE trip_id=$1 AND status='CONFIRMED'", [trip.id]);

  await notifyMany(passengers, TYPES.TRIP_COMPLETED, { title: 'Trip completed', message: 'Thanks for riding with WeMove', trip_id: trip.id }, 'PUSH');
  await notifyMany(passengers, TYPES.RATE_TRIP, { title: 'Rate your trip', message: 'How was your ride? Tap to rate.', trip_id: trip.id }, 'PUSH');

  res.json({ success: true, message: 'Trip completed, payments released' });
}));

// DELETE /api/trips/:id — driver cancels
router.delete('/:id', authenticate, requireVerified, asyncHandler(async (req, res) => {
  const trip = (await query('SELECT * FROM trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
  if (!['PUBLISHED', 'IN_PROGRESS'].includes(trip.status)) {
    return res.status(400).json({ success: false, error: 'Cannot cancel this trip' });
  }

  // Capture affected passengers before the status flips.
  const passengers = (await query(
    "SELECT passenger_id FROM bookings WHERE trip_id=$1 AND status='CONFIRMED'", [trip.id]
  )).rows.map((r) => r.passenger_id);

  await query("UPDATE trips SET status='CANCELLED' WHERE id=$1", [trip.id]);
  await query("UPDATE bookings SET status='CANCELLED_BY_DRIVER' WHERE trip_id=$1 AND status='CONFIRMED'", [trip.id]);
  await query(`UPDATE payments SET status='REFUNDED' WHERE booking_id IN
    (SELECT id FROM bookings WHERE trip_id=$1) AND status='HELD'`, [trip.id]);

  await notifyMany(passengers, TYPES.TRIP_CANCELLED, { title: 'Your ride was cancelled', message: 'The driver cancelled this trip — your payment is refunded.', trip_id: trip.id }, 'PUSH');

  res.json({ success: true, message: 'Trip cancelled, refunds initiated' });
}));

module.exports = router;
