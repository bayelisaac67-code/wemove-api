const { query } = require('../db');

const W = { destination: 0.30, distance: 0.20, pickup: 0.20, time: 0.15, driverReliability: 0.10, passengerPriority: 0.05 };
const TIME_TOLERANCE_MINUTES = 30;

async function findEligibleTrips({ corridorId, direction, pickupPointId, dropoffPointId, desiredTime, seats, passengerId }) {
  const desired = new Date(desiredTime);
  const windowStart = new Date(desired.getTime() - TIME_TOLERANCE_MINUTES * 60000);
  const windowEnd = new Date(desired.getTime() + TIME_TOLERANCE_MINUTES * 60000);

  const result = await query(
    `SELECT t.*, pp_origin.order_index AS origin_idx, pp_dest.order_index AS dest_idx,
            pp_pickup.order_index AS pickup_idx, pp_drop.order_index AS drop_idx,
            pp_pickup.name AS pickup_point_name,
            u.reliability_score AS driver_reliability,
            COALESCE(u.preferred_name, u.full_name) AS driver_name,
            COALESCE((SELECT ROUND(AVG(stars),1) FROM ratings WHERE ratee_id = t.driver_id), 5.0) AS driver_rating,
            v.make AS vehicle_make, v.model AS vehicle_model, v.colour AS vehicle_colour, v.plate_number
     FROM trips t
     JOIN pickup_points pp_origin ON t.origin_point_id = pp_origin.id
     JOIN pickup_points pp_dest   ON t.destination_point_id = pp_dest.id
     JOIN pickup_points pp_pickup ON pp_pickup.id = $3
     JOIN pickup_points pp_drop   ON pp_drop.id   = $4
     JOIN users u ON t.driver_id = u.id
     JOIN vehicles v ON t.vehicle_id = v.id
     WHERE t.corridor_id = $1
       AND t.direction = $2
       AND t.status = 'PUBLISHED'
       AND t.available_seats >= $5
       AND t.departure_time BETWEEN $6 AND $7
       AND u.account_status = 'ACTIVE'
       AND u.verification_status = 'VERIFIED'`,
    [corridorId, direction, pickupPointId, dropoffPointId, seats, windowStart, windowEnd]
  );

  const eligible = result.rows.filter((t) => {
    const paxPickup = t.pickup_idx;
    const paxDrop = t.drop_idx;
    const tripOrigin = t.origin_idx;
    const tripDest = t.dest_idx;
    return paxPickup >= tripOrigin && paxPickup < tripDest && paxDrop > paxPickup && paxDrop <= tripDest;
  });

  const tripKm = eligible.map((t) => Math.abs(t.dest_idx - t.origin_idx) * 2.5);
  const paxKm = Math.abs(eligible[0]?.drop_idx - eligible[0]?.pickup_idx || 5) * 2.5;

  const scored = eligible.map((t, i) => {
    const distSim = 1 - Math.abs(tripKm[i] - paxKm) / Math.max(tripKm[i], paxKm);
    const timeDiff = Math.abs(new Date(t.departure_time) - desired) / (TIME_TOLERANCE_MINUTES * 60000);
    const timeFit = 1 - Math.min(timeDiff, 1);
    const score =
      W.distance * distSim +
      W.time * timeFit +
      W.driverReliability * (t.driver_reliability / 100);
    return { ...t, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}

module.exports = { findEligibleTrips };
