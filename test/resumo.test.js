// Resumo do dia no WhatsApp: números certos, hora certa no fuso da empresa e nunca duas vezes no mesmo dia.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-resumo-'));
const { app } = await import('../server/app.js');
const db = await import('../server/db.js');
const { setWaLib } = await import('../server/waweb.js');
const resumo = await import('../server/resumo.js');

let server, base, cookie, wa, canal;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'x-crm': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const in1 = (fn) => db.inAccount(1, fn);

before(async () => {
  class Client extends EventEmitter {
    constructor() { super(); wa = this; this.sent = []; this.info = { wid: { user: '556793300144' } }; }
    async initialize() { setTimeout(() => this.emit('qr', 'QR'), 5); }
    async getNumberId(n) { return { _serialized: `${n}@c.us` }; }
    async sendMessage(chatId, content) { this.sent.push({ chatId, content }); return { id: { _serialized: `x${this.sent.length}` } }; }
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
});
after(() => server.close());

test('meia-noite e hora no fuso da empresa', () => {
  const ts = Date.UTC(2026, 10, 30, 11, 30); // 30/11 07:30 em Campo Grande (UTC-4), segunda
  const l = resumo.local(ts, 'America/Campo_Grande');
  assert.equal(l.day, '2026-11-30');
  assert.equal(l.hour, 7);
  assert.equal(l.dow, 1);
  assert.equal(l.midnight, Date.UTC(2026, 10, 30, 4));
  assert.equal(resumo.local(ts, 'America/Sao_Paulo').hour, 8);
});

test('texto traz leads, vendas, IA de madrugada e quem está esperando', async () => {
  const lead = (await call('POST', '/api/leads', { name: 'Maria', price_cents: 150000, contact: { name: 'Maria', phone: '67999990001' } })).body.id;
  in1(() => {
    const won = db.one("select s.id from stages s join leads l on l.pipeline_id = s.pipeline_id where l.id = ? and s.kind = 'won'", lead).id;
    db.run('update leads set stage_id = ?, closed_at = ? where id = ?', won, Date.now(), lead);
    const contact = db.one('select contact_id c from lead_contacts where lead_id = ?', lead).c;
    const conv = Number(db.run("insert into conversations(channel_id, contact_id, external_id, last_message_at, last_inbound_at, created_at) values(?, ?, '5567999990002', ?, ?, ?)",
      canal, contact, Date.now(), Date.now(), Date.now()).lastInsertRowid);
    db.run("insert into messages(conversation_id, direction, body, bot, created_at) values(?, 'out', 'Oi!', 1, ?)", conv, Date.now() - 1000);
    db.run("insert into messages(conversation_id, direction, body, created_at) values(?, 'in', 'Quanto custa?', ?)", conv, Date.now());
  });
  const t = in1(() => resumo.texto({ ...resumo.DEFAULTS, fuso: 'America/Campo_Grande', url: 'https://crm.exemplo.com' }));
  assert.match(t, /Bom dia! Resumo de hoje/);
  assert.match(t, /1 lead novo/);
  assert.match(t, /1 venda fechada: R\$\s?1\.500,00/);
  assert.match(t, /A IA respondeu 1 conversa/);
  assert.match(t, /1 conversa com cliente esperando resposta/);
  assert.match(t, /Abrir o Fechaê: https:\/\/crm\.exemplo\.com/);
});

test('na segunda vem "o que funcionou na semana"; nos outros dias não', () => {
  const cfg = { ...resumo.DEFAULTS, fuso: 'America/Campo_Grande' };
  assert.match(in1(() => resumo.texto(cfg, Date.UTC(2026, 10, 30, 11))), /Semana passada: o que funcionou/);
  assert.doesNotMatch(in1(() => resumo.texto(cfg, Date.UTC(2026, 11, 1, 11))), /Semana passada/);
  assert.doesNotMatch(in1(() => resumo.texto({ ...cfg, semanal: false }, Date.UTC(2026, 10, 30, 11))), /Semana passada/);
});

test('ligar pela tela: primeiro automático só amanhã; "mandar um teste" manda já', async () => {
  assert.equal((await call('PUT', '/api/resumo', { ativo: true, canal_id: canal, telefone: '' })).status, 400);
  assert.equal((await call('PUT', '/api/resumo', { ativo: true, canal_id: canal, telefone: '(67) 99974-0000', hora: 7, fuso: 'America/Campo_Grande' })).status, 200);
  const r = (await call('GET', '/api/resumo')).body;
  assert.equal(r.telefone, '67999740000');
  assert.deepEqual(r.canais.map((c) => c.id), [canal]);
  assert.match(r.previa, /Bom dia/);
  const antes = wa.sent.length;
  await in1(() => resumo.tickResumo()); // hoje já conta como feito
  assert.equal(wa.sent.length, antes);
  assert.equal((await call('POST', '/api/resumo/teste')).status, 200);
  assert.equal(wa.sent.length, antes + 1);
  assert.equal(wa.sent.at(-1).chatId, '67999740000@c.us');
  assert.match(wa.sent.at(-1).content, /Bom dia! Resumo de hoje/);
});

test('rotina: manda uma vez por dia, a partir da hora, e não manda atrasado à tarde', async () => {
  const set = (x) => in1(() => db.setSetting('resumo', { ...db.getSetting('resumo', {}), ...x }));
  const dia = (h) => Date.UTC(2026, 11, 2, h + 4); // 02/12 às h em Campo Grande
  set({ ultimo: '2026-12-01' });
  const antes = wa.sent.length;
  await in1(() => resumo.tickResumo(dia(6)));
  assert.equal(wa.sent.length, antes, 'antes das 7h não manda');
  await in1(() => resumo.tickResumo(dia(7)));
  await in1(() => resumo.tickResumo(dia(8)));
  assert.equal(wa.sent.length, antes + 1, 'uma vez só no dia');
  set({ ultimo: '2026-12-01' });
  await in1(() => resumo.tickResumo(dia(15)));
  assert.equal(wa.sent.length, antes + 1, 'servidor voltou à tarde: não manda resumo atrasado');
  assert.equal(in1(() => db.getSetting('resumo', {}).ultimo), '2026-12-02');
  set({ ativo: false, ultimo: '2026-12-01' });
  await in1(() => resumo.tickResumo(dia(7)));
  assert.equal(wa.sent.length, antes + 1, 'desligado não manda');
});
