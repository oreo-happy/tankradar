// /api/tg-connect.js — Telegram auto-connect
// 1. Frontend generates a random token and opens t.me/Tankradar24_bot?start=TOKEN
// 2. User taps Start in Telegram, which sends "/start TOKEN" to the bot
// 3. Frontend polls this endpoint with the token
// 4. This endpoint checks getUpdates for a matching /start TOKEN message
// 5. Returns the chat_id when found

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  if (!TELEGRAM_TOKEN) {
    return res.status(500).json({ error: "Missing TELEGRAM_TOKEN" });
  }

  const { token } = req.query;
  if (!token || token.length < 6) {
    return res.status(400).json({ error: "Invalid token" });
  }

  try {
    // Get recent messages sent to the bot
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?limit=50&timeout=0`
    );
    const data = await r.json();

    if (!data.ok || !data.result) {
      return res.status(200).json({ ok: false, found: false });
    }

    // Look for a /start message containing our token
    for (const update of data.result) {
      const msg = update.message;
      if (!msg || !msg.text) continue;

      // Telegram sends "/start TOKEN" when user clicks t.me/bot?start=TOKEN
      if (msg.text === `/start ${token}` || msg.text === `/start ${token} `) {
        const chatId = msg.chat.id;
        const firstName = msg.chat.first_name || "";
        const username = msg.chat.username || "";

        // Send a welcome message
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `✅ <b>TankRadar verbunden!</b>\n\nHi ${firstName}! Du bekommst ab jetzt Preisalarme hier.\n\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });

        return res.status(200).json({
          ok: true,
          found: true,
          chat_id: String(chatId),
          name: firstName,
          username,
        });
      }
    }

    // Not found yet — user hasn't tapped Start
    return res.status(200).json({ ok: true, found: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
