const router = require('express').Router();
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.use(authenticate, requireAdmin);

// GET /api/admin/verifications
router.get('/verifications', asyncHandler(async (req, res) => {
  const docs = await query(
    `SELECT vd.*, u.phone, u.full_name FROM verification_documents vd
     JOIN users u ON vd.user_id = u.id
     WHERE vd.review_status='PENDING' ORDER BY vd.created_at ASC`
  );
  res.json({ success: true, documents: docs.rows });
}));

// PATCH /api/admin/verifications/:id/approve
router.patch('/verifications/:id/approve', asyncHandler(async (req, res) => {
  const doc = (await query("UPDATE verification_documents SET review_status='APPROVED', reviewed_by=$1 WHERE id=$2 RETURNING *", [req.user.id, req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

  // if all required docs approved, mark user verified
  const pending = await query(
    `SELECT COUNT(*) FROM verification_documents WHERE user_id=$1 AND review_status!='APPROVED' AND doc_type IN ('GHANA_CARD','SELFIE')`,
    [doc.user_id]
  );
  if (parseInt(pending.rows[0].count) === 0) {
    await query("UPDATE users SET verification_status='VERIFIED' WHERE id=$1", [doc.user_id]);
  }

  res.json({ success: true, document: doc });
}));

// PATCH /api/admin/verifications/:id/reject
router.patch('/verifications/:id/reject', asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const doc = (await query(
    "UPDATE verification_documents SET review_status='REJECTED', reviewed_by=$1, reason=$2 WHERE id=$3 RETURNING *",
    [req.user.id, reason, req.params.id]
  )).rows[0];
  await query("UPDATE users SET verification_status='REJECTED' WHERE id=$1", [doc.user_id]);
  res.json({ success: true, document: doc });
}));

// PATCH /api/admin/users/:id/suspend
router.patch('/users/:id/suspend', asyncHandler(async (req, res) => {
  await query("UPDATE users SET account_status='SUSPENDED' WHERE id=$1", [req.params.id]);
  res.json({ success: true, message: 'User suspended' });
}));

// GET /api/admin/metrics
router.get('/metrics', asyncHandler(async (req, res) => {
  const [drivers, passengers, trips, bookings] = await Promise.all([
    query("SELECT COUNT(*) FROM users WHERE 'DRIVER'=ANY(role_flags) AND account_status='ACTIVE'"),
    query("SELECT COUNT(*) FROM users WHERE 'PASSENGER'=ANY(role_flags) AND account_status='ACTIVE'"),
    query("SELECT COUNT(*), status FROM trips GROUP BY status"),
    query("SELECT COUNT(*), status FROM bookings GROUP BY status"),
  ]);
  res.json({
    success: true,
    metrics: {
      activeDrivers: parseInt(drivers.rows[0].count),
      activePassengers: parseInt(passengers.rows[0].count),
      tripsByStatus: trips.rows,
      bookingsByStatus: bookings.rows,
    },
  });
}));

module.exports = router;
