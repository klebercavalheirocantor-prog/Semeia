// Apagar para todos e editar mensagem enviada pelo WhatsApp (como no celular).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-msg-'));
const { app } = await import('../server/app.js');
const db = await import('../server/db.js');
const { setWaLib } = await import('../server/waweb.js');

let server, base, cookie, wa, canal, conv;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'x-crm': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, ...a) => db.inAccount(1, () => db.one(sql, ...a));

before(async () => {
  class Client extends EventEmitter {
    constructor() { super(); wa = this; this.sent = []; this.changes = []; this.info = { wid: { user: '556793300144' } }; }
    async initialize() { setTimeout(() => this.emit('qr', 'QR'), 5); }
    async getNumberId(n) { return { _serialized: `${n}@c.us` }; }
    async sendMessage(chatId, content) { this.sent.push({ chatId, content }); return { id: { _serialized: `w${this.sent.length}` } }; }
    async deleteMessage(chatId, id) { this.changes.push({ op: 'delete', chatId, id }); }
    async editMessage(chatId, id, text) { this.changes.push({ op: 'edit', chatId, id, text }); }
    async logout() {} async destroy() {}
  }
  setWaLib({ Client, LocalAuth: class {}, MessageMedia: class {}, toDataURL: async (s) => s }, { echoDelay: 5 });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/api/setup', { name: 'Ana', email: 'ana@x.com', password: 'senha-forte-1' })).status, 200);
  canal = (await call('POST', '/api/waweb')).body.id;
  await wait(20);
  wa.emit('ready');
  await wait(10);
  conv = Number(db.inAccount(1, () => db.run("insert into conversations(channel_id, external_id, last_message_at, created_at) values(?, '5567999990001', ?, ?)", canal, Date.now(), Date.now()).lastInsertRowid));
});
after(() => server.close());

const send = async (text) => {
  const r = await call('POST', `/api/conversations/${conv}/messages`, { text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await wait(15);
  return q("select * from messages where conversation_id = ? and direction = 'out' order by id desc limit 1", conv);
};

test('editar: troca o texto no WhatsApp e no CRM, marca como editada', async () => {
  const m = await send('Valor: R$ 100');
  assert.equal((await call('PATCH', `/api/messages/${m.id}`, { text: 'Valor: R$ 120' })).status, 200);
  assert.deepEqual(wa.changes.at(-1), { op: 'edit', chatId: '5567999990001@c.us', id: m.external_id, text: 'Valor: R$ 120' });
  const d = q('select body, edited_at from messages where id = ?', m.id);
  assert.equal(d.body, 'Valor: R$ 120');
  assert.ok(d.edited_at);
  assert.equal((await call('PATCH', `/api/messages/${m.id}`, { text: '  ' })).status, 400);
});

test('editar: só até 15 minutos', async () => {
  const m = await send('oi');
  db.inAccount(1, () => db.run('update messages set created_at = ? where id = ?', Date.now() - 16 * 60e3, m.id));
  const r = await call('PATCH', `/api/messages/${m.id}`, { text: 'olá' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /15 minutos/);
});

test('apagar para todos: some no WhatsApp, fica marcada no CRM e a prévia da conversa mostra "apagada"', async () => {
  const m = await send('mandei errado');
  const n = wa.changes.length;
  assert.equal((await call('DELETE', `/api/messages/${m.id}`)).status, 200);
  assert.deepEqual(wa.changes.at(-1), { op: 'delete', chatId: '5567999990001@c.us', id: m.external_id });
  assert.ok(q('select deleted_at from messages where id = ?', m.id).deleted_at);
  assert.equal((await call('DELETE', `/api/messages/${m.id}`)).status, 400, 'não apaga duas vezes');
  assert.equal(wa.changes.length, n + 1);
  const lista = (await call('GET', '/api/conversations')).body;
  const item = (lista.items || lista).find((c) => c.id === conv);
  assert.match(JSON.stringify(item.last_msg), /Mensagem apagada/);
});

test('não mexe em mensagem do cliente nem em mensagem antiga', async () => {
  const inId = Number(db.inAccount(1, () => db.run("insert into messages(conversation_id, direction, body, external_id, created_at) values(?, 'in', 'oi', 'cli1', ?)", conv, Date.now()).lastInsertRowid));
  assert.equal((await call('DELETE', `/api/messages/${inId}`)).status, 400);
  const m = await send('antiga');
  db.inAccount(1, () => db.run('update messages set created_at = ? where id = ?', Date.now() - 3 * 864e5, m.id));
  const r = await call('DELETE', `/api/messages/${m.id}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /2 dias/);
});
