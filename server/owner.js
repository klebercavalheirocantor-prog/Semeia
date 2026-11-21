// Só um Semeia por vez cuida do WhatsApp, das campanhas e dos fluxos.
// Na atualização da nuvem o servidor novo liga ANTES do antigo desligar, e os dois enxergam a mesma pasta /data:
// abrir o WhatsApp nos dois ao mesmo tempo derrubava a conexão. O novo espera o antigo soltar a vez (ou parar de dar sinal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const FILE = path.join(DATA_DIR, 'dono.json');
const ME = `${os.hostname()}-${process.pid}-${Date.now()}`;
let mine = false;

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
const beat = () => fs.writeFileSync(FILE, JSON.stringify({ id: ME, at: Date.now() }));

export async function becomeOwner({ staleMs = 20000, maxWaitMs = 90000, stepMs = 2000, onLost = () => process.exit(0) } = {}) {
  const start = Date.now();
  let waited = false;
  for (;;) {
    const cur = read();
    if (!cur || cur.id === ME || Date.now() - cur.at > staleMs || Date.now() - start > maxWaitMs) break;
    if (!waited) { console.log('Outro Semeia ainda está ligado: espero ele terminar antes de abrir o WhatsApp...'); waited = true; }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  beat();
  mine = true;
  const timer = setInterval(() => {
    const cur = read();
    if (cur && cur.id !== ME) { clearInterval(timer); mine = false; console.error('Outro Semeia assumiu: este desliga.'); onLost(); return; }
    beat();
  }, 5000);
  timer.unref();
}

export function releaseOwner() {
  if (mine && read()?.id === ME) fs.rmSync(FILE, { force: true });
  mine = false;
}
