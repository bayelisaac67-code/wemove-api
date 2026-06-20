const { query } = require('../db');

const FLOOR = parseFloat(process.env.FLOOR_FARE_GHS || 10);
const PER_KM = parseFloat(process.env.PER_KM_RATE_GHS || 1.5);

const OCCUPANCY_FACTORS = { 0: 1.0, 1: 1.0, 2: 0.85, 3: 0.70, 4: 0.60 };

async function getSegmentKm(pickupPointId, dropoffPointId) {
  const result = await query(
    `SELECT ABS(p2.order_index - p1.order_index) * 2.5 AS km
     FROM pickup_points p1, pickup_points p2
     WHERE p1.id=$1 AND p2.id=$2`,
    [pickupPointId, dropoffPointId]
  );
  return result.rows[0]?.km || 5;
}

async function calculatePrice({ corridorId, pickupPointId, dropoffPointId, confirmedSeats = 0 }) {
  const km = await getSegmentKm(pickupPointId, dropoffPointId);
  const base = Math.max(FLOOR, Math.ceil(km * PER_KM));
  const factor = OCCUPANCY_FACTORS[Math.min(confirmedSeats, 4)] ?? 0.60;
  return Math.max(FLOOR, Math.round(base * factor));
}

async function getPriceRange({ corridorId, originId, destinationId }) {
  const km = await getSegmentKm(originId, destinationId);
  const base = Math.max(FLOOR, Math.ceil(km * PER_KM));
  const min = Math.max(FLOOR, Math.round(base * 0.60));
  const max = Math.round(base * 1.0);
  return { min, max, currency: 'GHS' };
}

module.exports = { calculatePrice, getPriceRange };
