// /api/route.js — Find cheap gas stations along a driving route
// Uses OpenRouteService (free) for route geometry + Tankerkönig for stations

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const ORS_KEY = process.env.ORS_API_KEY;
  const TK_KEY = process.env.TANKERKOENIG_KEY;

  if (!ORS_KEY || !TK_KEY) {
    return res.status(500).json({ error: "Missing ORS_API_KEY or TANKERKOENIG_KEY" });
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

    // ─── 3. QUERY TANKERKÖNIG FOR EACH SAMPLE POINT ─────────────
    const seenIds = new Set();
    const allStations = [];
    const fuelParam = fuel === "e5" ? "e5" : fuel === "diesel" ? "diesel" : "e10";

    // Query in parallel (max 10 concurrent)
    const tkPromises = samplePoints.map(async (pt) => {
      try {
        const url = `https://creativecommons.tankerkoenig.de/json/list.php?lat=${pt.lat}&lng=${pt.lng}&rad=5&sort=price&type=${fuelParam}&apikey=${TK_KEY}`;
        const r = await fetch(url);
        const d = await r.json();
        if (d.ok && d.stations) return d.stations;
      } catch {}
      return [];
    });

    const results = await Promise.all(tkPromises);
    for (const stations of results) {
      for (const st of stations) {
        if (seenIds.has(st.id)) continue;
        seenIds.add(st.id);
        if (typeof st.price !== "number" || st.price <= 0) continue;
        if (!st.isOpen) continue;

        // Calculate distance from station to nearest point on route
        let minDist = Infinity;
        let nearestIdx = 0;
        // Sample every 10th coord for performance
        const step = Math.max(1, Math.floor(coords.length / 100));
        for (let i = 0; i < coords.length; i += step) {
          const d = haversine(st.lat, st.lng, coords[i][1], coords[i][0]);
          if (d < minDist) { minDist = d; nearestIdx = i; }
        }

        // Refine around nearest
        const lo = Math.max(0, nearestIdx - step);
        const hi = Math.min(coords.length - 1, nearestIdx + step);
        for (let i = lo; i <= hi; i++) {
          const d = haversine(st.lat, st.lng, coords[i][1], coords[i][0]);
          if (d < minDist) minDist = d;
        }

        const detourKm = +(minDist * 2 / 1000).toFixed(1); // there and back
        // Skip stations more than 5km off route (10km round trip)
        if (detourKm > 10) continue;

        // Estimate detour time
        const isCity = st.place && (st.place.length > 3); // rough heuristic
        const speed = isCity ? 30 : 60; // kph
        const detourMin = Math.ceil(detourKm / speed * 60);

        // Progress along route (0-100%)
        const routeProgress = Math.round(nearestIdx / coords.length * 100);

        allStations.push({
          id: st.id,
          name: st.name,
          brand: st.brand || "",
          place: st.place || "",
          price: st.price,
          lat: st.lat,
          lng: st.lng,
          street: st.street || "",
          houseNumber: st.houseNumber || "",
          detourKm,
          detourMin,
          routeProgress,
        });
      }
    }

    // Sort by price
    allStations.sort((a, b) => a.price - b.price);

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
        distance: Math.round(totalDistance / 1000), // km
        duration: Math.round(totalDuration / 60),    // minutes
        coords: simplifiedRoute,
      },
      stations: allStations.slice(0, 20), // top 20 cheapest
      fuel: fuelParam,
      totalFound: allStations.length,
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
