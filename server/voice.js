// Áudio gravado no Fechaê vira "mensagem de voz" do WhatsApp: precisa ser OGG com Opus.
// O navegador grava em WebM (Chrome), OGG (Firefox) ou MP4 (Safari); o ffmpeg converte. Sem ffmpeg, vai como veio.
import { spawn } from 'node:child_process';

export function toVoice(buf, mime) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
    } catch { return resolve({ buf, mime }); }
    const out = [];
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    p.on('error', () => finish({ buf, mime })); // ffmpeg não instalado
    p.stdout.on('data', (d) => out.push(d));
    p.on('close', (code) => finish(code === 0 && out.length ? { buf: Buffer.concat(out), mime: 'audio/ogg' } : { buf, mime }));
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
    setTimeout(() => { try { p.kill(); } catch {} finish({ buf, mime }); }, 60e3);
  });
}
