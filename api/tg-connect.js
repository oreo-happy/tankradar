// /api/tg-connect.js — Telegram auto-connect with multi-language

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  if (!TELEGRAM_TOKEN) {
    return res.status(500).json({ error: "Missing TELEGRAM_TOKEN" });
  }

  const { token, lang = "de" } = req.query;
  if (!token || token.length < 6) {
    return res.status(400).json({ error: "Invalid token" });
  }

  const WELCOME = {
    de: (name) => `✅ <b>TankRadar verbunden!</b>\n\nHey${name ? " " + name : ""}! Du bekommst ab jetzt Preisalarme direkt hier auf Telegram.\n\n🔔 Alarme kannst du in der App konfigurieren.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`,
    en: (name) => `✅ <b>TankRadar connected!</b>\n\nHey${name ? " " + name : ""}! You'll now receive price alerts right here on Telegram.\n\n🔔 Configure alerts in the app.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`,
    tr: (name) => `✅ <b>TankRadar bağlandı!</b>\n\nMerhaba${name ? " " + name : ""}! Artık fiyat alarmlarını doğrudan Telegram'dan alacaksın.\n\n🔔 Alarmları uygulamadan ayarlayabilirsin.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`,
  };

  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?limit=50&timeout=0`
    );
    const data = await r.json();

    if (!data.ok || !data.result) {
      return res.status(200).json({ ok: false, found: false });
    }

    for (const update of data.result) {
      const msg = update.message;
      if (!msg || !msg.text) continue;

      if (msg.text === `/start ${token}` || msg.text === `/start ${token} `) {
        const chatId = msg.chat.id;
        const firstName = (msg.chat.first_name || "").trim();
        const username = (msg.chat.username || "").trim();
        const displayName = firstName || username || "";

        // Send welcome in user's app language
        const welcomeFn = WELCOME[lang] || WELCOME.de;
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: welcomeFn(displayName),
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });

        return res.status(200).json({
          ok: true,
          found: true,
          chat_id: String(chatId),
          name: displayName,
          username,
        });
      }
    }

    return res.status(200).json({ ok: true, found: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
