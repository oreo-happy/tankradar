// /api/market-history.js — Daily market averages from Supabase
// Returns daily avg/min prices across all stations for chart display

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=900"); // cache 15 min

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing Supabase config" });
  }

  const { fuel = "e10", days = "30" } = req.query;
  const cutoff = new Date(Date.now() - parseInt(days) * 86400000).toISOString();

  try {
    // Fetch all price snapshots for this fuel type
    let allData = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const url = `${SUPABASE_URL}/rest/v1/price_snapshots?fuel_type=eq.${fuel}&fetched_at=gte.${cutoff}&select=price,fetched_at&order=fetched_at.asc&limit=${pageSize}&offset=${offset}`;
      const r = await fetch(url, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      });
      const page = await r.json();
      if (!Array.isArray(page) || page.length === 0) break;
      allData = allData.concat(page);
      offset += pageSize;
      if (page.length < pageSize) break;
      if (offset > 50000) break;
    }

    // Aggregate by day
    const byDay = {};
    for (const row of allData) {
      const day = row.fetched_at.slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(parseFloat(row.price));
    }

    const daily = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, prices]) => ({
        date,
        ts: new Date(date + "T12:00:00Z").getTime(),
        avg: +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3),
        min: +Math.min(...prices).toFixed(3),
        max: +Math.max(...prices).toFixed(3),
        n: prices.length,
      }));

    return res.status(200).json({ ok: true, fuel, days: daily.length, data: daily });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
