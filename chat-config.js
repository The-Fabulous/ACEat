// Public backend URL only. Never put an API key here.
// Vercel and local preview use their own /api endpoints.
// The legacy Pages copy keeps its separately configured backend URL.
window.ACEAT_CHAT_API = location.hostname.endsWith('.github.io')
  ? 'https://hawaii-near-statement-employ.trycloudflare.com'
  : '';
