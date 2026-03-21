// /api/collect.js — Vercel Serverless Function
// Fetches gas prices from Tankerkönig and stores in Supabase
// Triggered by cron-job.org every 30 minutes

export default async function handler(req, res) {
  // Optional: protect with a secret so random people can't trigger it
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const TK_KEY = process.env.TANKERKOENIG_KEY || "9cb3a94e-c42d-4367-9d8f-88a8c917b4f3";
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key for server-side inserts
  const LAT = process.env.LAT || "52.4227";
  const LNG = process.env.LNG || "10.7865";
  const RAD = process.env.RAD || "25";

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars" });
  }

  const results = { fetched: 0, inserted: 0, skipped: 0, errors: [] };

  try {
    // Fetch all fuel types in one call
    const tkUrl = `https://creativecommons.tankerkoenig.de/json/list.php?lat=${LAT}&lng=${LNG}&rad=${RAD}&sort=price&type=all&apikey=${TK_KEY}`;
    const tkRes = await fetch(tkUrl);
    const tkData = await tkRes.json();

    if (!tkData.ok) {
      return res.status(502).json({ error: `Tankerkönig error: ${tkData.message}` });
    }

    const stations = tkData.stations || [];
    results.fetched = stations.length;
    const now = new Date().toISOString();

    // Get latest prices from Supabase to deduplicate
    const latestRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/get_latest_prices`,
      {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }
    );

    let latestPrices = {};
    try {
      const latestData = await latestRes.json();
      if (Array.isArray(latestData)) {
        for (const row of latestData) {
          latestPrices[`${row.station_id}_${row.fuel_type}`] = row.price;
        }
      }
    } catch (e) {
      // First run, no data yet — that's fine
    }

    // Build rows to insert (only if price changed)
    const rows = [];
    for (const st of stations) {
      for (const [fuelType, priceKey] of [["e5", "e5"], ["e10", "e10"], ["diesel", "diesel"]]) {
        const price = st[priceKey];
        if (typeof price !== "number" || price <= 0) continue;

        const key = `${st.id}_${fuelType}`;
        const lastPrice = latestPrices[key];

        // Only insert if price changed or no previous record
        if (lastPrice !== undefined && Math.abs(lastPrice - price) < 0.0005) {
          results.skipped++;
          continue;
        }

        rows.push({
          station_id: st.id,
          fuel_type: fuelType,
          price: price,
          station_name: st.name,
          brand: st.brand || null,
          place: st.place || null,
          lat: st.lat || null,
          lng: st.lng || null,
          is_open: st.isOpen || false,
          fetched_at: now,
        });
      }
    }

    // Batch insert into Supabase
    if (rows.length > 0) {
      // Insert in chunks of 500
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const insertRes = await fetch(
          `${SUPABASE_URL}/rest/v1/price_snapshots`,
          {
            method: "POST",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal",
            },
            body: JSON.stringify(chunk),
          }
        );
        if (!insertRes.ok) {
          const errText = await insertRes.text();
          results.errors.push(`Insert error: ${insertRes.status} ${errText}`);
        } else {
          results.inserted += chunk.length;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      timestamp: now,
      ...results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, ...results });
  }
}
