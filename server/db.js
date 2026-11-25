import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

// Cada empresa cliente tem o PRÓPRIO banco e a própria pasta (data/contas/<id>/): uma empresa nunca enxerga a outra,
// porque os dados nem moram no mesmo arquivo. O pedido (ou o trabalho de fundo) diz de qual empresa é com inAccount();
// one/all/run/tx abaixo usam sempre o banco da empresa da vez.
// A lista de empresas fica em data/plataforma.db.
export const DATA_ROOT = path.resolve(process.env.DATA_DIR || 'data');
const ACCOUNTS_DIR = path.join(DATA_ROOT, 'contas');
fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

export const platform = new DatabaseSync(path.join(DATA_ROOT, 'plataforma.db'));
platform.exec(`pragma journal_mode = wal; pragma busy_timeout = 5000;
  create table if not exists accounts (id integer primary key, name text not null, active integer not null default 1, created_at integer not null)`);

// Semeia de uma empresa só (o da AgroVox): banco e arquivos na raiz de data/ viram a empresa nº 1, do jeito que estão.
function adoptSingleCompany() {
  const dir = path.join(ACCOUNTS_DIR, '1');
  if (!fs.existsSync(path.join(DATA_ROOT, 'crm.db')) || fs.existsSync(path.join(dir, 'crm.db'))) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['crm.db', 'crm.db-wal', 'crm.db-shm', 'crm.db.restore', 'uploads', 'whatsapp-web', 'backups', 'investimento.json']) {
    if (fs.existsSync(path.join(DATA_ROOT, f))) fs.renameSync(path.join(DATA_ROOT, f), path.join(dir, f));
  }
  console.log('Dados da empresa única guardados como empresa nº 1.');
}
adoptSingleCompany();
if (!platform.prepare('select 1 from accounts limit 1').get()) {
  platform.prepare('insert into accounts(id, name, created_at) values(1, ?, ?)').run('Minha empresa', Date.now());
}

