const { query } = require('../db');

const FLOOR = parseFloat(process.env.FLOOR_FARE_GHS || 10);
const PER_KM = parseFloat(process.env.PER_KM_RATE_GHS || 1.5);

const OCCUPANCY_FACTORS = { 0: 1.0, 1: 1.0, 2: 0.85, 3: 0.70, 4: 0.60 };

// --- Carbon (PCD §4: Shared vs Solo "carbon saved" is shown in the honest fork) ---
// A petrol car emits ~0.17 kg CO2 per km. A Shared rider boards a car already
// making the trip, so their marginal emission is ~0 — they save ~the full solo
// emission. [TO CALIBRATE] against real corridor data in the pilot.
const CO2_PER_KM_KG = parseFloat(process.env.CO2_PER_KM_KG || 0.17);
function co2SavedKg(km) {
  return Math.round(km * CO2_PER_KM_KG * 10) / 10;
}

// --- Solo estimate (PCD §6) ---
// Solo is door-to-door and dedicated, so it's priced well above Shared but still
// below Uber/Bolt. No occupancy discount; a wider per-km band. Display estimate
// only — real Solo pricing flexes with live conditions once Solo launches.
const SOLO_PER_KM_MIN = parseFloat(process.env.SOLO_PER_KM_MIN || 2.0);
const SOLO_PER_KM_MAX = parseFloat(process.env.SOLO_PER_KM_MAX || 3.0);
const SOLO_FLOOR = parseFloat(process.env.SOLO_FLOOR_GHS || 15);
function getSoloEstimate(km) {
  return {
    min: Math.max(SOLO_FLOOR, Math.ceil(km * SOLO_PER_KM_MIN)),
    max: Math.max(SOLO_FLOOR, Math.ceil(km * SOLO_PER_KM_MAX)),
    currency: 'GHS',
  };
}

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

module.exports = { calculatePrice, getPriceRange, getSegmentKm, co2SavedKg, getSoloEstimate };
