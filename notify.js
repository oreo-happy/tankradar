// /api/notify.js — Send price alerts via Telegram, Email, ntfy.sh
// Called by /api/collect when prices drop below threshold
// Can also be triggered manually: /api/notify?secret=xxx&test=1

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const RESEND_KEY = process.env.RESEND_KEY;

  const { chat_id, email, ntfy_topic, message, subject, test } = req.query;
  const body = req.method === "POST" ? req.body : null;

  const msg = message || body?.message || (test ? "🧪 TankRadar Test — alles funktioniert!" : null);
  const subj = subject || body?.subject || "⛽ TankRadar Preisalarm";

  if (!msg) return res.status(400).json({ error: "No message" });

  const results = { telegram: null, email: null, ntfy: null };

  const tgChat = chat_id || body?.chat_id;
  if (tgChat && TELEGRAM_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tgChat, text: msg, parse_mode: "HTML" }),
      });
      const d = await r.json();
      results.telegram = d.ok ? "sent" : d.description || "failed";
    } catch (e) { results.telegram = e.message; }
  }

  const emailAddr = email || body?.email;
  if (emailAddr && RESEND_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "TankRadar <onboarding@resend.dev>",
          to: [emailAddr],
          subject: subj,
          html: `<div style="font-family:sans-serif;padding:20px"><h2 style="color:#10b981">⛽ TankRadar</h2><p>${msg.replace(/\n/g,"<br/>")}</p></div>`,
        }),
      });
      const d = await r.json();
      results.email = d.id ? "sent" : d.message || "failed";
    } catch (e) { results.email = e.message; }
  }

  const ntfyT = ntfy_topic || body?.ntfy_topic;
  if (ntfyT) {
    try {
      const r = await fetch(`https://ntfy.sh/${ntfyT}`, {
        method: "POST",
        headers: { "Title": subj, "Priority": "high", "Tags": "fuelpump", "Click": "https://tankradar.vercel.app" },
        body: msg,
      });
      results.ntfy = r.ok ? "sent" : `error: ${r.status}`;
    } catch (e) { results.ntfy = e.message; }
  }

  return res.status(200).json({ ok: true, ...results });
}
