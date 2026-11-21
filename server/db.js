import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Mudança de servidor: um banco trazido do outro computador (crm.db.restore) entra no lugar antes de abrir.
const DB_FILE = path.join(DATA_DIR, 'crm.db');
if (fs.existsSync(`${DB_FILE}.restore`)) {
  if (fs.existsSync(DB_FILE)) fs.renameSync(DB_FILE, `${DB_FILE}.antes-${Date.now()}`);
  for (const x of ['-wal', '-shm']) fs.rmSync(DB_FILE + x, { force: true });
  fs.renameSync(`${DB_FILE}.restore`, DB_FILE);
  console.log('Banco trazido do outro computador colocado no lugar.');
}

export const db = new DatabaseSync(DB_FILE);
db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');

export const now = () => Date.now();
export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

let depth = 0;
// Reentrante: chamadas aninhadas viram parte da transação de fora.
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('begin immediate');
  depth++;
  try {
    const r = fn();
    db.exec('commit');
    return r;
  } catch (e) {
    db.exec('rollback');
    throw e;
  } finally {
    depth--;
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
  db.exec('create table if not exists migrations (name text primary key, at integer not null)');
  const dir = path.join(import.meta.dirname, 'migrations');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (one('select 1 from migrations where name = ?', f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // "-- fk-off" na 1ª linha: a migração refaz uma tabela referenciada por outras (o SQLite pede as chaves desligadas).
    const fkOff = sql.startsWith('-- fk-off');
    if (fkOff) db.exec('pragma foreign_keys = off');
    try {
      tx(() => {
        db.exec(sql);
        if (fkOff && all('pragma foreign_key_check').length) throw new Error(`migração ${f} deixou referências quebradas`);
        run('insert into migrations(name, at) values(?, ?)', f, now());
      });
    } finally { if (fkOff) db.exec('pragma foreign_keys = on'); }
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

migrate();
seed();

// Toda empresa (AgroVox, AgroPool...) precisa de um funil para os leads dela.
function brandPipelines() {
  for (const b of all('select * from brands where not exists (select 1 from pipelines p where p.brand_id = brands.id)')) {
    tx(() => {
      const pid = createPipeline(`Funil ${b.name}`, [
        { name: 'Novas conversas', color: '#c1c1c1', kind: 'incoming' },
        { name: 'Primeiro contato', color: '#99ccff' },
        { name: 'Proposta enviada', color: '#ffc8c8' },
        { name: 'Negociação', color: '#d6c1ff' },
      ]);
      run('update pipelines set brand_id = ? where id = ?', b.id, pid);
    });
  }
}
brandPipelines();
