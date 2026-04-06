// /api/route.js — Find cheap gas stations along a driving route
// Uses OpenRouteService (free) for route geometry + Tankerkönig for stations

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const ORS_KEY = process.env.ORS_API_KEY;

  if (!ORS_KEY) {
    return res.status(500).json({ error: "Missing ORS_API_KEY" });
  }

  const { start_lat, start_lng, end_lat, end_lng, fuel = "e10" } = req.query;

  if (!start_lat || !start_lng || !end_lat || !end_lng) {
    return res.status(400).json({ error: "Need start_lat, start_lng, end_lat, end_lng" });
  }

  try {
    // ─── 1. GET ROUTE FROM OPENROUTESERVICE ─────────────────────
    const orsRes = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: {
        "Authorization": ORS_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        coordinates: [
          [parseFloat(start_lng), parseFloat(start_lat)],
          [parseFloat(end_lng), parseFloat(end_lat)],
        ],
      }),
    });

    const orsData = await orsRes.json();
    if (!orsData.features || !orsData.features[0]) {
      return res.status(502).json({ error: "No route found", details: orsData });
    }

    const route = orsData.features[0];
    const coords = route.geometry.coordinates; // [[lng, lat], ...]
    const totalDistance = route.properties.summary.distance; // meters
    const totalDuration = route.properties.summary.duration; // seconds

    // ─── 2. SAMPLE POINTS ALONG ROUTE ───────────────────────────
    // Every ~30km, pick a point to search for stations
    const sampleInterval = 30000; // 30km in meters
    const numSamples = Math.min(10, Math.max(2, Math.ceil(totalDistance / sampleInterval)));
    const samplePoints = [];

    // Calculate cumulative distances between consecutive coords
    let cumDist = 0;
    const cumDists = [0];
    for (let i = 1; i < coords.length; i++) {
      const d = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
      cumDist += d;
      cumDists.push(cumDist);
    }

    for (let s = 0; s < numSamples; s++) {
      const targetDist = (s / (numSamples - 1)) * cumDist;
      // Find the segment containing this distance
      for (let i = 1; i < cumDists.length; i++) {
        if (cumDists[i] >= targetDist) {
          const segFrac = (targetDist - cumDists[i - 1]) / (cumDists[i] - cumDists[i - 1] || 1);
          const lng = coords[i - 1][0] + segFrac * (coords[i][0] - coords[i - 1][0]);
          const lat = coords[i - 1][1] + segFrac * (coords[i][1] - coords[i - 1][1]);
          samplePoints.push({ lat, lng });
          break;
        }
      }
    }

    // ─── 3. RETURN ROUTE + SAMPLE POINTS ──────────────────────
    // Frontend will query Tankerkönig for each sample point (works from browser)

    // ─── 4. SIMPLIFY ROUTE FOR FRONTEND MAP ─────────────────────
    // Reduce coordinate count for frontend rendering
    const simplifiedRoute = [];
    const simplifyStep = Math.max(1, Math.floor(coords.length / 200));
    for (let i = 0; i < coords.length; i += simplifyStep) {
      simplifiedRoute.push([coords[i][1], coords[i][0]]); // [lat, lng] for Leaflet
    }
    // Always include last point
    const last = coords[coords.length - 1];
    simplifiedRoute.push([last[1], last[0]]);

    return res.status(200).json({
      ok: true,
      route: {
        distance: Math.round(totalDistance / 1000),
        duration: Math.round(totalDuration / 60),
        coords: simplifiedRoute,
      },
      samplePoints: samplePoints.map(p => [+p.lat.toFixed(4), +p.lng.toFixed(4)]),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Haversine distance in meters
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
