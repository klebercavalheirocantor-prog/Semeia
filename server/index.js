import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db, one, run, DATA_DIR } from './db.js';
import { hashPassword } from './auth.js';
import { app } from './app.js';
import { tickCampaigns } from './campaigns.js';
import { tickFlows, initFlows } from './flows.js';
import { bootWeb } from './waweb.js';
import { tickMailboxes } from './mailbox.js';

// Recuperar acesso: node server/index.js senha email@exemplo.com NovaSenha123
if (process.argv[2] === 'senha') {
  const [email, pw] = process.argv.slice(3);
  if (!email || !pw || pw.length < 8) { console.log('Uso: npm run senha -- email NovaSenha (mín. 8 caracteres)'); process.exit(1); }
  const r = run('update users set pass_hash = ?, is_active = 1 where email = ?', hashPassword(pw), email);
  console.log(r.changes ? `Senha de ${email} trocada.` : `Nenhum usuário com email ${email}.`);
  process.exit(0);
}

// Um erro solto em segundo plano (ex.: WhatsApp Web) fica no log em vez de derrubar o CRM inteiro.
process.on('unhandledRejection', (e) => console.error('erro em segundo plano:', e?.stack || e));
// Mesma coisa para erro solto fora de promessa (ex.: conexão de rede que cai): registra e o CRM continua no ar.
process.on('uncaughtException', (e) => {
  console.error('erro inesperado:', e?.stack || e);
  // CRM já aberto em outra janela: esta cópia sai, para não disparar campanha em dobro.
  if (e?.code === 'EADDRINUSE') { console.error('O CRM já está aberto em outra janela.'); process.exit(1); }
});

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(BACKUP_DIR, `crm-${day}.db`);
  if (fs.existsSync(file)) return;
  db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('crm-')).sort().slice(0, -14);
  for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f));
  console.log('backup salvo:', file);
}
backup();
setInterval(() => { try { backup(); } catch (e) { console.error('backup falhou', e); } }, 60 * 60e3);
setInterval(() => run('delete from sessions where expires_at < ?', Date.now()), 6 * 60 * 60e3);
// Campanhas: confere a cada 2 s se alguma tem mensagem para sair (o ritmo de cada uma é respeitado lá dentro).
setInterval(() => tickCampaigns().catch((e) => console.error('campanhas', e)), 2000);
// Fluxos: acorda quem estava esperando (follow-up, "sem resposta").
initFlows();
setInterval(() => tickFlows().catch((e) => console.error('fluxos', e)), 15000);
// Caixa de e-mail: confere as respostas a cada minuto.
setInterval(() => tickMailboxes().catch((e) => console.error('e-mail', e)), 60e3);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\nSemeia rodando em http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i?.family === 'IPv4' && !i.internal).map((i) => i.address);
    for (const ip of ips) console.log(`Na rede da empresa: http://${ip}:${PORT}`);
  } else console.log('Só este computador acessa. Para a equipe na mesma rede, use HOST=0.0.0.0 no arquivo .env');
  if (!one('select 1 from users limit 1')) console.log('Primeiro acesso: abra o endereço acima e crie o administrador.');
  bootWeb(); // reconecta o WhatsApp Web que já leu o QR code
});
