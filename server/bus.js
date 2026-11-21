// Server-Sent Events: avisa os navegadores abertos que algo mudou; eles recarregam o que precisam.
const clients = new Set();

export function subscribe(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(type, data = {}) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const c of clients) c.write(msg);
}
