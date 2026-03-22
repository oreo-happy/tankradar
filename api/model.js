// /api/model.js — Serve trained model to frontend
// Called on page load to replace hardcoded patterns with real data

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=1800"); // cache 30 min

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing Supabase config" });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/ml_models?id=eq.price_model_v1&select=model,trained_at&limit=1`,
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const data = await r.json();

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(200).json({ ok: false, message: "No model trained yet" });
    }

    return res.status(200).json({
      ok: true,
      trained_at: data[0].trained_at,
      model: data[0].model,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
