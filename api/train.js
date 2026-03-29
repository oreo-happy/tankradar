// /api/train.js — Nightly ML training job
// Queries price history from Supabase, computes per-station patterns,
// stores model coefficients back in Supabase.
// Trigger: cron-job.org daily at 03:00 or manually via URL

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing Supabase config" });
  }

  const headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };

  const stats = { stations: 0, dataPoints: 0, modelSize: 0, errors: [] };

  try {
    // ─── 1. FETCH ALL DATA FROM LAST 30 DAYS ──────────────────
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    let allData = [];
    let offset = 0;
    const pageSize = 1000;

    // Paginate through all records
    while (true) {
      const url = `${SUPABASE_URL}/rest/v1/price_snapshots?fetched_at=gte.${cutoff}&order=fetched_at.asc&limit=${pageSize}&offset=${offset}`;
      const r = await fetch(url, { headers });
      const page = await r.json();
      if (!Array.isArray(page) || page.length === 0) break;
      allData = allData.concat(page);
      offset += pageSize;
      if (page.length < pageSize) break;
      // Safety: max 100k rows
      if (offset > 100000) break;
    }

    stats.dataPoints = allData.length;

    if (allData.length < 100) {
      return res.status(200).json({
        ok: true,
        message: `Only ${allData.length} data points — need at least 100. Waiting for more data.`,
        ...stats,
      });
    }

    // ─── 2. COMPUTE PER-STATION HOURLY PATTERNS ───────────────
    // For each station+fuel, compute:
    // - avgPrice: overall average
    // - hourlyDelta[0..23]: avg deviation from mean per hour
    // - dailyDelta[0..6]: avg deviation from mean per day (Mon=0)
    // - volatility: std dev of prices (how much this station swings)
    // - vacSensitivity: avg price increase near known vacation dates
    // - trend: 7-day price direction (rising/falling/stable)

    const stationMap = {}; // key: `${station_id}_${fuel_type}`

    for (const row of allData) {
      const key = `${row.station_id}_${row.fuel_type}`;
      if (!stationMap[key]) {
        stationMap[key] = {
          station_id: row.station_id,
          fuel_type: row.fuel_type,
          brand: row.brand,
          station_name: row.station_name,
          place: row.place,
          prices: [],
        };
      }
      const dt = new Date(row.fetched_at);
      stationMap[key].prices.push({
        price: parseFloat(row.price),
        hour: dt.getUTCHours(),
        dow: (dt.getUTCDay() + 6) % 7, // Mon=0
        ts: dt.getTime(),
        date: row.fetched_at.slice(0, 10),
      });
    }

    // Known vacation start dates (for sensitivity calc)
    const vacDates = [
      "2025-03-31","2025-07-03","2025-10-13","2025-12-22",
      "2026-02-02","2026-03-23","2026-07-16","2026-10-12","2026-12-23",
      "2025-04-07","2025-06-28","2025-07-14","2025-07-24",
    ].map(d => new Date(d + "T00:00:00").getTime());

    const isNearVacation = (ts) => {
      for (const vd of vacDates) {
        const diff = (vd - ts) / 86400000;
        if (diff >= -1 && diff <= 5) return true;
      }
      return false;
    };

    const model = {};

    for (const [key, data] of Object.entries(stationMap)) {
      if (data.prices.length < 10) continue; // need minimum data

      const prices = data.prices.map(p => p.price);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

      // Hourly deltas
      const hourBuckets = Array.from({ length: 24 }, () => []);
      for (const p of data.prices) {
        hourBuckets[p.hour].push(p.price - avg);
      }
      const hourlyDelta = hourBuckets.map(b =>
        b.length > 0 ? +(b.reduce((a, v) => a + v, 0) / b.length).toFixed(4) : 0
      );

      // Daily deltas (Mon=0)
      const dayBuckets = Array.from({ length: 7 }, () => []);
      for (const p of data.prices) {
        dayBuckets[p.dow].push(p.price - avg);
      }
      const dailyDelta = dayBuckets.map(b =>
        b.length > 0 ? +(b.reduce((a, v) => a + v, 0) / b.length).toFixed(4) : 0
      );

      // Volatility (standard deviation)
      const variance = prices.reduce((a, p) => a + Math.pow(p - avg, 2), 0) / prices.length;
      const volatility = +Math.sqrt(variance).toFixed(4);

      // Vacation sensitivity
      const vacPrices = data.prices.filter(p => isNearVacation(p.ts)).map(p => p.price);
      const nonVacPrices = data.prices.filter(p => !isNearVacation(p.ts)).map(p => p.price);
      const vacAvg = vacPrices.length > 0 ? vacPrices.reduce((a, b) => a + b, 0) / vacPrices.length : avg;
      const nonVacAvg = nonVacPrices.length > 0 ? nonVacPrices.reduce((a, b) => a + b, 0) / nonVacPrices.length : avg;
      const vacSensitivity = +((vacAvg - nonVacAvg) * 100).toFixed(2); // in cents

      // Trend: compare last 3 days avg vs previous 3 days
      const now = Date.now();
      const recent = data.prices.filter(p => p.ts > now - 3 * 86400000).map(p => p.price);
      const prior = data.prices.filter(p => p.ts > now - 7 * 86400000 && p.ts <= now - 3 * 86400000).map(p => p.price);
      const recentAvg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : avg;
      const priorAvg = prior.length > 0 ? prior.reduce((a, b) => a + b, 0) / prior.length : avg;
      const trend = +((recentAvg - priorAvg) * 100).toFixed(2); // in cents, positive = rising

      // Best hours (top 3 cheapest hours)
      const hourAvgs = hourlyDelta.map((d, h) => ({ h, d })).sort((a, b) => a.d - b.d);
      const bestHours = hourAvgs.slice(0, 3).map(x => x.h);
      const worstHours = hourAvgs.slice(-3).map(x => x.h);

      // Price range
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);

      model[key] = {
        sid: data.station_id,
        ft: data.fuel_type,
        br: data.brand,
        nm: data.station_name,
        pl: data.place,
        n: data.prices.length,
        avg: +avg.toFixed(3),
        hd: hourlyDelta,   // hourly delta [0..23]
        dd: dailyDelta,     // daily delta [0..6] Mon=0
        vol: volatility,
        vs: vacSensitivity, // vacation sensitivity in ct
        tr: trend,          // 3d trend in ct
        bh: bestHours,      // best 3 hours
        wh: worstHours,     // worst 3 hours
        mn: +minPrice.toFixed(3),
        mx: +maxPrice.toFixed(3),
      };

      stats.stations++;
    }

    // ─── 3. COMPUTE MARKET-LEVEL STATS ─────────────────────────
    const allStationAvgs = Object.values(model).map(m => m.avg);
    const marketAvg = allStationAvgs.length > 0
      ? +(allStationAvgs.reduce((a, b) => a + b, 0) / allStationAvgs.length).toFixed(3)
      : 0;

    // Best overall hours across all stations
    const globalHourly = Array.from({ length: 24 }, () => []);
    for (const m of Object.values(model)) {
      m.hd.forEach((d, h) => globalHourly[h].push(d));
    }
    const globalHourlyAvg = globalHourly.map(b =>
      b.length > 0 ? +(b.reduce((a, v) => a + v, 0) / b.length * 100).toFixed(1) : 0
    );

    const globalDaily = Array.from({ length: 7 }, () => []);
    for (const m of Object.values(model)) {
      m.dd.forEach((d, i) => globalDaily[i].push(d));
    }
    const globalDailyAvg = globalDaily.map(b =>
      b.length > 0 ? +(b.reduce((a, v) => a + v, 0) / b.length * 100).toFixed(1) : 0
    );

    const fullModel = {
      version: 2,
      trained_at: new Date().toISOString(),
      data_points: stats.dataPoints,
      stations_trained: stats.stations,
      market: {
        avg: marketAvg,
        hourly_ct: globalHourlyAvg,
        daily_ct: globalDailyAvg,
      },
      brent: null,
      stations: model,
    };

    // ─── 3b. BRENT CORRELATION & LAG ANALYSIS ──────────────────
    try {
      // Fetch Brent history
      const brentRes = await fetch(
        `${SUPABASE_URL}/rest/v1/brent_history?order=period.desc&limit=90`,
        { headers }
      );
      const brentData = await brentRes.json();

      if (Array.isArray(brentData) && brentData.length >= 7) {
        // Build daily pump price averages
        const pumpByDay = {};
        for (const row of allData) {
          if (row.fuel_type !== "e10") continue; // use e10 as benchmark
          const day = row.fetched_at.slice(0, 10);
          if (!pumpByDay[day]) pumpByDay[day] = [];
          pumpByDay[day].push(parseFloat(row.price));
        }
        const dailyPump = {};
        for (const [day, prices] of Object.entries(pumpByDay)) {
          dailyPump[day] = +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3);
        }

        // Build Brent daily map
        const dailyBrent = {};
        for (const b of brentData) {
          dailyBrent[b.period] = parseFloat(b.price);
        }

        // Get EUR/USD for conversion
        let usdEur = 0.92;
        try {
          const fxRes = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR");
          const fxData = await fxRes.json();
          if (fxData.rates?.EUR) usdEur = fxData.rates.EUR;
        } catch {}

        // Sorted dates where we have both pump and brent data
        const allDays = Object.keys(dailyPump).filter(d => dailyBrent[d]).sort();

        // Cross-correlation: try lags 0-21 days
        const lagCorrelations = [];
        if (allDays.length >= 5) {
          for (let lag = 0; lag <= 21; lag++) {
            const pairs = [];
            for (let i = lag; i < allDays.length; i++) {
              const pumpDay = allDays[i];
              const brentDay = allDays[i - lag];
              if (dailyPump[pumpDay] && dailyBrent[brentDay]) {
                pairs.push({ pump: dailyPump[pumpDay], brent: dailyBrent[brentDay] * usdEur / 159 }); // convert to EUR per litre
              }
            }
            if (pairs.length >= 3) {
              const avgPump = pairs.reduce((a, p) => a + p.pump, 0) / pairs.length;
              const avgBrent = pairs.reduce((a, p) => a + p.brent, 0) / pairs.length;
              let num = 0, denPump = 0, denBrent = 0;
              for (const p of pairs) {
                const dp = p.pump - avgPump;
                const db = p.brent - avgBrent;
                num += dp * db;
                denPump += dp * dp;
                denBrent += db * db;
              }
              const corr = (denPump > 0 && denBrent > 0) ? num / Math.sqrt(denPump * denBrent) : 0;
              lagCorrelations.push({ lag, corr: +corr.toFixed(4), pairs: pairs.length });
            }
          }
        }

        // Find optimal lag (highest correlation)
        const bestLag = lagCorrelations.length > 0
          ? lagCorrelations.reduce((a, b) => Math.abs(b.corr) > Math.abs(a.corr) ? b : a)
          : { lag: 14, corr: 0 };

        // Asymmetric lag: separate rising vs falling Brent
        let upLags = [], downLags = [];
        if (allDays.length >= 5) {
          for (let i = 1; i < allDays.length; i++) {
            const prevBrent = dailyBrent[allDays[i - 1]];
            const currBrent = dailyBrent[allDays[i]];
            if (!prevBrent || !currBrent) continue;
            const brentChange = currBrent - prevBrent;
            // Look for when pump followed
            for (let j = i; j < Math.min(i + 21, allDays.length); j++) {
              const pumpChange = dailyPump[allDays[j]] - dailyPump[allDays[i]];
              if (brentChange > 0.5 && pumpChange > 0.003) { upLags.push(j - i); break; }
              if (brentChange < -0.5 && pumpChange < -0.003) { downLags.push(j - i); break; }
            }
          }
        }

        const avgUpLag = upLags.length > 0 ? +(upLags.reduce((a, b) => a + b, 0) / upLags.length).toFixed(1) : null;
        const avgDownLag = downLags.length > 0 ? +(downLags.reduce((a, b) => a + b, 0) / downLags.length).toFixed(1) : null;

        // Current Brent trend (14-day change)
        const sortedBrent = brentData.sort((a, b) => a.period.localeCompare(b.period));
        const latestBrent = sortedBrent[sortedBrent.length - 1];
        const brent14ago = sortedBrent.length >= 14 ? sortedBrent[sortedBrent.length - 14] : sortedBrent[0];
        const brentTrend14d = latestBrent && brent14ago
          ? +((parseFloat(latestBrent.price) - parseFloat(brent14ago.price)) / parseFloat(brent14ago.price) * 100).toFixed(1)
          : 0;

        // Predict pump direction
        const brentChangeUsd = latestBrent && brent14ago
          ? parseFloat(latestBrent.price) - parseFloat(brent14ago.price) : 0;
        const brentChangeEurPerL = brentChangeUsd * usdEur / 159;
        const predictedPumpChange = +(brentChangeEurPerL * 1.19 * 100).toFixed(1); // include MwSt

        // Confidence based on data quality
        const confidence = Math.min(100, Math.round(
          (allDays.length >= 14 ? 30 : allDays.length * 2) +
          (lagCorrelations.length >= 5 ? 20 : lagCorrelations.length * 4) +
          (Math.abs(bestLag.corr) * 50)
        ));

        fullModel.brent = {
          latest: latestBrent ? { price: parseFloat(latestBrent.price), date: latestBrent.period } : null,
          trend14d: brentTrend14d,                    // % change over 14 days
          predictedPumpChangeCt: predictedPumpChange,  // predicted ct/L change at pump
          optimalLag: bestLag.lag,                      // best correlation lag in days
          optimalCorrelation: bestLag.corr,             // correlation at that lag
          asymmetry: {
            upLagDays: avgUpLag,                       // avg days for price increases to propagate
            downLagDays: avgDownLag,                    // avg days for decreases (usually longer)
            samples: { up: upLags.length, down: downLags.length },
          },
          direction: brentTrend14d > 3 ? "rising" : brentTrend14d < -3 ? "falling" : "stable",
          confidence,
          usdEur,
          lagCorrelations: lagCorrelations.slice(0, 10), // top lags for debugging
        };
      }
    } catch (e) {
      stats.errors.push(`Brent analysis error: ${e.message}`);
    }

    const modelJson = JSON.stringify(fullModel);
    stats.modelSize = modelJson.length;

    // ─── 4. STORE MODEL IN SUPABASE ────────────────────────────
    // Upsert the model into ml_models table
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ml_models?on_conflict=id`,
      {
        method: "POST",
        headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({
          id: "price_model_v1",
          model: fullModel,
          trained_at: new Date().toISOString(),
        }),
      }
    );

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      stats.errors.push(`Model save error: ${upsertRes.status} ${errText}`);
    }

    // ─── 5. FORECAST FEEDBACK LOOP ─────────────────────────────
    const forecastStats = { saved: 0, evaluated: 0, backtested: 0 };

    try {
      // Build daily actual averages for e10 (our benchmark fuel)
      const actualByDay = {};
      for (const row of allData) {
        if (row.fuel_type !== "e10") continue;
        const day = row.fetched_at.slice(0, 10);
        if (!actualByDay[day]) actualByDay[day] = [];
        actualByDay[day].push(parseFloat(row.price));
      }
      const dailyActuals = {};
      for (const [day, prices] of Object.entries(actualByDay)) {
        dailyActuals[day] = +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3);
      }
      const actualDates = Object.keys(dailyActuals).sort();

      // Helper: predict price for a given date using current model
      const predictForDate = (dateStr) => {
        const d = new Date(dateStr + "T12:00:00Z");
        const dow = (d.getUTCDay() + 6) % 7; // Mon=0
        const hBest = +(globalHourlyAvg[19] || 0); // best hour ~19:00
        const hWorst = +(globalHourlyAvg[6] || 0);  // worst hour ~6:00
        const hAvg = +(globalHourlyAvg[12] || 0);   // midday as avg proxy
        const dDelta = +(globalDailyAvg[dow] || 0);

        // Vacation check
        let vacDelta = 0;
        for (const vd of vacDates) {
          const diff = (vd - d.getTime()) / 86400000;
          if (diff >= -1 && diff <= 5) { vacDelta = 4; break; }
        }

        const base = marketAvg;
        return {
          avg: +(base + (hAvg + dDelta + vacDelta) / 100).toFixed(3),
          best: +(base + (hBest + dDelta + vacDelta) / 100).toFixed(3),
          worst: +(base + (hWorst + dDelta + vacDelta) / 100).toFixed(3),
        };
      };

      // 5a. SAVE CURRENT 14-DAY FORECAST ─────────────────────────
      const today = new Date().toISOString().slice(0, 10);
      const forecastRows = [];
      for (let i = 0; i <= 14; i++) {
        const fd = new Date();
        fd.setDate(fd.getDate() + i);
        const dateStr = fd.toISOString().slice(0, 10);
        const pred = predictForDate(dateStr);
        forecastRows.push({
          forecast_date: dateStr,
          fuel_type: "e10",
          predicted_avg: pred.avg,
          predicted_best: pred.best,
          predicted_worst: pred.worst,
          horizon_days: i,
          model_version: `v${fullModel.version}_${today}`,
        });
      }

      if (forecastRows.length > 0) {
        const fcRes = await fetch(
          `${SUPABASE_URL}/rest/v1/forecast_snapshots?on_conflict=forecast_date,fuel_type,horizon_days`,
          {
            method: "POST",
            headers: { ...headers, "Prefer": "return=minimal,resolution=merge-duplicates" },
            body: JSON.stringify(forecastRows),
          }
        );
        if (fcRes.ok) forecastStats.saved = forecastRows.length;
        else stats.errors.push(`Forecast save: ${fcRes.status} ${await fcRes.text()}`);
      }

      // 5b. BACKTEST — evaluate past predictions against actuals ──
      // Fetch unevaluated snapshots where we now have actual data
      const unevalRes = await fetch(
        `${SUPABASE_URL}/rest/v1/forecast_snapshots?actual_avg=is.null&fuel_type=eq.e10&order=forecast_date.asc&limit=500`,
        { headers }
      );
      const unevalRows = await unevalRes.json();

      if (Array.isArray(unevalRows)) {
        const updates = [];
        for (const row of unevalRows) {
          const actual = dailyActuals[row.forecast_date];
          if (actual) {
            const errorCt = +((row.predicted_avg - actual) * 100).toFixed(2);
            updates.push({
              id: row.id,
              actual_avg: actual,
              error_ct: errorCt,
              evaluated_at: new Date().toISOString(),
            });
          }
        }

        // Batch update evaluated rows
        for (const u of updates) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/forecast_snapshots?id=eq.${u.id}`,
            {
              method: "PATCH",
              headers: { ...headers, "Prefer": "return=minimal" },
              body: JSON.stringify({
                actual_avg: u.actual_avg,
                error_ct: u.error_ct,
                evaluated_at: u.evaluated_at,
              }),
            }
          );
        }
        forecastStats.evaluated = updates.length;
      }

      // 5c. BACKTEST HISTORICAL — reconstruct predictions for days
      // where we have actual data but never saved a forecast
      if (actualDates.length >= 3) {
        const backRows = [];
        for (let i = 0; i < actualDates.length; i++) {
          const dateStr = actualDates[i];
          const actual = dailyActuals[dateStr];
          const pred = predictForDate(dateStr);
          const errorCt = +((pred.avg - actual) * 100).toFixed(2);

          // Simulate different horizons (0=same day, 1=1 day ahead, etc)
          for (const hz of [0, 1, 3, 7]) {
            if (i >= hz) {
              backRows.push({
                forecast_date: dateStr,
                fuel_type: "e10",
                predicted_avg: pred.avg,
                predicted_best: pred.best,
                predicted_worst: pred.worst,
                actual_avg: actual,
                error_ct: errorCt,
                horizon_days: hz,
                model_version: `backtest_${today}`,
                evaluated_at: new Date().toISOString(),
              });
            }
          }
        }

        if (backRows.length > 0) {
          const btRes = await fetch(
            `${SUPABASE_URL}/rest/v1/forecast_snapshots?on_conflict=forecast_date,fuel_type,horizon_days`,
            {
              method: "POST",
              headers: { ...headers, "Prefer": "return=minimal,resolution=ignore-duplicates" },
              body: JSON.stringify(backRows),
            }
          );
          if (btRes.ok) forecastStats.backtested = backRows.length;
          else stats.errors.push(`Backtest save: ${btRes.status}`);
        }
      }

      // 5d. COMPUTE ACCURACY & BIAS CORRECTIONS ──────────────────
      // Fetch all evaluated forecasts
      const evalRes = await fetch(
        `${SUPABASE_URL}/rest/v1/forecast_snapshots?error_ct=not.is.null&fuel_type=eq.e10&order=forecast_date.desc&limit=1000`,
        { headers }
      );
      const evalRows = await evalRes.json();

      if (Array.isArray(evalRows) && evalRows.length >= 3) {
        // Accuracy by horizon
        const byHorizon = {};
        for (const r of evalRows) {
          const hz = r.horizon_days;
          if (!byHorizon[hz]) byHorizon[hz] = [];
          byHorizon[hz].push(parseFloat(r.error_ct));
        }

        const accuracy = {};
        for (const [hz, errors] of Object.entries(byHorizon)) {
          const mae = +(errors.reduce((a, e) => a + Math.abs(e), 0) / errors.length).toFixed(2);
          const bias = +(errors.reduce((a, e) => a + e, 0) / errors.length).toFixed(2);
          accuracy[`${hz}d`] = { mae, bias, n: errors.length };
        }

        // Bias by day-of-week
        const byDow = Array.from({ length: 7 }, () => []);
        for (const r of evalRows) {
          const d = new Date(r.forecast_date + "T12:00:00Z");
          const dow = (d.getUTCDay() + 6) % 7;
          byDow[dow].push(parseFloat(r.error_ct));
        }
        const dowBias = byDow.map(errors =>
          errors.length >= 2
            ? +(errors.reduce((a, e) => a + e, 0) / errors.length).toFixed(2)
            : 0
        );

        // Overall accuracy
        const allErrors = evalRows.map(r => parseFloat(r.error_ct));
        const overallMAE = +(allErrors.reduce((a, e) => a + Math.abs(e), 0) / allErrors.length).toFixed(2);
        const overallBias = +(allErrors.reduce((a, e) => a + e, 0) / allErrors.length).toFixed(2);

        // Store in model
        fullModel.accuracy = {
          overall: { mae: overallMAE, bias: overallBias, n: allErrors.length },
          byHorizon: accuracy,
          dowBias,  // correction per day-of-week in ct (subtract from prediction)
          lastEval: new Date().toISOString(),
        };

        // Re-save model with accuracy data
        await fetch(
          `${SUPABASE_URL}/rest/v1/ml_models?on_conflict=id`,
          {
            method: "POST",
            headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify({
              id: "price_model_v1",
              model: fullModel,
              trained_at: new Date().toISOString(),
            }),
          }
        );
      }
    } catch (e) {
      stats.errors.push(`Forecast loop error: ${e.message}`);
    }

    return res.status(200).json({
      ok: true,
      ...stats,
      forecast: forecastStats,
      modelSize: `${(stats.modelSize / 1024).toFixed(1)} KB`,
      preview: {
        marketAvg: fullModel.market.avg,
        bestGlobalHours: globalHourlyAvg.map((d, h) => ({ h, d })).sort((a, b) => a.d - b.d).slice(0, 3).map(x => `${x.h}:00 (${x.d}ct)`),
        worstGlobalHours: globalHourlyAvg.map((d, h) => ({ h, d })).sort((a, b) => b.d - a.d).slice(0, 3).map(x => `${x.h}:00 (+${x.d}ct)`),
        bestDay: ["Mo","Di","Mi","Do","Fr","Sa","So"][globalDailyAvg.indexOf(Math.min(...globalDailyAvg))],
        worstDay: ["Mo","Di","Mi","Do","Fr","Sa","So"][globalDailyAvg.indexOf(Math.max(...globalDailyAvg))],
        accuracy: fullModel.accuracy || "Not enough evaluated forecasts",
        sampleStation: Object.values(model)[0] ? {
          name: Object.values(model)[0].nm,
          avg: Object.values(model)[0].avg,
          volatility: Object.values(model)[0].vol,
          vacSensitivity: Object.values(model)[0].vs + " ct",
          trend: Object.values(model)[0].tr + " ct (3d)",
        } : null,
        brent: fullModel.brent ? {
          latest: `$${fullModel.brent.latest?.price} (${fullModel.brent.latest?.date})`,
          trend: `${fullModel.brent.trend14d}% (14d)`,
          direction: fullModel.brent.direction,
          pumpForecast: `${fullModel.brent.predictedPumpChangeCt > 0 ? "+" : ""}${fullModel.brent.predictedPumpChangeCt} ct/L`,
          optimalLag: `${fullModel.brent.optimalLag} days (r=${fullModel.brent.optimalCorrelation})`,
          asymmetry: fullModel.brent.asymmetry?.upLagDays != null ? `Up: ${fullModel.brent.asymmetry.upLagDays}d, Down: ${fullModel.brent.asymmetry.downLagDays}d` : "Not enough data",
          confidence: `${fullModel.brent.confidence}%`,
        } : "No Brent data",
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack, ...stats });
  }
}
