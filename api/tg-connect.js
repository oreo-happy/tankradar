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

  // Clean name: reject dots, single chars, numbers-only, whitespace-only
  const cleanName = (raw) => {
    if (!raw) return "";
    const s = raw.trim();
    if (s.length < 2) return "";
    if (/^[.\-_!?]+$/.test(s)) return "";
    if (/^\d+$/.test(s)) return "";
    return s;
  };

  const WELCOME = {
    de: (name) => name
      ? `✅ <b>TankRadar verbunden!</b>\n\nHey ${name}! Du bekommst ab jetzt Preisalarme direkt hier auf Telegram.\n\n🔔 Alarme kannst du in der App konfigurieren.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`
      : `✅ <b>TankRadar verbunden!</b>\n\nDu bekommst ab jetzt Preisalarme direkt hier auf Telegram.\n\n🔔 Alarme kannst du in der App konfigurieren.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`,
    en: (name) => name
      ? `✅ <b>TankRadar connected!</b>\n\nHey ${name}! You'll now receive price alerts right here on Telegram.\n\n🔔 Configure alerts in the app.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`
      : `✅ <b>TankRadar connected!</b>\n\nYou'll now receive price alerts right here on Telegram.\n\n🔔 Configure alerts in the app.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`,
    tr: (name) => name
      ? `✅ <b>TankRadar bağlandı!</b>\n\nMerhaba ${name}! Artık fiyat alarmlarını doğrudan Telegram'dan alacaksın.\n\n🔔 Alarmları uygulamadan ayarlayabilirsin.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`
      : `✅ <b>TankRadar bağlandı!</b>\n\nArtık fiyat alarmlarını doğrudan Telegram'dan alacaksın.\n\n🔔 Alarmları uygulamadan ayarlayabilirsin.\n⛽ <a href="https://tankradar.vercel.app">tankradar.vercel.app</a>`,
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
        const firstName = cleanName(msg.chat.first_name);
        const username = cleanName(msg.chat.username);
        const displayName = firstName || username || "";

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
          username: username,
        });
      }
    }

    return res.status(200).json({ ok: true, found: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
