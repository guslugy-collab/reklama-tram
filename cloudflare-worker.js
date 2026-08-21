// Cloudflare Worker: счётчик заказов кафе ТРАМ + уведомления в Telegram
//
// Что делает:
//  - POST /track  — сайт сообщает о клике "заказать в WhatsApp" / "забронировать".
//                    Worker шлёт уведомление в Telegram и увеличивает счётчик в KV.
//  - POST /telegram-webhook — Telegram присылает сюда сообщения боту.
//                    На команду /stats бот отвечает текущей статистикой.
//
// Нужные настройки в Cloudflare (Settings → Variables):
//   TELEGRAM_BOT_TOKEN  — токен бота от @BotFather (Secret)
//   TELEGRAM_CHAT_ID    — id чата/канала, куда слать уведомления (Secret)
// Нужный биндинг (Settings → Bindings → KV Namespace):
//   STATS — любое созданное KV-хранилище

const ALLOWED_ORIGINS = [
  'https://cafe-tram.ru',
  'https://www.cafe-tram.ru',
];

const LABELS = {
  whatsapp_order: 'Заказ через WhatsApp (меню)',
  whatsapp_reservation: 'Бронь через WhatsApp',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === '/track' && request.method === 'POST') {
      return handleTrack(request, env, ctx, cors);
    }

    if (url.pathname === '/telegram-webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }

    return new Response('ok');
  },
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function handleTrack(request, env, ctx, cors) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return new Response('bad json', { status: 400, headers: cors });
  }

  const type = String(data.type || 'unknown').slice(0, 50);
  const page = String(data.page || '').slice(0, 200);
  const today = new Date().toISOString().slice(0, 10);

  const dayKey = `count:${type}:${today}`;
  const totalKey = `total:${type}`;
  const [dayVal, totalVal] = await Promise.all([
    env.STATS.get(dayKey),
    env.STATS.get(totalKey),
  ]);
  await Promise.all([
    env.STATS.put(dayKey, String(parseInt(dayVal || '0', 10) + 1)),
    env.STATS.put(totalKey, String(parseInt(totalVal || '0', 10) + 1)),
  ]);

  const label = LABELS[type] || type;
  const text = `🔔 ${label}\nСтраница: ${page}\nВремя: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
  ctx.waitUntil(sendTelegram(env, env.TELEGRAM_CHAT_ID, text));

  return new Response('ok', { headers: cors });
}

async function sendTelegram(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function handleTelegramWebhook(request, env) {
  const update = await request.json();
  const msg = update.message;
  if (!msg || !msg.text) return new Response('ok');

  if (msg.text.trim() === '/stats') {
    const today = new Date().toISOString().slice(0, 10);
    const keys = Object.keys(LABELS);
    const values = await Promise.all(
      keys.flatMap((k) => [env.STATS.get(`total:${k}`), env.STATS.get(`count:${k}:${today}`)])
    );

    let text = `📊 Статистика cafe-tram.ru\n`;
    keys.forEach((k, i) => {
      const total = values[i * 2] || 0;
      const day = values[i * 2 + 1] || 0;
      text += `\n${LABELS[k]}:\n  всего: ${total}\n  сегодня: ${day}`;
    });

    await sendTelegram(env, msg.chat.id, text);
  }

  return new Response('ok');
}
