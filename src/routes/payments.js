const router = require('express').Router();
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// GET /api/payments/:bookingId
router.get('/:bookingId', authenticate, asyncHandler(async (req, res) => {
  const payment = (await query(
    `SELECT p.* FROM payments p
     JOIN bookings b ON p.booking_id = b.id
     WHERE p.booking_id=$1 AND (b.passenger_id=$2 OR EXISTS(
       SELECT 1 FROM trips t WHERE t.id=b.trip_id AND t.driver_id=$2
     ))`,
    [req.params.bookingId, req.user.id]
  )).rows[0];

  if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
  res.json({ success: true, payment });
}));

// PATCH /api/payments/:bookingId/cash-reconcile — driver confirms cash received
router.patch('/:bookingId/cash-reconcile', authenticate, asyncHandler(async (req, res) => {
  await query(
    `UPDATE payments SET status='CASH_RECONCILED' WHERE booking_id=$1
     AND method='CASH' AND status='CASH_DUE'`,
    [req.params.bookingId]
  );
  res.json({ success: true, message: 'Cash reconciled' });
}));

module.exports = router;
