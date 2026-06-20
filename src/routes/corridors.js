const router = require('express').Router();
const { query } = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');

// GET /api/corridors
router.get('/', asyncHandler(async (req, res) => {
  const corridors = await query("SELECT * FROM corridors WHERE status='ACTIVE'");
  res.json({ success: true, corridors: corridors.rows });
}));

// GET /api/corridors/:id/pickup-points
router.get('/:id/pickup-points', asyncHandler(async (req, res) => {
  const points = await query(
    'SELECT * FROM pickup_points WHERE corridor_id=$1 ORDER BY order_index ASC',
    [req.params.id]
  );
  res.json({ success: true, pickupPoints: points.rows });
}));

module.exports = router;
