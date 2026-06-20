const router = require('express').Router();
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { notify, TYPES } = require('../services/notifications');

router.use(authenticate, requireAdmin);

// ─── Verification queue ───────────────────────────────────────────────────────
// GET /api/admin/verification-queue
router.get('/verification-queue', asyncHandler(async (req, res) => {
  const docs = await query(
    `SELECT vd.id, vd.doc_type, vd.file_url, vd.extracted_number, vd.created_at,
            u.full_name AS user_name, u.phone AS user_phone
       FROM verification_documents vd
       JOIN users u ON vd.user_id = u.id
      WHERE vd.review_status = 'PENDING'
      ORDER BY vd.created_at ASC`
  );
  res.json({ success: true, documents: docs.rows });
}));

// PATCH /api/admin/verification/:id/approve
router.patch('/verification/:id/approve', asyncHandler(async (req, res) => {
  const doc = (await query(
    "UPDATE verification_documents SET review_status='APPROVED', reviewed_by=$1 WHERE id=$2 RETURNING *",
    [req.user.id, req.params.id]
  )).rows[0];
  if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

  // When both required identity docs are approved, mark the user VERIFIED.
  const pending = await query(
    `SELECT COUNT(*) FROM verification_documents
      WHERE user_id=$1 AND review_status!='APPROVED' AND doc_type IN ('GHANA_CARD','SELFIE')`,
    [doc.user_id]
  );
  let nowVerified = false;
  if (parseInt(pending.rows[0].count) === 0) {
    await query("UPDATE users SET verification_status='VERIFIED' WHERE id=$1", [doc.user_id]);
    nowVerified = true;
  }
  await notify({
    userId: doc.user_id,
    type: TYPES.VERIFICATION,
    payload: nowVerified
      ? { title: 'You are verified! ✅', message: 'Your identity is verified — you can now book and publish rides.' }
      : { title: 'Document approved', message: `Your ${doc.doc_type} was approved.` },
    channel: 'PUSH',
  });
  res.json({ success: true, document: doc });
}));

// PATCH /api/admin/verification/:id/reject
router.patch('/verification/:id/reject', asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const doc = (await query(
    "UPDATE verification_documents SET review_status='REJECTED', reviewed_by=$1, reason=$2 WHERE id=$3 RETURNING *",
    [req.user.id, reason || null, req.params.id]
  )).rows[0];
  if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });
  await query("UPDATE users SET verification_status='REJECTED' WHERE id=$1", [doc.user_id]);
  await notify({
    userId: doc.user_id,
    type: TYPES.VERIFICATION,
    payload: { title: 'Verification rejected', message: reason ? `Rejected: ${reason}` : 'Your document was rejected. Please re-submit.' },
    channel: 'PUSH',
  });
  res.json({ success: true, document: doc });
}));

// ─── Users ────────────────────────────────────────────────────────────────────
// GET /api/admin/users?search=
router.get('/users', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').trim();
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = 'WHERE full_name ILIKE $1 OR preferred_name ILIKE $1 OR phone ILIKE $1';
  }
  const users = await query(
    `SELECT id, full_name, preferred_name, phone, reliability_score,
            account_status, verification_status, role_flags
       FROM users ${where}
      ORDER BY created_at DESC
      LIMIT 100`,
    params
  );
  res.json({ success: true, users: users.rows });
}));

