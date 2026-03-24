// /api/collect.js — Vercel Serverless Function
// Fetches gas prices from Tankerkönig + Brent from EIA, stores in Supabase
// Triggered by cron-job.org every 30 minutes

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const TK_KEY = process.env.TANKERKOENIG_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const EIA_KEY = process.env.EIA_API_KEY;
  const LAT = process.env.LAT || "52.4227";
  const LNG = process.env.LNG || "10.7865";
  const RAD = process.env.RAD || "25";

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars" });
  }

  const headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };

  const results = { fetched: 0, inserted: 0, skipped: 0, brent: null, errors: [] };

  try {
    // ═══ 1. FETCH GAS PRICES ═══════════════════════════════════
    const tkUrl = `https://creativecommons.tankerkoenig.de/json/list.php?lat=${LAT}&lng=${LNG}&rad=${RAD}&sort=dist&type=all&apikey=${TK_KEY}`;
    const tkRes = await fetch(tkUrl);
    const tkData = await tkRes.json();

    if (!tkData.ok) {
      return res.status(502).json({ error: `Tankerkönig error: ${tkData.message}` });
    }

    const stations = tkData.stations || [];
    results.fetched = stations.length;
    const now = new Date().toISOString();

    // Get latest prices for dedup
    const latestRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/get_latest_prices`,
      { method: "POST", headers, body: JSON.stringify({}) }
    );

    let latestPrices = {};
    try {
      const latestData = await latestRes.json();
      if (Array.isArray(latestData)) {
        for (const row of latestData) {
          latestPrices[`${row.station_id}_${row.fuel_type}`] = row.price;
        }
      }
    } catch (e) {}

    const rows = [];
    for (const st of stations) {
      for (const [fuelType, priceKey] of [["e5", "e5"], ["e10", "e10"], ["diesel", "diesel"]]) {
        const price = st[priceKey];
        if (typeof price !== "number" || price <= 0) continue;
        const key = `${st.id}_${fuelType}`;
        const lastPrice = latestPrices[key];
        if (lastPrice !== undefined && Math.abs(lastPrice - price) < 0.0005) {
          results.skipped++;
          continue;
        }
        rows.push({
          station_id: st.id, fuel_type: fuelType, price,
          station_name: st.name, brand: st.brand || null,
          place: st.place || null, lat: st.lat || null, lng: st.lng || null,
          is_open: st.isOpen || false, fetched_at: now,
        });
      }
    }

    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const insertRes = await fetch(
          `${SUPABASE_URL}/rest/v1/price_snapshots`,
          { method: "POST", headers: { ...headers, "Prefer": "return=minimal" }, body: JSON.stringify(chunk) }
        );
        if (!insertRes.ok) {
          results.errors.push(`Insert error: ${insertRes.status} ${await insertRes.text()}`);
        } else {
          results.inserted += chunk.length;
        }
      }
    }

    // ═══ 2. FETCH BRENT — Yahoo Finance (real-time) + EIA (historical) ═══
    const brentResults = { yahoo: null, eia: null };

    // 2a. Yahoo Finance — real-time Brent futures (BZ=F)
    try {
      const yUrl = "https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=3mo&interval=1d";
      const yRes = await fetch(yUrl, {
        headers: { "User-Agent": "TankRadar/1.0" },
      });
      const yData = await yRes.json();
      const quotes = yData?.chart?.result?.[0];
      if (quotes?.timestamp?.length > 0) {
        const ts = quotes.timestamp;
        const closes = quotes.indicators?.quote?.[0]?.close || [];
        const yRows = [];
        for (let i = 0; i < ts.length; i++) {
          const price = closes[i];
          if (!price || price <= 0) continue;
          const d = new Date(ts[i] * 1000);
          const period = d.toISOString().slice(0, 10);
          yRows.push({ price: +price.toFixed(2), currency: "USD", period });
        }
        if (yRows.length > 0) {
          const yInsert = await fetch(
            `${SUPABASE_URL}/rest/v1/brent_history?on_conflict=period`,
            {
              method: "POST",
              headers: { ...headers, "Prefer": "return=minimal,resolution=merge-duplicates" },
              body: JSON.stringify(yRows),
            }
          );
          const latest = yRows[yRows.length - 1];
          brentResults.yahoo = yInsert.ok
            ? `${yRows.length} days, latest: $${latest.price} (${latest.period})`
            : `insert error: ${yInsert.status}`;
        }
      }
    } catch (e) {
      brentResults.yahoo = `error: ${e.message}`;
    }

    // 2b. EIA — authoritative historical backfill (3-5 day delay)
    if (EIA_KEY) {
      try {
        const eiaUrl = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${EIA_KEY}&data[]=value&facets[series][]=RBRTE&frequency=daily&sort[0][column]=period&sort[0][direction]=desc&length=90`;
        const eiaRes = await fetch(eiaUrl);
        const eiaData = await eiaRes.json();

        if (eiaData?.response?.data?.length > 0) {
          const brentRows = eiaData.response.data
            .filter(d => d.value && parseFloat(d.value) > 0)
            .map(d => ({
              price: parseFloat(d.value),
              currency: "USD",
              period: d.period,
            }));

          if (brentRows.length > 0) {
            const brentRes = await fetch(
              `${SUPABASE_URL}/rest/v1/brent_history?on_conflict=period`,
              {
                method: "POST",
                headers: { ...headers, "Prefer": "return=minimal,resolution=ignore-duplicates" },
                body: JSON.stringify(brentRows),
              }
            );
            brentResults.eia = brentRes.ok
              ? `${brentRows.length} days, latest: $${brentRows[0].price} (${brentRows[0].period})`
              : `insert error: ${brentRes.status}`;
          }
        }
      } catch (e) {
        brentResults.eia = `error: ${e.message}`;
      }
    }

    results.brent = brentResults;

    return res.status(200).json({ ok: true, timestamp: now, ...results });
  } catch (e) {
    return res.status(500).json({ error: e.message, ...results });
  }
}
