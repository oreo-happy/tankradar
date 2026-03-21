// /api/history.js — Read price history for a station
// Called by frontend: /api/history?station_id=xxx&fuel=e10&days=7

export default async function handler(req, res) {
  // CORS headers for frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing Supabase config" });
  }

  const { station_id, fuel = "e10", days = "7" } = req.query;

  if (!station_id) {
    return res.status(400).json({ error: "station_id required" });
  }

  const cutoff = new Date(Date.now() - parseInt(days) * 86400000).toISOString();

  try {
    const url = `${SUPABASE_URL}/rest/v1/price_snapshots?station_id=eq.${station_id}&fuel_type=eq.${fuel}&fetched_at=gte.${cutoff}&order=fetched_at.asc&limit=500`;
    const r = await fetch(url, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
    });
    const data = await r.json();
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
