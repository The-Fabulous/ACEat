// Public backend URL only. Never put an API key here.
// GitHub Pages uses the HTTPS tunnel. Local preview talks directly to server.py.
// Temporary Cloudflare URLs change after restarting the tunnel. No /api/chat here.
window.ACEAT_CHAT_API = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  ? ''
  : 'https://hawaii-near-statement-employ.trycloudflare.com';