const als = new AsyncLocalStorage();
const opened = new Map(); // id -> { id, dir, db, depth }
function openAccount(id) {
  id = Number(id);
  if (opened.has(id)) return opened.get(id);
  if (!platform.prepare('select 1 from accounts where id = ?').get(id)) throw new Error(`empresa ${id} não existe`);
  const dir = path.join(ACCOUNTS_DIR, String(id));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  // Mudança de servidor: um banco trazido do outro computador (crm.db.restore) entra no lugar antes de abrir.
  const file = path.join(dir, 'crm.db');
  if (fs.existsSync(`${file}.restore`)) {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.antes-${Date.now()}`);
    for (const x of ['-wal', '-shm']) fs.rmSync(file + x, { force: true });
    fs.renameSync(`${file}.restore`, file);
    console.log(`Banco trazido do outro computador colocado no lugar (empresa ${id}).`);
  }
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  const c = { id, dir, db, depth: 0 };
  als.run(c, () => { migrate(); seed(); brandPipelines(); });
  opened.set(id, c);
  return c;
}

// Roda fn dentro da empresa id (pedido de tela, webhook, trabalho de fundo).
export const inAccount = (id, fn) => als.run(openAccount(id), fn);
// Callback que vai rodar depois (evento do WhatsApp, timer): continua na empresa de agora.
export const bound = (fn) => AsyncLocalStorage.bind(fn);
// Sem empresa definida só é aceito quando existe uma única empresa (Semeia de uma empresa só, testes).
function ctx() {
  const c = als.getStore();
  if (c) return c;
  const ids = accountIds();
  if (ids.length === 1) return openAccount(ids[0]);
  throw new Error('Operação sem empresa definida');
}
export const accountId = () => ctx().id;
export const accountDir = () => ctx().dir;
export const uploadDir = () => path.join(ctx().dir, 'uploads');
export const currentDb = () => ctx().db;
export const accountIds = () => platform.prepare('select id from accounts where active = 1 order by id').all().map((a) => a.id);
// Empresa nova: banco próprio, já com funil e configurações iniciais. Devolve o id.
export function createAccount(name) {
  name = String(name).trim();
  const id = Number(platform.prepare('insert into accounts(name, created_at) values(?, ?)').run(name, Date.now()).lastInsertRowid);
  inAccount(id, () => {
    setSetting('general', { ...getSetting('general', {}), company: name });
    run('update brands set name = ? where id = 1', name);
  });
  return id;
}
export const accountName = (id) => platform.prepare('select name from accounts where id = ?').get(id)?.name || '';
// Trabalho de fundo: roda em cada empresa, uma de cada vez. Erro numa empresa não para as outras.
export async function eachAccount(fn, label = 'trabalho de fundo') {
  for (const id of accountIds()) {
    try { await inAccount(id, fn); } catch (e) { console.error(`${label} (empresa ${id})`, e); }
  }
}

export const now = () => Date.now();
export const one = (sql, ...p) => ctx().db.prepare(sql).get(...p);
export const all = (sql, ...p) => ctx().db.prepare(sql).all(...p);
export const run = (sql, ...p) => ctx().db.prepare(sql).run(...p);

// Reentrante: chamadas aninhadas viram parte da transação de fora.
export function tx(fn) {
  const c = ctx();
  if (c.depth > 0) return fn();
  c.db.exec('begin immediate');
  c.depth++;
  try {
    const r = fn();
    c.db.exec('commit');
    return r;
  } catch (e) {
    c.db.exec('rollback');
    throw e;
  } finally {
    c.depth--;
  }
}

export function getSetting(key, fallback = null) {
  const r = one('select value from settings where key = ?', key);
  return r ? JSON.parse(r.value) : fallback;
}
export function setSetting(key, value) {
  run('insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value', key, JSON.stringify(value));
}

function migrate() {
  currentDb().exec('create table if not exists migrations (name text primary key, at integer not null)');
  const dir = path.join(import.meta.dirname, 'migrations');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (one('select 1 from migrations where name = ?', f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // "-- fk-off" na 1ª linha: a migração refaz uma tabela referenciada por outras (o SQLite pede as chaves desligadas).
    const fkOff = sql.startsWith('-- fk-off');
    if (fkOff) currentDb().exec('pragma foreign_keys = off');
    try {
      tx(() => {
        currentDb().exec(sql);
        if (fkOff && all('pragma foreign_key_check').length) throw new Error(`migração ${f} deixou referências quebradas`);
        run('insert into migrations(name, at) values(?, ?)', f, now());
      });
    } finally { if (fkOff) currentDb().exec('pragma foreign_keys = on'); }
  }
}

const ADMIN_RIGHTS = { leads: { view: 'all', edit: 'all', del: true }, contacts: { view: 'all', edit: 'all', del: true }, companies: { view: 'all', edit: 'all', del: true } };
const AGENT_RIGHTS = { leads: { view: 'own', edit: 'own', del: false }, contacts: { view: 'all', edit: 'own', del: false }, companies: { view: 'all', edit: 'own', del: false } };

export function createPipeline(name, stages) {
  const sort = (one('select max(sort) m from pipelines').m ?? -1) + 1;
  const pid = Number(run('insert into pipelines(name, sort) values(?, ?)', name, sort).lastInsertRowid);
  const list = [...stages.map((s) => ({ kind: 'normal', ...s })), { name: 'Venda fechada', color: '#9be29b', kind: 'won' }, { name: 'Perdido', color: '#e0e0e0', kind: 'lost' }];
  list.forEach((s, i) => run('insert into stages(pipeline_id, name, color, sort, kind) values(?, ?, ?, ?, ?)', pid, s.name, s.color || '#99ccff', i, s.kind));
  return pid;
}

function seed() {
  if (one('select 1 from roles limit 1')) return;
  tx(() => {
    run('insert into roles(name, rights) values(?, ?)', 'Gerente', JSON.stringify(ADMIN_RIGHTS));
    run('insert into roles(name, rights) values(?, ?)', 'Atendente', JSON.stringify(AGENT_RIGHTS));
    createPipeline('Funil de vendas', [
      { name: 'Novas conversas', color: '#c1c1c1', kind: 'incoming' },
      { name: 'Primeiro contato', color: '#99ccff' },
      { name: 'Qualificado', color: '#ffdc7f' },
      { name: 'Proposta enviada', color: '#ffc8c8' },
      { name: 'Negociação', color: '#d6c1ff' },
    ]);
    for (const [n, c] of [['Retornar', '#6b8afd'], ['Reunião', '#2fb67c'], ['Ligar', '#f5a623']]) run('insert into task_types(name, color) values(?, ?)', n, c);
    ['Preço', 'Sem resposta', 'Fechou com outro', 'Sem orçamento', 'Fora do perfil'].forEach((n, i) => run('insert into loss_reasons(name, sort) values(?, ?)', n, i));
    setSetting('general', { company: 'Minha empresa', timezone: 'America/Sao_Paulo', currency: 'BRL', public_url: '' });
    setSetting('meta', { graph_version: 'v23.0', app_secret: '', verify_token: cryptoRandom() });
  });
}

function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
}


// Toda marca precisa de um funil para os leads dela.
export function createBrandPipeline(id, name) {
  return tx(() => {
    const pid = createPipeline(`Funil ${name}`, [
      { name: 'Novas conversas', color: '#c1c1c1', kind: 'incoming' },
      { name: 'Primeiro contato', color: '#99ccff' },
      { name: 'Proposta enviada', color: '#ffc8c8' },
      { name: 'Negociação', color: '#d6c1ff' },
    ]);
    run('update pipelines set brand_id = ? where id = ?', id, pid);
    return pid;
  });
}
function brandPipelines() {
  for (const b of all('select * from brands where not exists (select 1 from pipelines p where p.brand_id = brands.id)')) createBrandPipeline(b.id, b.name);
}
