// Server-Sent Events: avisa os navegadores abertos que algo mudou; eles recarregam o que precisam.
// Cada navegador só ouve a própria empresa.
import { accountId } from './db.js';

const clients = new Set(); // { res, acc }

export function subscribe(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const c = { res, acc: accountId() };
  clients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(c);
  });
}

export function emit(type, data = {}) {
  let acc;
  try { acc = accountId(); } catch { return; } // aviso sem empresa definida não vai para ninguém
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const c of clients) if (c.acc === acc) c.res.write(msg);
}
