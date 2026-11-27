import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { one, run, currentDb, accountDir, inAccount, eachAccount, accountIds, createAccount } from './db.js';
import { hashPassword } from './auth.js';
import { app, accountOfEmail } from './app.js';
import { tickCampaigns } from './campaigns.js';
import { tickFlows, initFlows } from './flows.js';
import { bootWeb, stopAllWeb } from './waweb.js';
import { tickMailboxes } from './mailbox.js';
import { tickCapi } from './capi.js';
import { tickResumo } from './resumo.js';
import { becomeOwner, releaseOwner } from './owner.js';

// Recuperar acesso: node server/index.js senha email@exemplo.com NovaSenha123
if (process.argv[2] === 'senha') {
  const [email, pw] = process.argv.slice(3);
  if (!email || !pw || pw.length < 8) { console.log('Uso: npm run senha -- email NovaSenha (mín. 8 caracteres)'); process.exit(1); }
  const acc = accountOfEmail(email);
  const r = acc ? inAccount(acc, () => run('update users set pass_hash = ?, is_active = 1 where email = ?', hashPassword(pw), email)) : { changes: 0 };
  console.log(r.changes ? `Senha de ${email} trocada (empresa ${acc}).` : `Nenhum usuário com email ${email}.`);
  process.exit(0);
}

// Empresa cliente nova (piloto, criada por nós): node server/index.js nova-empresa "Nome da Empresa" "Nome do Admin" email senha
if (process.argv[2] === 'nova-empresa') {
  const [name, admin, email, pw] = process.argv.slice(3);
  if (!name || !admin || !email || !pw || pw.length < 8) { console.log('Uso: node server/index.js nova-empresa "Empresa" "Nome do admin" email senha (mín. 8)'); process.exit(1); }
  if (accountOfEmail(email)) { console.log(`O email ${email} já está em uma empresa.`); process.exit(1); }
  const acc = createAccount(name);
  inAccount(acc, () => {
    run("insert into users(name, email, pass_hash, role_id, is_admin, created_at) values(?, ?, ?, (select id from roles where name = 'Gerente'), 1, ?)", admin, email, hashPassword(pw), Date.now());
  });
  console.log(`Empresa ${acc} criada: ${name}. Login: ${email}`);
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

// Pedido para desligar (reinício do servidor, Ctrl+C, fechar a janela no Windows): fecha o WhatsApp com calma antes de sair.
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, async () => {
  if (closing) return;
  closing = true;
  console.log('Desligando: fechando o WhatsApp com calma...');
  setTimeout(() => process.exit(0), 12000).unref();
  await stopAllWeb().catch(() => {});
  // Garante que o login do WhatsApp chegou ao disco antes de o servidor sumir (na nuvem o disco é desligado logo depois).
  if (process.platform !== 'win32') { try { execSync('sync', { timeout: 5000 }); } catch {} }
  releaseOwner(); // o servidor novo (se houver) já pode abrir o WhatsApp
  console.log('WhatsApp fechado, sessão gravada.');
  process.exit(0);
});

// Cópia diária do banco de cada empresa (guarda as últimas 14), na pasta da própria empresa.
function backup() {
  const dir = path.join(accountDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `crm-${day}.db`);
  if (fs.existsSync(file)) return;
  currentDb().exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('crm-')).sort().slice(0, -14);
  for (const f of old) fs.rmSync(path.join(dir, f));
  console.log('backup salvo:', file);
}
// Trabalho de fundo (WhatsApp, campanhas, fluxos, e-mail, backup): só depois de ser o único Semeia ligado nesta pasta.
// Cada tarefa roda em todas as empresas, uma de cada vez.
function startJobs() {
  eachAccount(backup, 'backup');
  setInterval(() => eachAccount(backup, 'backup'), 60 * 60e3);
  setInterval(() => eachAccount(() => run('delete from sessions where expires_at < ?', Date.now()), 'sessões'), 6 * 60 * 60e3);
  // Campanhas: confere a cada 2 s se alguma tem mensagem para sair (o ritmo de cada uma é respeitado lá dentro).
  setInterval(() => eachAccount(tickCampaigns, 'campanhas'), 2000);
  // Fluxos: acorda quem estava esperando (follow-up, "sem resposta").
  eachAccount(initFlows, 'fluxos');
  setInterval(() => eachAccount(tickFlows, 'fluxos'), 15000);
  // Caixa de e-mail: confere as respostas a cada minuto.
  setInterval(() => eachAccount(tickMailboxes, 'e-mail'), 60e3);
  // Resumo do dia no WhatsApp do dono, na hora escolhida.
  setInterval(() => eachAccount(tickResumo, 'resumo do dia'), 60e3);
  // Vendas fechadas vão para o Facebook (API de Conversões) a cada 15 min, nas empresas que configuraram.
  setTimeout(() => eachAccount(tickCapi, 'vendas para o Facebook'), 60e3);
  setInterval(() => eachAccount(tickCapi, 'vendas para o Facebook'), 15 * 60e3);
  eachAccount(bootWeb, 'whatsapp web'); // reconecta o WhatsApp Web que já leu o QR code
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\nSemeia rodando em http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i?.family === 'IPv4' && !i.internal).map((i) => i.address);
    for (const ip of ips) console.log(`Na rede da empresa: http://${ip}:${PORT}`);
  } else console.log('Só este computador acessa. Para a equipe na mesma rede, use HOST=0.0.0.0 no arquivo .env');
  if (!inAccount(1, () => one('select 1 from users limit 1'))) console.log('Primeiro acesso: abra o endereço acima e crie o administrador.');
  console.log(`Empresas neste servidor: ${accountIds().length}`);
  becomeOwner().then(startJobs).catch((e) => console.error('não consegui assumir o trabalho de fundo', e));
});