// PATCH /api/admin/users/:id/suspend  (toggles SUSPENDED <-> ACTIVE)
router.patch('/users/:id/suspend', asyncHandler(async (req, res) => {
  const current = (await query('SELECT account_status FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!current) return res.status(404).json({ success: false, error: 'User not found' });
  const next = current.account_status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
  await query('UPDATE users SET account_status=$1 WHERE id=$2', [next, req.params.id]);
  res.json({ success: true, account_status: next });
}));

// ─── Trips ────────────────────────────────────────────────────────────────────
// GET /api/admin/trips?status=
router.get('/trips', asyncHandler(async (req, res) => {
  const status = (req.query.status || '').trim();
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE t.status = $1';
  }
  const trips = await query(
    `SELECT t.id, t.departure_time, t.total_seats, t.available_seats, t.status,
            u.full_name AS driver_name,
            o.name AS origin_name, d.name AS destination_name,
            (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.status='CONFIRMED') AS booking_count
       FROM trips t
       JOIN users u ON t.driver_id = u.id
       JOIN pickup_points o ON t.origin_point_id = o.id
       JOIN pickup_points d ON t.destination_point_id = d.id
       ${where}
      ORDER BY t.departure_time DESC
      LIMIT 100`,
    params
  );
  res.json({ success: true, trips: trips.rows });
}));

// ─── SOS events ───────────────────────────────────────────────────────────────
// GET /api/admin/sos
router.get('/sos', asyncHandler(async (req, res) => {
  const events = await query(
    `SELECT s.id, s.status, s.location, s.trip_id, s.created_at,
            u.full_name AS user_name, u.phone AS user_phone
       FROM sos_events s
       JOIN users u ON s.user_id = u.id
      ORDER BY (s.status='OPEN') DESC, s.created_at DESC
      LIMIT 100`
  );
  res.json({ success: true, events: events.rows });
}));

// PATCH /api/admin/sos/:id/acknowledge
router.patch('/sos/:id/acknowledge', asyncHandler(async (req, res) => {
  await query("UPDATE sos_events SET status='ACKNOWLEDGED' WHERE id=$1", [req.params.id]);
  res.json({ success: true });
}));

// PATCH /api/admin/sos/:id/resolve
router.patch('/sos/:id/resolve', asyncHandler(async (req, res) => {
  await query("UPDATE sos_events SET status='RESOLVED' WHERE id=$1", [req.params.id]);
  res.json({ success: true });
}));

// ─── Corridors (admin write) ──────────────────────────────────────────────────
// POST /api/admin/corridors/:id/pickup-points
router.post('/corridors/:id/pickup-points', asyncHandler(async (req, res) => {
  const { name, lat, lng, geofence_radius_m } = req.body;
  if (!name || lat == null || lng == null) {
    return res.status(400).json({ success: false, error: 'name, lat and lng are required' });
  }
  const next = (await query(
    'SELECT COALESCE(MAX(order_index), 0) + 1 AS idx FROM pickup_points WHERE corridor_id=$1',
    [req.params.id]
  )).rows[0].idx;
  const point = (await query(
    `INSERT INTO pickup_points (corridor_id, name, lat, lng, geofence_radius_m, order_index)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.id, name, lat, lng, geofence_radius_m || 100, next]
  )).rows[0];
  res.json({ success: true, pickup_point: point });
}));

// ─── Metrics ──────────────────────────────────────────────────────────────────
// GET /api/admin/metrics  (flat shape consumed by the admin dashboard)
router.get('/metrics', asyncHandler(async (req, res) => {
  const [
    drivers, passengers, totalUsers, tripsToday, completedTrips,
    bookingsToday, bookingAgg, fare, pendingVer, openSos, revenue,
  ] = await Promise.all([
    query("SELECT COUNT(*) FROM users WHERE 'DRIVER'=ANY(role_flags) AND account_status='ACTIVE'"),
    query("SELECT COUNT(*) FROM users WHERE 'PASSENGER'=ANY(role_flags) AND account_status='ACTIVE'"),
    query('SELECT COUNT(*) FROM users'),
    query("SELECT COUNT(*) FROM trips WHERE departure_time::date = NOW()::date"),
    query("SELECT COUNT(*) FROM trips WHERE status='COMPLETED'"),
    query('SELECT COUNT(*) FROM bookings WHERE created_at::date = NOW()::date'),
    query(`SELECT
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status IN ('CONFIRMED','COMPLETED')) AS matched,
              COUNT(*) FILTER (WHERE status IN ('CANCELLED_BY_PASSENGER','CANCELLED_BY_DRIVER','REJECTED','NO_SHOW_PASSENGER')) AS cancelled
            FROM bookings`),
    query('SELECT AVG(per_seat_price) AS avg FROM bookings'),
    query("SELECT COUNT(*) FROM verification_documents WHERE review_status='PENDING'"),
    query("SELECT COUNT(*) FROM sos_events WHERE status='OPEN'"),
    query("SELECT COALESCE(SUM(commission_amount),0) AS rev FROM payments WHERE created_at::date = NOW()::date"),
  ]);

  const totalBookings = parseInt(bookingAgg.rows[0].total);
  const matched = parseInt(bookingAgg.rows[0].matched);
  const cancelled = parseInt(bookingAgg.rows[0].cancelled);

  res.json({
    success: true,
    active_drivers: parseInt(drivers.rows[0].count),
    active_passengers: parseInt(passengers.rows[0].count),
    total_users: parseInt(totalUsers.rows[0].count),
    trips_today: parseInt(tripsToday.rows[0].count),
    completed_trips_total: parseInt(completedTrips.rows[0].count),
    bookings_today: parseInt(bookingsToday.rows[0].count),
    match_rate: totalBookings ? matched / totalBookings : null,
    cancellation_rate: totalBookings ? cancelled / totalBookings : null,
    avg_fare: fare.rows[0].avg ? parseFloat(fare.rows[0].avg) : null,
    pending_verifications: parseInt(pendingVer.rows[0].count),
    open_sos: parseInt(openSos.rows[0].count),
    revenue_today: parseFloat(revenue.rows[0].rev),
  });
}));

module.exports = router;
