import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.AI_REPLY_DELAY = '0'; // nos testes a IA responde sem a pausa de "digitando..."
const { app } = await import('../server/app.js');
const { normPhone } = await import('../server/crm.js');
const { setSetting, getSetting, one, run, all } = await import('../server/db.js');

// Finge a Graph API da Meta; o resto passa direto.
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://graph.facebook.com/')) {
    sent.push({ url: String(url), body: init?.body });
    if (String(url).endsWith('/messages')) {
      const to = JSON.parse(init.body).to;
      // a Meta devolve celular brasileiro sem o 9, como acontece de verdade
      const wa = to.length === 13 ? to.slice(0, 4) + to.slice(5) : to;
      return new Response(JSON.stringify({ contacts: [{ input: to, wa_id: wa }], messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
    }
    if (String(url).endsWith('/media')) return new Response(JSON.stringify({ id: `MEDIA${sent.length}` }), { status: 200 });
    if (String(url).includes('/message_templates')) return new Response(JSON.stringify({ data: [
      { id: 'T1', name: 'retomar', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá {{1}}, ainda tem interesse?' }] },
      { id: 'T2', name: 'promo_foto', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Oferta' }] }] }), { status: 200 });
    return new Response(JSON.stringify({ display_phone_number: '+55 11 0000-0000' }), { status: 200 });
  }
  return realFetch(url, init);
};

let server, base;
const jar = {};
async function call(who, method, p, body, extra = {}) {
  const r = await realFetch(base + p, { method, headers: { 'x-crm': '1', ...(jar[who] ? { cookie: jar[who] } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie');
  if (c) jar[who] = c.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const APP_SECRET = 'segredo-de-teste';
function webhook(payload, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return realFetch(base + '/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
}
const waMsg = (id, from, text, name = 'Maria Cliente') => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: from, profile: { name } }],
  messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const settle = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('telefone brasileiro normaliza com DDI e o 9', () => {
  assert.equal(normPhone('(11) 98765-4321'), '5511987654321');
  assert.equal(normPhone('551187654321'), '5511987654321'); // formato antigo que o WhatsApp manda
  assert.equal(normPhone('+55 11 3456-7890'), '551134567890'); // fixo não ganha 9
});

test('primeiro acesso cria admin e não deixa repetir', async () => {
  const remoto = await call('x', 'POST', '/api/setup', { name: 'Hacker', email: 'h@x.com', password: '12345678' }, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(remoto.status, 403); // pelo túnel ninguém cria o admin
  assert.equal((await call('admin', 'POST', '/api/setup', { name: 'Ana', email: 'ana@x.com', password: '12345678' })).status, 200);
  assert.equal((await call('outro', 'POST', '/api/setup', { name: 'B', email: 'b@x.com', password: '12345678' })).status, 409);
  assert.equal((await call('admin', 'GET', '/api/me')).body.user.is_admin, true);
});

test('sem cabeçalho x-crm a escrita é recusada (CSRF)', async () => {
  const r = await realFetch(base + '/api/leads', { method: 'POST', headers: { cookie: jar.admin, 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(r.status, 403);
});

test('lead manual com contato; telefone repetido em outro contato é barrado', async () => {
  const r = await call('admin', 'POST', '/api/leads', { name: 'Cozinha', price_cents: 150000, contact: { name: 'João', phone: '11 91234-5678' } });
  assert.equal(r.status, 200);
  const l = (await call('admin', 'GET', `/api/leads/${r.body.id}`)).body;
  assert.equal(l.contacts[0].phones[0], '11 91234-5678');
  const dup = await call('admin', 'POST', '/api/contacts', { name: 'Outro', phones: ['+55 (11) 91234-5678'] });
  assert.equal(dup.status, 409);
});

test('perdido exige motivo; ganho fecha o lead', async () => {
  const me = (await call('admin', 'GET', '/api/me')).body;
  const st = me.pipelines[0].stages;
  const id = (await call('admin', 'POST', '/api/leads', { name: 'Teste etapa' })).body.id;
  const lost = st.find((s) => s.kind === 'lost');
  assert.equal((await call('admin', 'PATCH', `/api/leads/${id}`, { stage_id: lost.id })).status, 400);
  assert.equal((await call('admin', 'PATCH', `/api/leads/${id}`, { stage_id: lost.id, loss_reason_id: me.loss_reasons[0].id })).status, 200);
  const won = st.find((s) => s.kind === 'won');
  await call('admin', 'PATCH', `/api/leads/${id}`, { stage_id: won.id });
  const l = (await call('admin', 'GET', `/api/leads/${id}`)).body;
  assert.ok(l.closed_at);
  assert.equal(l.loss_reason_id, null);
  assert.ok(l.feed.some((e) => e.t === 'event' && e.type === 'stage_changed'));
});

test('mudar campo personalizado entra no histórico; valor igual não', async () => {
  await call('admin', 'POST', '/api/fields', { entity: 'lead', name: 'Origem', type: 'select', options: ['Site', 'Indicação'] });
  const fid = (await call('admin', 'GET', '/api/me')).body.fields.find((f) => f.name === 'Origem').id;
  const id = (await call('admin', 'POST', '/api/leads', { name: 'Campo' })).body.id;
  await call('admin', 'PATCH', `/api/leads/${id}`, { fields: { [fid]: 'Site' } });
  await call('admin', 'PATCH', `/api/leads/${id}`, { fields: { [fid]: 'Site' } });
  const evs = (await call('admin', 'GET', `/api/leads/${id}`)).body.feed.filter((e) => e.type === 'field_changed');
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].data, { name: 'Origem', from: null, to: 'Site' });
});

test('webhook sem assinatura válida é recusado', async () => {
  setSetting('meta', { ...getSetting('meta'), app_secret: APP_SECRET });
  run("insert into channels(kind, name, external_id, config, created_at) values('whatsapp', 'WA', 'PN1', ?, ?)", JSON.stringify({ token: 't' }), Date.now());
  assert.equal((await webhook(waMsg('wamid.x', '5511900000000', 'oi'), 'errado')).status, 403);
  assert.equal(one('select count(*) n from messages').n, 0);
});

test('mensagem nova vira contato + lead em "novas conversas"; repetição não duplica', async () => {
  assert.equal((await webhook(waMsg('wamid.1', '551199998888', 'Oi, quero orçamento'))).status, 200);
  await webhook(waMsg('wamid.1', '551199998888', 'Oi, quero orçamento')); // Meta reenviou
  await webhook(waMsg('wamid.2', '551199998888', 'Pode ser amanhã?'));
  await settle();
  assert.equal(one("select count(*) n from messages where external_id like 'wamid.%'").n, 2);
  assert.equal(one('select count(*) n from conversations').n, 1);
  const c = one("select c.* from contact_points p join contacts c on c.id = p.contact_id where p.value_norm = '5511999998888'");
  assert.equal(c.name, 'Maria Cliente');
  const lead = one('select l.*, s.kind from leads l join stages s on s.id = l.stage_id join lead_contacts lc on lc.lead_id = l.id where lc.contact_id = ?', c.id);
  assert.equal(lead.kind, 'incoming');
  assert.equal(one('select unread from conversations').unread, 2);
});

test('cliente já cadastrado escreve: usa o contato e o lead abertos dele', async () => {
  const before = one('select count(*) n from leads').n;
  await webhook(waMsg('wamid.3', '5511912345678', 'Sou o João', 'João WA'));
  await settle();
  assert.equal(one('select count(*) n from leads').n, before);
  const conv = one("select * from conversations where external_id = '5511912345678'");
  assert.equal(one('select name from leads where id = ?', conv.lead_id).name, 'Cozinha');
});

test('responder envia pela Cloud API, assume o lead e o status só avança', async () => {
  const conv = one("select * from conversations where external_id = '551199998888'");
  const r = await call('admin', 'POST', `/api/conversations/${conv.id}/messages`, { text: 'Olá Maria!' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'sent');
  const req = sent.find((s) => s.url.endsWith('/PN1/messages'));
  assert.equal(JSON.parse(req.body).to, '551199998888');
  assert.equal(one('select responsible_id from leads where id = ?', conv.lead_id).responsible_id, 1);
  const st = (status) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: r.body.external_id, status }] } }] }] });
  await webhook(st('read'));
  await webhook(st('delivered')); // chegou atrasado
  await settle();
  assert.equal(one('select status from messages where id = ?', r.body.id).status, 'read');
});

test('aceitar conversa nova move o lead para a primeira etapa', async () => {
  const conv = one("select * from conversations where external_id = '551199998888'");
  assert.equal((await call('admin', 'POST', `/api/conversations/${conv.id}/accept`)).status, 200);
  assert.equal(one('select s.kind from leads l join stages s on s.id = l.stage_id where l.id = ?', conv.lead_id).kind, 'normal');
  assert.equal((await call('admin', 'POST', `/api/conversations/${conv.id}/accept`)).status, 409);
});

test('atendente só vê os próprios leads e não mexe em configurações', async () => {
  const me = (await call('admin', 'GET', '/api/me')).body;
  const role = me.roles.find((r) => r.name === 'Atendente');
  await call('admin', 'POST', '/api/users', { name: 'Beto', email: 'beto@x.com', password: '12345678', role_id: role.id });
  assert.equal((await call('beto', 'POST', '/api/login', { email: 'beto@x.com', password: '12345678' })).status, 200);
  const mine = (await call('beto', 'POST', '/api/leads', { name: 'Lead do Beto' })).body.id;
  const list = (await call('beto', 'GET', '/api/leads')).body;
  assert.deepEqual(list.map((l) => l.id), [mine]);
  const other = one("select id from leads where name = 'Cozinha'").id;
  assert.equal((await call('beto', 'GET', `/api/leads/${other}`)).status, 403);
  assert.equal((await call('beto', 'POST', '/api/pipelines', { name: 'x' })).status, 403);
});

test('desativar usuário passa os leads e derruba a sessão', async () => {
  const beto = one("select id from users where email = 'beto@x.com'").id;
  await call('admin', 'PATCH', `/api/users/${beto}`, { is_active: false, reassign_to: 1 });
  assert.equal(one("select responsible_id from leads where name = 'Lead do Beto'").responsible_id, 1);
  assert.equal((await call('beto', 'GET', '/api/me')).status, 401);
});

test('login errado 10 vezes bloqueia', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call('x', 'POST', '/api/login', { email: 'ana@x.com', password: 'errada' });
  assert.equal(last.status, 429);
});

const { parseVcf, parseCsv } = await import('../server/importer.js');

test('lê vCard do Android com acento codificado e várias linhas', () => {
  const vcf = `BEGIN:VCARD
VERSION:2.1
N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Concei=C3=A7=C3=A3o;Jo=C3=A3o;;;
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jo=C3=A3o Concei=C3=A7=
=C3=A3o
TEL;CELL:+55 11 98888-7777
TEL;HOME:11 3333-4444
item1.EMAIL;TYPE=INTERNET:joao@ex.com
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Silva;Ana;;;
TEL;TYPE=CELL:21999990000
ORG:Padaria Boa;
END:VCARD
`
  const r = parseVcf(vcf);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'João Conceição');
  assert.deepEqual(r[0].phones, ['+55 11 98888-7777', '11 3333-4444']);
  assert.deepEqual(r[0].emails, ['joao@ex.com']);
  assert.equal(r[1].name, 'Ana Silva');
  assert.equal(r[1].org, 'Padaria Boa');
});

test('lê CSV do Google Contatos e do Excel brasileiro (ponto e vírgula)', () => {
  const g = `First Name,Middle Name,Last Name,Organization Name,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value
"Carla","","Dias","Loja X",* Home,carla@ex.com,Mobile,"+55 31 97777-6666 ::: 31 3222-1111"
`
  const r = parseCsv(g);
  assert.deepEqual(r[0], { name: 'Carla Dias', phones: ['+55 31 97777-6666', '31 3222-1111'], emails: ['carla@ex.com'], org: 'Loja X' });
  const x = `﻿Nome;Telefone;E-mail
Pedro Alves;(41) 99876-5432;pedro@ex.com
`
  assert.deepEqual(parseCsv(x)[0], { name: 'Pedro Alves', phones: ['(41) 99876-5432'], emails: ['pedro@ex.com'], org: '' });
});

test('importar contatos não duplica e completa quem já existe', async () => {
  const csv = `nome,telefone,email
João Repetido,11 91234-5678,joao.novo@ex.com
Nova Pessoa,48 99111-2222,
Só Nome,,
,,
`
  const r = await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'lista.csv', 'content-type': 'application/octet-stream' }, body: csv });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual({ created: b.created, updated: b.updated, skipped: b.skipped }, { created: 2, updated: 1, skipped: 0 }); // linha vazia nem conta; "Só Nome" vira contato
  const joao = one("select c.id from contact_points p join contacts c on c.id = p.contact_id where p.value_norm = '5511912345678'");
  assert.ok(one("select 1 from contact_points where contact_id = ? and value_norm = 'joao.novo@ex.com'", joao.id));
});

test('importar planilha com etiquetas: cria com etiqueta e acrescenta etiqueta em quem já existe', async () => {
  const csv = `nome,telefone,email,tags
Produtor Tag,67 99876-5432,,Produtor MS
Produtor Tag De Novo,+5567998765432,,Pecuária MS; Agro
`;
  const r = await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'tags.csv', 'content-type': 'application/octet-stream' }, body: csv });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual({ created: b.created, updated: b.updated }, { created: 1, updated: 1 });
  const c = one("select c.id, c.name from contact_points p join contacts c on c.id = p.contact_id where p.value_norm = '5567998765432'");
  assert.equal(c.name, 'Produtor Tag');
  const tags = all('select t.name from entity_tags e join tags t on t.id = e.tag_id where e.entity = ? and e.entity_id = ? order by t.name', 'contact', c.id).map((x) => x.name);
  assert.deepEqual(tags, ['Agro', 'Pecuária MS', 'Produtor MS']);
});

test('tarefa de contato apagado some da lista de tarefas', async () => {
  const c = (await call('admin', 'POST', '/api/contacts', { name: 'Some Depois', phones: ['11 95555-1212'] })).body.id;
  const k = (await call('admin', 'POST', '/api/tasks', { entity: 'contact', entity_id: c, text: 'ligar', due_at: Date.now() + 3600e3 })).body;
  assert.ok((await call('admin', 'GET', '/api/tasks')).body.some((x) => x.entity_id === c && x.entity === 'contact'));
  assert.equal((await call('admin', 'DELETE', `/api/contacts/${c}`)).status, 200);
  assert.ok(!(await call('admin', 'GET', '/api/tasks')).body.some((x) => x.entity_id === c && x.entity === 'contact'), JSON.stringify(k));
});

test('modelo: sincroniza, envia a quem nunca escreveu e a resposta cai na mesma conversa', async () => {
  run("update channels set config = json_set(config, '$.waba_id', 'WABA1') where external_id = 'PN1'");
  assert.equal((await call('admin', 'POST', '/api/templates/sync')).body.count, 2);
  const tpls = (await call('admin', 'GET', '/api/templates')).body;
  const t1 = tpls.find((t) => t.name === 'retomar');
  assert.equal(tpls.find((t) => t.name === 'promo_foto').supported, false);
  const pessoa = one("select c.id from contact_points p join contacts c on c.id = p.contact_id where p.value_norm = '5548991112222'");
  const r = await call('admin', 'POST', '/api/whatsapp/template', { template_id: t1.id, contact_id: pessoa.id, params: ['Nova'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'sent');
  assert.equal(r.body.body, 'Olá Nova, ainda tem interesse?');
  const sentBody = JSON.parse(sent.at(-1).body);
  assert.equal(sentBody.type, 'template');
  assert.deepEqual(sentBody.template.components[0].parameters, [{ type: 'text', text: 'Nova' }]);
  const conv = one('select * from conversations where id = ?', r.body.conversation_id);
  assert.equal(conv.external_id, '554891112222'); // formato que a Meta devolveu
  assert.ok(conv.lead_id);
  await webhook(waMsg('wamid.resp1', '554891112222', 'Tenho sim!', 'Nova'));
  await settle();
  assert.equal(one('select conversation_id from messages where external_id = ?', 'wamid.resp1').conversation_id, conv.id);
  const bad = await call('admin', 'POST', '/api/whatsapp/template', { template_id: tpls.find((t) => t.name === 'promo_foto').id, contact_id: pessoa.id });
  assert.equal(bad.status, 400);
});

// ---------- campanhas, painel e contatos com etiqueta
const { stepCampaign } = await import('../server/campaigns.js');
const { firstName, fillVars } = await import('../server/outbound.js');

test('primeiro nome: tira Agro/Atualize e não chama empresa pelo nome', () => {
  assert.equal(firstName('Agro Eduardo Tomonaga'), 'Eduardo');
  assert.equal(firstName('MARIA DA SILVA'), 'Maria');
  assert.equal(firstName('Agropecuaria Florida LTDA'), '');
  assert.equal(fillVars('Olá {{primeiro_nome}}, tudo bem?', { name: 'Zoopec Solucoes LTDA' }), 'Olá, tudo bem?');
});

test('contatos: filtro por etiqueta com total', async () => {
  const csv = `nome,telefone,email,tags
Ana Campanha,67 99999-0001,,Campanha X
Beto Campanha,67 99999-0002,,Campanha X
Caio Email,,caio@ex.com,Campanha X
`;
  await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'c.csv' }, body: csv });
  const r = (await call('admin', 'GET', '/api/contacts?tag=Campanha%20X&with_total=1&limit=2')).body;
  assert.equal(r.total, 3);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0].tags, ['Campanha X']);
});

test('campanha WhatsApp: público por etiqueta, ritmo, resposta vira lead e SAIR tira da lista', async () => {
  const t1 = (await call('admin', 'GET', '/api/templates')).body.find((t) => t.name === 'retomar');
  const body = { name: 'Promo sinal', channel: 'whatsapp', tags: ['Campanha X'], template_id: t1.id, params: ['{{primeiro_nome}}'], interval_seconds: 30, window_start: 0, window_end: 24 };
  assert.equal((await call('admin', 'POST', '/api/campaigns/audience', body)).body.count, 2); // Caio não tem celular
  const id = (await call('admin', 'POST', '/api/campaigns', body)).body.id;
  const st = await call('admin', 'POST', `/api/campaigns/${id}/start`);
  assert.equal(st.body.stats.queued, 2);
  const camp = () => one('select * from campaigns where id = ?', id);
  const t0 = Date.now();
  assert.equal(await stepCampaign(camp(), t0), 'sent');
  assert.equal(JSON.parse(sent.at(-1).body).template.components[0].parameters[0].text, 'Ana');
  assert.equal(await stepCampaign(camp(), t0 + 1000), 'wait'); // respeita o intervalo
  assert.equal(await stepCampaign(camp(), t0 + 40e3), 'sent');
  const ana = one("select c.id from contact_points p join contacts c on c.id = p.contact_id where p.value_norm = '5567999990001'").id;
  const conv = one('select * from conversations where contact_id = ?', ana);
  assert.equal(conv.lead_id, null); // campanha não enche o funil: o lead nasce na resposta
  await webhook(waMsg('wamid.camp1', conv.external_id, 'Quero saber o preço', 'Ana'));
  await settle();
  assert.ok(one('select lead_id from conversations where id = ?', conv.id).lead_id);
  await webhook(waMsg('wamid.camp2', '556799990002', 'SAIR', 'Beto'));
  await settle();
  const s = (await call('admin', 'GET', `/api/campaigns/${id}`)).body.stats;
  assert.deepEqual({ sent: s.sent, replied: s.replied, optout: s.optout }, { sent: 2, replied: 1, optout: 1 });
  assert.equal(await stepCampaign(camp(), t0 + 90e3), 'done');
  // quem pediu para sair não entra na próxima campanha
  assert.equal((await call('admin', 'POST', '/api/campaigns/audience', { ...body, skip_recent_days: 0 })).body.count, 1);
  const d = (await call('admin', 'GET', '/api/dashboard?days=30')).body;
  assert.equal(d.campaign_totals.sent, 2);
  assert.equal(d.campaign_totals.replied, 1);
  assert.equal(d.series.length, 30);
  assert.ok(d.tags.some((t) => t.name === 'Campanha X' && t.n === 3));
});

test('campanha por e-mail vai pela Resend com link de sair; o link tira da lista', async () => {
  const resend = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) { resend.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }
    return prev(url, init);
  };
  try {
    await call('admin', 'PATCH', '/api/settings', { general: { public_url: 'https://crm.exemplo.com' }, email: { api_key: 're_test', from: 'Loja <oi@exemplo.com>' } });
    assert.equal((await call('admin', 'GET', '/api/me')).body.email.has_key, true);
    const id = (await call('admin', 'POST', '/api/campaigns', { name: 'Email X', channel: 'email', tags: ['Campanha X'], subject: 'Oi {{primeiro_nome}}', body: 'Olá {{primeiro_nome}}, temos novidade.', window_start: 0, window_end: 24 })).body.id;
    await call('admin', 'POST', `/api/campaigns/${id}/start`);
    assert.equal(await stepCampaign(one('select * from campaigns where id = ?', id), Date.now()), 'sent');
    assert.equal(resend[0].subject, 'Oi Caio');
    assert.ok(!resend[0].attachments); // sem arte, sem anexo
    const link = resend[0].html.match(/https:\/\/crm\.exemplo\.com\/sair\/([\w.]+)/);
    assert.ok(link);
    assert.equal(resend[0].headers['List-Unsubscribe'], `<https://crm.exemplo.com/sair/${link[1]}>, <mailto:oi@exemplo.com?subject=SAIR>`);
    assert.equal(resend[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.equal((await realFetch(`${base}/sair/${link[1]}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 200);
    const page = await realFetch(`${base}/sair/${link[1]}`);
    assert.equal(page.status, 200);
    assert.ok(one("select o.at from contact_optouts o join contact_points p on p.contact_id = o.contact_id where p.value_norm = 'caio@ex.com' and o.brand_id = 1"));
    assert.equal((await realFetch(`${base}/sair/1.forjado`)).status, 200); // link falso não quebra nem tira ninguém
  } finally { globalThis.fetch = prev; }
});

// ---------- campanha com imagem e fluxos automáticos (robô)
const { idle, tickFlows } = await import('../server/flows.js');
const anthropic = [];
let aiAnswers = [];
{
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.anthropic.com/v1/messages') {
      anthropic.push({ headers: init.headers, body: JSON.parse(init.body) });
      const text = aiAnswers.shift() ?? '{"resposta":"Um especialista já vai te atender.","handoff":true,"motivo":"sem resposta preparada"}';
      return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
    }
    return prev(url, init);
  };
}
const flush = async () => { await settle(); await idle(); await settle(); await idle(); };
const lastSent = () => JSON.parse(sent.at(-1).body);

test('campanha com imagem no topo: sobe a arte uma vez e manda no cabeçalho do modelo', async () => {
  const t2 = (await call('admin', 'GET', '/api/templates')).body.find((t) => t.name === 'promo_foto');
  assert.equal(t2.header_media, 'IMAGE');
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const up = await realFetch(base + '/api/files', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'content-type': 'image/jpeg', 'x-filename': 'arte.jpg' }, body: jpg });
  const file = await up.json();
  assert.ok(file.id);
  const body = { name: 'Arte sinais', channel: 'whatsapp', tags: ['Campanha X'], template_id: t2.id, skip_recent_days: 0, window_start: 0, window_end: 24 };
  const id = (await call('admin', 'POST', '/api/campaigns', body)).body.id;
  assert.equal((await call('admin', 'POST', `/api/campaigns/${id}/start`)).status, 400); // sem a imagem não inicia
  await call('admin', 'PATCH', `/api/campaigns/${id}`, { header_file_id: file.id });
  assert.equal((await call('admin', 'POST', `/api/campaigns/${id}/start`)).status, 200);
  const before = sent.length;
  assert.equal(await stepCampaign(one('select * from campaigns where id = ?', id), Date.now()), 'sent');
  const calls = sent.slice(before);
  assert.equal(calls.filter((c) => c.url.endsWith('/media')).length, 1);
  const tpl = JSON.parse(calls.at(-1).body).template;
  assert.deepEqual(tpl.components[0], { type: 'header', parameters: [{ type: 'image', image: { id: JSON.parse(one('select header_media from campaigns where id = ?', id).header_media).id } }] });
  const msg = one("select * from messages where kind = 'template' order by id desc limit 1");
  assert.equal(msg.file_id, file.id); // o inbox mostra a arte
});

test('fluxo: resposta à campanha recebe pergunta com botões, IA responde e passa para humano', async () => {
  // sem chave da IA o fluxo com IA não liga
  const graph = { nodes: [
    { id: 's', type: 'start', x: 0, y: 0, data: {} },
    { id: 'q', type: 'question', x: 0, y: 0, data: { text: 'Oii {{primeiro_nome}}, tudo bem? Qual modelo da sua antena e do seu monitor?', buttons: ['John Deere', 'Trimble'], timeout_hours: 20 } },
    { id: 'ai', type: 'ai_reply', x: 0, y: 0, data: { max_turns: 4, timeout_hours: 20 } },
    { id: 'tr', type: 'message', x: 0, y: 0, data: { text: 'Trimble: CenterPoint RTX e RangePoint RTX' } },
    { id: 'h', type: 'handoff', x: 0, y: 0, data: {} },
    { id: 'tag', type: 'tag', x: 0, y: 0, data: { tag: 'Robô Trimble' } },
  ], edges: [
    { from: 's', port: 'next', to: 'q' }, { from: 'q', port: 'John Deere', to: 'ai' }, { from: 'q', port: 'respondeu', to: 'ai' },
    { from: 'q', port: 'Trimble', to: 'tr' }, { from: 'tr', port: 'next', to: 'tag' }, { from: 'q', port: 'sem resposta', to: 'h' }, { from: 'ai', port: 'humano', to: 'h' },
  ] };
  const fid = (await call('admin', 'POST', '/api/flows', { name: 'Resposta GPS', trigger: 'campaign_reply' })).body.id;
  assert.equal((await call('admin', 'PATCH', `/api/flows/${fid}`, { graph, active: true })).status, 400);
  await call('admin', 'PATCH', '/api/settings', { ai: { api_key: 'sk-ant-teste', knowledge: 'SF3: 40% de desconto. Pagamento no cartão em até 10x.' } });
  assert.equal((await call('admin', 'GET', '/api/me')).body.ai.has_key, true);
  assert.equal((await call('admin', 'PATCH', `/api/flows/${fid}`, { graph, active: true })).status, 200);

  const csv = 'nome,telefone,tags\nAgro Rogério Lima,67 99888-1001,Fluxo T\nAgro Paulo Souza,67 99888-1002,Fluxo T\n';
  await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'f.csv' }, body: csv });
  const t1 = (await call('admin', 'GET', '/api/templates')).body.find((t) => t.name === 'retomar');
  const cid = (await call('admin', 'POST', '/api/campaigns', { name: 'GPS', channel: 'whatsapp', tags: ['Fluxo T'], template_id: t1.id, params: ['{{primeiro_nome}}'], window_start: 0, window_end: 24 })).body.id;
  await call('admin', 'POST', `/api/campaigns/${cid}/start`);
  const camp = () => one('select * from campaigns where id = ?', cid);
  await stepCampaign(camp(), Date.now());
  await stepCampaign(camp(), Date.now() + 60e3);

  // Rogério responde a campanha -> robô pergunta com botões
  await webhook(waMsg('wamid.f1', '556798881001', 'Tenho interesse', 'Rogério'));
  await flush();
  let out = lastSent();
  assert.equal(out.type, 'interactive');
  assert.equal(out.interactive.body.text, 'Oii Rogério, tudo bem? Qual modelo da sua antena e do seu monitor?');
  assert.deepEqual(out.interactive.action.buttons.map((b) => b.reply.title), ['John Deere', 'Trimble']);
  const conv = one("select c.* from conversations c join contact_points p on p.contact_id = c.contact_id where p.value_norm = '5567998881001'");
  const runRow = () => one('select * from flow_runs where conversation_id = ? order by id desc limit 1', conv.id);
  assert.equal(runRow().state, 'waiting_reply');

  // escolhe John Deere -> IA responde e continua esperando
  aiAnswers = ['{"resposta":"Rogério, o SF3 está com 40% de desconto e dá para pagar no cartão em até 10x. Qual o modelo do monitor?","handoff":false}'];
  await webhook(waMsg('wamid.f2', '556798881001', 'John Deere', 'Rogério'));
  await flush();
  out = lastSent();
  assert.equal(out.type, 'text');
  assert.match(out.text.body, /40% de desconto/);
  const req = anthropic.at(-1);
  assert.equal(req.headers['x-api-key'], 'sk-ant-teste');
  assert.equal(req.body.model, 'claude-haiku-5-5');
  assert.match(req.body.system, /SF3: 40% de desconto/);
  assert.equal(req.body.messages.at(-1).role, 'user');
  assert.match(req.body.messages.at(-1).content, /John Deere/);
  assert.equal(runRow().state, 'waiting_reply');

  // quer fechar -> IA avisa e passa para humano: tarefa criada, robô para
  aiAnswers = ['{"resposta":"Perfeito! Um especialista já vai continuar com você para fechar.","handoff":true,"motivo":"quer fechar"}'];
  await webhook(waMsg('wamid.f3', '556798881001', 'Quero fechar, 4640', 'Rogério'));
  await flush();
  assert.equal(runRow().state, 'handoff');
  assert.match(lastSent().text.body, /especialista/);
  const lead = one('select lead_id from conversations where id = ?', conv.id).lead_id;
  const task = one("select * from tasks where entity = 'lead' and entity_id = ? order by id desc limit 1", lead);
  assert.match(task.text, /quer fechar/);
  assert.equal(one('select count(*) n from messages where conversation_id = ? and bot = 1', conv.id).n, 3);
  // depois do handoff, nova mensagem do cliente não reativa o robô
  const n = sent.length;
  await webhook(waMsg('wamid.f4', '556798881001', 'Alô?', 'Rogério'));
  await flush();
  assert.equal(sent.length, n);

  // Paulo: 1º chega a mensagem automática do WhatsApp Business dele e depois um "Ok 👍" -> o robô fica quieto
  let quiet = sent.length;
  await webhook(waMsg('wamid.f5a', '556798881002', 'Olá! Agradecemos seu contato. No momento não podemos responder, em breve retornaremos.', 'Paulo'));
  await flush();
  await webhook(waMsg('wamid.f5b', '556798881002', 'Ok 👍', 'Paulo'));
  await flush();
  assert.equal(sent.length, quiet);
  assert.equal(one("select count(*) n from flow_runs f join conversations c on c.id = f.conversation_id join contact_points p on p.contact_id = c.contact_id where p.value_norm = '5567998881002'").n, 0);
  // Paulo escreve de verdade -> agora sim o robô começa; depois toca em Trimble -> mensagem fixa + etiqueta; fluxo termina
  await webhook(waMsg('wamid.f5', '556798881002', 'Oi', 'Paulo'));
  await flush();
  await webhook(waMsg('wamid.f6', '556798881002', 'trimble', 'Paulo'));
  await flush();
  assert.equal(lastSent().text.body, 'Trimble: CenterPoint RTX e RangePoint RTX');
  const paulo = one("select contact_id from contact_points where value_norm = '5567998881002'").contact_id;
  assert.ok(one("select 1 from entity_tags et join tags t on t.id = et.tag_id where et.entity_id = ? and t.name = 'Robô Trimble'", paulo));
  const f = (await call('admin', 'GET', `/api/flows/${fid}`)).body;
  assert.equal(f.runs.handoff, 1);
  assert.equal(f.runs.done, 1);
  await call('admin', 'PATCH', `/api/flows/${fid}`, { active: false });
});

test('fluxo: sem resposta no prazo, atendente assume e SAIR param o robô', async () => {
  const graph = { nodes: [
    { id: 's', type: 'start', x: 0, y: 0, data: {} },
    { id: 'q', type: 'question', x: 0, y: 0, data: { text: 'Olá! Qual modelo do seu monitor?', timeout_hours: 20 } },
    { id: 'm', type: 'message', x: 0, y: 0, data: { text: 'Ainda por aí? Me manda uma foto do monitor 📷' } },
    { id: 'h', type: 'handoff', x: 0, y: 0, data: { note: 'cliente respondeu' } },
  ], edges: [{ from: 's', port: 'next', to: 'q' }, { from: 'q', port: 'sem resposta', to: 'm' }, { from: 'q', port: 'respondeu', to: 'h' }] };
  const fid = (await call('admin', 'POST', '/api/flows', { name: 'Boas-vindas', trigger: 'new_conversation', graph })).body.id;
  assert.equal((await call('admin', 'PATCH', `/api/flows/${fid}`, { active: true })).status, 200);
  const st = (phone) => one('select r.state from flow_runs r join conversations c on c.id = r.conversation_id where c.external_id = ? order by r.id desc limit 1', phone)?.state;

  await webhook(waMsg('wamid.n1', '556791110001', 'Boa tarde', 'Novo Um'));
  await flush();
  assert.equal(lastSent().text.body, 'Olá! Qual modelo do seu monitor?');
  assert.equal(st('556791110001'), 'waiting_reply');
  await tickFlows(Date.now() + 21 * 3600e3); // passou o prazo
  await flush();
  assert.equal(lastSent().text.body, 'Ainda por aí? Me manda uma foto do monitor 📷');
  assert.equal(st('556791110001'), 'done');

  await webhook(waMsg('wamid.n2', '556791110002', 'Oi', 'Novo Dois'));
  await flush();
  const conv2 = one("select id from conversations where external_id = '556791110002'").id;
  await call('admin', 'POST', `/api/conversations/${conv2}/messages`, { text: 'Oi, aqui é o Lucas' });
  assert.equal(st('556791110002'), 'stopped');

  await webhook(waMsg('wamid.n3', '556791110003', 'Oi', 'Novo Três'));
  await flush();
  await webhook(waMsg('wamid.n4', '556791110003', 'SAIR', 'Novo Três'));
  await flush();
  assert.equal(st('556791110003'), 'stopped');
  await call('admin', 'PATCH', `/api/flows/${fid}`, { active: false });
});

test('simulador percorre o desenho sem enviar nada', async () => {
  const graph = { nodes: [
    { id: 's', type: 'start', x: 0, y: 0, data: {} },
    { id: 'q', type: 'question', x: 0, y: 0, data: { text: 'Oii {{primeiro_nome}}! É John Deere ou Trimble?', buttons: ['John Deere', 'Trimble'] } },
    { id: 'm', type: 'message', x: 0, y: 0, data: { text: 'Trimble anotado' } },
    { id: 'w', type: 'wait', x: 0, y: 0, data: { amount: 2, unit: 'h' } },
    { id: 'm2', type: 'message', x: 0, y: 0, data: { text: 'Conseguiu ver?' } },
  ], edges: [{ from: 's', port: 'next', to: 'q' }, { from: 'q', port: 'Trimble', to: 'm' }, { from: 'm', port: 'next', to: 'w' }, { from: 'w', port: 'next', to: 'm2' }] };
  const n = sent.length;
  let r = (await call('admin', 'POST', '/api/flows/simulate', { graph, action: { type: 'start', text: 'Quero o preço' } })).body;
  assert.deepEqual(r.out[0], { type: 'bot', text: 'Oii João! É John Deere ou Trimble?', buttons: ['John Deere', 'Trimble'] });
  assert.equal(r.sim.state, 'waiting_reply');
  r = (await call('admin', 'POST', '/api/flows/simulate', { graph, sim: r.sim, action: { type: 'reply', text: 'Trimble' } })).body;
  assert.equal(r.out[0].text, 'Trimble anotado');
  assert.equal(r.sim.state, 'waiting_time');
  r = (await call('admin', 'POST', '/api/flows/simulate', { graph, sim: r.sim, action: { type: 'timeout' } })).body;
  assert.equal(r.out.at(-1).text, 'Conseguiu ver?');
  assert.equal(r.sim.state, 'done');
  assert.equal(sent.length, n);
  // desenho sem Início é recusado
  assert.equal((await call('admin', 'POST', '/api/flows/simulate', { graph: { nodes: [], edges: [] }, action: { type: 'start' } })).status, 400);
});

test('campanha em lotes: intervalo sorteado de 15 a 30 s e pausa de 2 h depois de cada lote', async () => {
  const csv = 'nome,telefone,tags\nLote Um,67 99777-0001,Lote T\nLote Dois,67 99777-0002,Lote T\nLote Tres,67 99777-0003,Lote T\n';
  await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'l.csv' }, body: csv });
  const t1 = (await call('admin', 'GET', '/api/templates')).body.find((t) => t.name === 'retomar');
  // padrão do WhatsApp = ritmo do WA Web Plus
  const pid = (await call('admin', 'POST', '/api/campaigns', { name: 'Padrão', channel: 'whatsapp', tags: ['Lote T'], template_id: t1.id })).body.id;
  const p = one('select * from campaigns where id = ?', pid);
  assert.deepEqual([p.interval_seconds, p.interval_max_seconds, p.batch_min, p.batch_max, p.batch_pause_minutes, p.window_start, p.window_end],
    [15, 30, 310, 332, 120, 6, 22]);
  assert.deepEqual([p.mini_every, p.mini_pause_min, p.mini_pause_max], [50, 20, 23]); // pausa curta a cada 50

  const id = (await call('admin', 'POST', '/api/campaigns', { name: 'Lotes', channel: 'whatsapp', tags: ['Lote T'], template_id: t1.id, params: ['{{primeiro_nome}}'],
    batch_min: 2, batch_max: 2, batch_pause_minutes: 120, window_start: 0, window_end: 24 })).body.id;
  await call('admin', 'POST', `/api/campaigns/${id}/start`);
  const camp = () => one('select * from campaigns where id = ?', id);
  const t0 = Date.now();
  assert.equal(await stepCampaign(camp(), t0), 'sent');
  const gap = camp().next_at - t0;
  assert.ok(gap >= 15e3 && gap <= 30e3, `intervalo ${gap}`);
  assert.equal(camp().batch_sent, 1);
  assert.equal(await stepCampaign(camp(), t0 + 31e3), 'sent'); // fecha o lote de 2
  assert.equal(camp().next_at - (t0 + 31e3), 120 * 60e3);
  assert.equal(camp().batch_sent, 0);
  assert.equal(await stepCampaign(camp(), t0 + 60 * 60e3), 'wait'); // ainda na pausa
  assert.equal(await stepCampaign(camp(), t0 + 31e3 + 120 * 60e3), 'sent');
  assert.equal(camp().batch_sent, 1);
  // lote mínimo maior que o máximo é recusado
  await call('admin', 'POST', `/api/campaigns/${id}/pause`);
  await call('admin', 'PATCH', `/api/campaigns/${id}`, { batch_min: 400, batch_max: 300 });
  assert.equal((await call('admin', 'POST', `/api/campaigns/${id}/start`)).status, 400);
  // pausa curta: a cada 2 mensagens, 20 a 23 min sorteados
  const mid = (await call('admin', 'POST', '/api/campaigns', { name: 'Mini', channel: 'whatsapp', tags: ['Lote T'], template_id: t1.id, params: ['x'],
    batch_min: 0, batch_max: 0, mini_every: 2, mini_pause_min: 20, mini_pause_max: 23, skip_recent_days: 0, window_start: 0, window_end: 24 })).body.id;
  await call('admin', 'POST', `/api/campaigns/${mid}/start`);
  const mc = () => one('select * from campaigns where id = ?', mid);
  const m0 = Date.now();
  assert.equal(await stepCampaign(mc(), m0), 'sent');
  assert.ok(mc().next_at - m0 <= 30e3);
  assert.equal(await stepCampaign(mc(), m0 + 31e3), 'sent');
  const mg = mc().next_at - (m0 + 31e3);
  assert.ok(mg >= 20 * 60e3 && mg <= 23 * 60e3, `pausa curta ${mg}`);
  assert.equal(mc().mini_sent, 0);
  await call('admin', 'POST', `/api/campaigns/${mid}/pause`);
});

test('tabela por modelo: acha o modelo escrito de vários jeitos', async () => {
  const { matchCatalog } = await import('../server/flows.js');
  const items = [{ name: 'AG-25', keywords: ['372', 'AG-25'] }, { name: 'NAV 900', keywords: ['NAV 900'] }, { name: 'SF3000', keywords: ['3000'] }, { name: 'GS4', keywords: ['4640', 'GS4'] }];
  const names = (t) => matchCatalog(items, t).map((i) => i.name);
  assert.deepEqual(names('tenho uma ag 25'), ['AG-25']);
  assert.deepEqual(names('Trimble 372'), ['AG-25']);
  assert.deepEqual(names('nav-900 da trimble'), ['NAV 900']);
  assert.deepEqual(names('StarFire 3000 com monitor 4640'), ['SF3000', 'GS4']);
  assert.deepEqual(names('paguei 30000 reais'), []); // número só vale inteiro
  assert.deepEqual(names('13720'), []);
  assert.deepEqual(names('não sei, é verde'), []);
});

test('Atendente IA com tabelas: pede o modelo, pede o contato do gerente, manda a tabela certa e nunca outra', async () => {
  (await import('../server/flows.js')).initFlows(); // cria o fluxo padrão com as 6 tabelas
  const items = JSON.parse(one("select graph from flows where name like 'Resposta à campanha%' order by id limit 1").graph).nodes.find((n) => n.type === 'catalog').data.items;
  const graph = { nodes: [
    { id: 's', type: 'start', x: 0, y: 0, data: {} },
    { id: 'ia', type: 'ai_agent', x: 0, y: 0, data: { items, max_turns: 6, timeout_hours: 1 } },
    { id: 'h', type: 'handoff', x: 0, y: 0, data: {} },
    { id: 'fim', type: 'end', x: 0, y: 0, data: {} },
    { id: 'foto', type: 'question', x: 0, y: 0, data: { text: 'Se preferir, me manda uma foto do monitor 📷', timeout_hours: 20 } },
  ], edges: [
    { from: 's', port: 'next', to: 'ia' }, { from: 'ia', port: 'enviou', to: 'h' }, { from: 'ia', port: 'humano', to: 'h' },
    { from: 'ia', port: 'encerrou', to: 'fim' }, { from: 'ia', port: 'sem resposta', to: 'foto' }, { from: 'foto', port: 'respondeu', to: 'ia' },
  ] };
  const sim = (sim_, action) => call('admin', 'POST', '/api/flows/simulate', { graph, sim: sim_, action }).then((r) => r.body);
  // "Qual o preço??" -> pede o modelo, sem tabela
  aiAnswers = ['{"resposta":"Pra te passar o valor certinho, qual o modelo da sua antena e do monitor?","tabelas":[],"acao":"continuar"}'];
  let r = await sim(null, { type: 'start', text: 'Qual o preço??' });
  assert.equal(r.out.at(-1).text, 'Pra te passar o valor certinho, qual o modelo da sua antena e do monitor?');
  assert.ok(!r.out.some((m) => m.image));
  assert.equal(r.sim.state, 'waiting_reply');
  assert.match(anthropic.at(-1).body.system, /NUNCA escreva preço/);
  assert.match(anthropic.at(-1).body.system, /Antena StarFire 6000/);
  // "Passei para o meu gerente" -> pede o contato, continua
  aiAnswers = ['{"resposta":"Perfeito! Me passa o nome e o WhatsApp dele que eu falo direto 😊","tabelas":[],"acao":"continuar"}'];
  r = await sim(r.sim, { type: 'reply', text: 'Passei para o meu gerente cuidar.' });
  assert.match(r.out.at(-1).text, /WhatsApp dele/);
  assert.equal(r.sim.state, 'waiting_reply');
  // diz o modelo -> manda só a tabela escolhida (a IA inventou uma que não existe: ignorada), frase como legenda, vai para humano
  aiAnswers = ['{"resposta":"Segue a tabela da StarFire 6000 😊 Qual plano fica melhor?","tabelas":["Antena StarFire 6000","Tabela Inventada"],"acao":"continuar"}'];
  r = await sim(r.sim, { type: 'reply', text: 'É uma starfire 6000' });
  const imgs = r.out.filter((m) => m.image);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].image, items.find((i) => i.name === 'Antena StarFire 6000').file_id);
  assert.equal(imgs[0].text, 'Segue a tabela da StarFire 6000 😊 Qual plano fica melhor?');
  assert.match(r.out.at(-1).text, /recebeu a tabela de Antena StarFire 6000/);
  assert.equal(r.sim.state, 'handoff');
  // sem interesse -> agradece e encerra, sem tarefa
  aiAnswers = ['{"resposta":"Sem problema, obrigado pelo retorno! Qualquer coisa estamos à disposição.","tabelas":[],"acao":"encerrar"}'];
  r = await sim(null, { type: 'start', text: 'Não tenho interesse' });
  assert.match(r.out.at(-1).text, /obrigado pelo retorno/);
  assert.equal(r.sim.state, 'done');
  // sumiu 1 h -> pede a foto; respondeu -> volta para a IA
  aiAnswers = ['{"resposta":"Qual o modelo da antena?","tabelas":[],"acao":"continuar"}'];
  r = await sim(null, { type: 'start', text: 'Oi' });
  r = await sim(r.sim, { type: 'timeout' });
  assert.equal(r.out.at(-1).text, 'Se preferir, me manda uma foto do monitor 📷');
  aiAnswers = ['{"resposta":"Recebi a foto! Vou verificar e já te passo o valor 😊","tabelas":[],"acao":"humano","motivo":"mandou foto"}'];
  r = await sim(r.sim, { type: 'reply', text: '' });
  assert.match(r.out.at(-1).text, /mandou foto/);
  assert.equal(r.sim.state, 'handoff');
});

test('fluxo padrão: cliente diz o modelo, recebe a tabela com a frase e vai para humano', async () => {
  const { initFlows } = await import('../server/flows.js');
  initFlows();
  initFlows(); // segunda vez não duplica
  const flows = all("select * from flows where name like 'Resposta à campanha%'");
  assert.equal(flows.length, 1);
  const f = flows[0];
  const graph = JSON.parse(f.graph);
  assert.equal(graph.nodes.find((n) => n.type === 'catalog').data.items.length, 6);
  assert.ok(!graph.nodes.some((n) => n.type === 'ai_reply'));

  // simulador: antena 6000 + monitor 4640 -> duas tabelas, a frase na última, depois humano
  let r = (await call('admin', 'POST', '/api/flows/simulate', { graph, action: { type: 'start', text: 'Tenho interesse' } })).body;
  assert.equal(r.out[1].text, 'Oii tudo bem? Qual modelo da sua antena e do seu monitor?');
  r = (await call('admin', 'POST', '/api/flows/simulate', { graph, sim: r.sim, action: { type: 'reply', text: 'StarFire 6000 e monitor 4640' } })).body;
  const imgs = r.out.filter((m) => m.image);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].text, '');
  assert.equal(imgs[1].text, 'Tenho esses planos, qual seria ideal para o senhor?');
  assert.match(r.out.at(-1).text, /Passa para um atendente.*Monitores GS4 e Antena StarFire 6000/);
  assert.equal(r.sim.state, 'handoff');
  // modelo não reconhecido ("Antena 999 trimble"): nenhuma tabela, só "Só um momento, irei verificar." e vai para humano
  r = (await call('admin', 'POST', '/api/flows/simulate', { graph, action: { type: 'start', text: 'Oi' } })).body;
  r = (await call('admin', 'POST', '/api/flows/simulate', { graph, sim: r.sim, action: { type: 'reply', text: 'Antena 999 trimble' } })).body;
  assert.ok(!r.out.some((m) => m.image));
  assert.ok(r.out.some((m) => m.text === 'Só um momento, irei verificar.'));
  assert.match(r.out.at(-1).text, /não reconheceu o modelo/);
  assert.equal(r.sim.state, 'handoff');

  // de verdade: liga o fluxo, cliente responde a campanha e diz "AG 25"
  assert.equal((await call('admin', 'PATCH', `/api/flows/${f.id}`, { active: true })).status, 200);
  const csv = 'nome,telefone,tags\nAgro Marcos Dias,67 99666-0001,Tabela T\n';
  await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 't.csv' }, body: csv });
  const t1 = (await call('admin', 'GET', '/api/templates')).body.find((t) => t.name === 'retomar');
  const cid = (await call('admin', 'POST', '/api/campaigns', { name: 'Tabela', channel: 'whatsapp', tags: ['Tabela T'], template_id: t1.id, params: ['x'], window_start: 0, window_end: 24 })).body.id;
  await call('admin', 'POST', `/api/campaigns/${cid}/start`);
  await stepCampaign(one('select * from campaigns where id = ?', cid), Date.now());
  await webhook(waMsg('wamid.t1', '556796660001', 'Tenho interesse', 'Marcos'));
  await flush();
  assert.equal(lastSent().text.body, 'Oii tudo bem? Qual modelo da sua antena e do seu monitor?');
  const before = sent.length;
  await webhook(waMsg('wamid.t2', '556796660001', 'é uma ag 25 da trimble', 'Marcos'));
  await flush();
  const calls = sent.slice(before);
  assert.equal(calls.filter((c) => c.url.endsWith('/media')).length, 1);
  const img = JSON.parse(calls.at(-1).body);
  assert.equal(img.type, 'image');
  assert.equal(img.image.caption, 'Tenho esses planos, qual seria ideal para o senhor?');
  const conv = one("select id, lead_id from conversations where external_id = '556796660001'");
  assert.equal(one('select state from flow_runs where conversation_id = ?', conv.id).state, 'handoff');
  assert.match(one("select text from tasks where entity = 'lead' and entity_id = ? order by id desc", conv.lead_id).text, /Trimble 372 \/ AG-25/);
  const m = one("select * from messages where conversation_id = ? and kind = 'image' and bot = 1", conv.id);
  assert.ok(m.file_id);
  await call('admin', 'PATCH', `/api/flows/${f.id}`, { active: false });
});

// ---------- WhatsApp Web (QR code), com um WhatsApp falso no lugar da biblioteca
let waFake; // o WhatsApp falso do teste abaixo, reaproveitado no teste do anúncio
test('WhatsApp Web: QR code, campanha com arte, resposta roda o fluxo da tabela e eco do celular', async () => {
  const { EventEmitter } = await import('node:events');
  const { setWaLib, webStatus } = await import('../server/waweb.js');
  const fake = { noWa: new Set(['5567997771002']), client: null, seq: 0 };
  waFake = fake;
  class Client extends EventEmitter {
    constructor() { super(); fake.client = this; this.sent = []; this.info = { wid: { user: '556793300144' } }; }
    async initialize() { setTimeout(() => this.emit('qr', 'QR-123'), 5); }
    async getNumberId(n) { return fake.noWa.has(n) ? null : { _serialized: `${n.length === 13 ? n.slice(0, 4) + n.slice(5) : n}@c.us` }; }
    async sendMessage(chatId, content, opts) { const id = { _serialized: `true_${chatId}_${++fake.seq}` }; this.sent.push({ chatId, content, opts, id: id._serialized }); return { id }; }
    async logout() {} async destroy() {}
  }
  setWaLib({ Client, LocalAuth: class {}, MessageMedia: class { constructor(mime, data, name) { Object.assign(this, { mime, data, name }); } }, toDataURL: async (s) => `data:image/png;base64,${s}` }, { echoDelay: 5 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const inMsg = (from, body, id, extra = {}) => ({ from, to: '556793300144@c.us', body, type: 'chat', id: { _serialized: id }, timestamp: Math.floor(Date.now() / 1000), fromMe: false, hasMedia: false,
    getContact: async () => ({ number: from.split('@')[0], pushname: 'Carlos' }), ...extra });

  // conectar: QR -> pronto
  const ch = (await call('admin', 'POST', '/api/waweb')).body;
  await wait(20);
  let st = (await call('admin', 'GET', `/api/waweb/${ch.id}`)).body;
  assert.equal(st.state, 'qr');
  assert.match(st.qr, /^data:image\/png;base64,QR-123/);
  fake.client.emit('ready');
  st = (await call('admin', 'GET', `/api/waweb/${ch.id}`)).body;
  assert.deepEqual([st.state, st.me], ['ready', '556793300144']);
  assert.equal((await call('admin', 'GET', '/api/me')).body.channels.find((c) => c.id === ch.id).mode, 'web');

  // campanha pelo WhatsApp Web: sem modelo, texto livre + arte
  const csv = 'nome,telefone,tags\nAgro Carlos Melo,67 99777-1001,Web T\nAgro Sem Zap,67 99777-1002,Web T\n';
  await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'w.csv' }, body: csv });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const file = await (await realFetch(base + '/api/files', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'content-type': 'image/png', 'x-filename': 'arte.png' }, body: png })).json();
  const cid = (await call('admin', 'POST', '/api/campaigns', { name: 'Web', channel: 'whatsapp', tags: ['Web T'], body: 'Oi {{primeiro_nome}}, tudo bem? Sinais com até 50% de desconto.', header_file_id: file.id, window_start: 0, window_end: 24 })).body.id;
  const camp = () => one('select * from campaigns where id = ?', cid);
  assert.equal(camp().wa_channel_id, ch.id); // sai pelo WhatsApp Web sozinho
  assert.equal((await call('admin', 'POST', `/api/campaigns/${cid}/start`)).status, 200);
  assert.equal(await stepCampaign(camp(), Date.now()), 'sent');
  const out = fake.client.sent.at(-1);
  assert.equal(out.chatId, '556797771001@c.us');
  assert.equal(out.content.mime, 'image/png');
  assert.equal(out.opts.caption, 'Oi Carlos, tudo bem? Sinais com até 50% de desconto.');
  assert.equal(await stepCampaign(camp(), Date.now() + 60e3), 'skipped'); // número sem WhatsApp
  assert.equal(one("select error from campaign_recipients where campaign_id = ? and status = 'skipped'", cid).error, 'número sem WhatsApp');
  assert.equal(one('select count(*) n from conversations c join contacts ct on ct.id = c.contact_id where ct.name = ?', 'Agro Sem Zap').n, 0);

  // confirmação de leitura
  fake.client.emit('message_ack', { id: { _serialized: out.id } }, 3);
  assert.equal(one('select status from messages where external_id = ?', out.id).status, 'read');

  // cliente responde -> fluxo da tabela (pelo WhatsApp Web, sem janela de 24 h)
  const flow = one("select id from flows where name = 'Resposta à campanha: sinais GPS'");
  await call('admin', 'PATCH', `/api/flows/${flow.id}`, { active: true });
  fake.client.emit('message', inMsg('556797771001@c.us', 'Tenho interesse', 'in-1'));
  await wait(20); await flush();
  assert.equal(fake.client.sent.at(-1).content, 'Oii tudo bem? Qual modelo da sua antena e do seu monitor?');
  assert.equal(one("select status from campaign_recipients where campaign_id = ? and status = 'replied'", cid).status, 'replied');
  fake.client.emit('message', inMsg('556797771001@c.us', 'É uma StarFire 3000', 'in-2'));
  await wait(20); await flush();
  const tab = fake.client.sent.at(-1);
  assert.equal(tab.content.name, 'starfire-3000.png');
  assert.equal(tab.opts.caption, 'Tenho esses planos, qual seria ideal para o senhor?');
  const conv = one("select * from conversations where external_id = '556797771001'");
  assert.equal(one('select state from flow_runs where conversation_id = ? order by id desc', conv.id).state, 'handoff');

  // você responde pelo celular: aparece no CRM (conversa conhecida) ...
  fake.client.emit('message_create', { fromMe: true, from: '556793300144@c.us', to: '556797771001@c.us', body: 'Oi Carlos, aqui é o Lucas', type: 'chat', id: { _serialized: 'me-1' }, timestamp: Math.floor(Date.now() / 1000), hasMedia: false });
  // ... mas conversa pessoal (fora do CRM) fica de fora, e o que o CRM enviou não duplica
  fake.client.emit('message_create', { fromMe: true, to: '5511912345678@c.us', body: 'oi amor', type: 'chat', id: { _serialized: 'me-2' }, timestamp: 1, hasMedia: false });
  fake.client.emit('message_create', { fromMe: true, to: '556797771001@c.us', body: 'x', type: 'chat', id: { _serialized: tab.id }, timestamp: 1, hasMedia: true });
  await wait(40);
  assert.equal(one("select direction from messages where external_id = 'me-1'").direction, 'out');
  assert.equal(one("select count(*) n from messages where external_id = 'me-2'").n, 0);
  assert.equal(one('select count(*) n from messages where external_id = ?', tab.id).n, 1);

  // resposta pela caixa de entrada sai pelo WhatsApp Web
  await call('admin', 'POST', `/api/conversations/${conv.id}/messages`, { text: 'Qual prazo o senhor prefere?' });
  assert.deepEqual([fake.client.sent.at(-1).chatId, fake.client.sent.at(-1).content], ['556797771001@c.us', 'Qual prazo o senhor prefere?']);

  // caiu a conexão: a campanha pausa e o contato continua na fila
  await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'w2.csv' }, body: 'nome,telefone,tags\nDona Ana Paz,67 99777-1003,Web T2\n' });
  const c2 = (await call('admin', 'POST', '/api/campaigns', { name: 'Web 2', channel: 'whatsapp', tags: ['Web T2'], body: 'Oi', window_start: 0, window_end: 24 })).body.id;
  await call('admin', 'POST', `/api/campaigns/${c2}/start`);
  fake.client.emit('disconnected', 'LOGOUT'); // celular desligou o aparelho: espera o QR novo
  assert.equal(webStatus(ch.id).state, 'starting');
  assert.equal(await stepCampaign(one('select * from campaigns where id = ?', c2), Date.now()), 'paused');
  assert.match(one('select pause_reason from campaigns where id = ?', c2).pause_reason, /desconectado/);
  assert.equal(one("select count(*) n from campaign_recipients where campaign_id = ? and status = 'queued'", c2).n, 1);
  await call('admin', 'PATCH', `/api/flows/${flow.id}`, { active: false });
});

test('campanha por e-mail com a arte embutida', async () => {
  const resend = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) { resend.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'em_2' }), { status: 200 }); }
    return prev(url, init);
  };
  try {
    await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'e.csv' }, body: 'nome,email,tags\nJoana Prado,joana@ex.com,Email Arte\n' });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    const file = await (await realFetch(base + '/api/files', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'content-type': 'image/jpeg', 'x-filename': 'arte.jpg' }, body: jpg })).json();
    const id = (await call('admin', 'POST', '/api/campaigns', { name: 'Email arte', channel: 'email', tags: ['Email Arte'], subject: 'Sinal GPS', body: 'Olá {{primeiro_nome}}', header_file_id: file.id, window_start: 0, window_end: 24 })).body.id;
    await call('admin', 'POST', `/api/campaigns/${id}/start`);
    assert.equal(await stepCampaign(one('select * from campaigns where id = ?', id), Date.now()), 'sent');
    const m = resend.at(-1);
    assert.match(m.html, /<img src="cid:arte"/);
    assert.deepEqual(m.attachments, [{ content: jpg.toString('base64'), filename: 'arte.jpg', content_type: 'image/jpeg', content_id: 'arte' }]);
    assert.match(m.html, /Olá Joana/);
  } finally { globalThis.fetch = prev; }
});

test('teste da campanha de e-mail vai para mim com [TESTE], texto e arte', async () => {
  const resend = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) { resend.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'em_t' }), { status: 200 }); }
    return prev(url, init);
  };
  try {
    const camp = one("select * from campaigns where name = 'Email arte'");
    const r = await call('admin', 'POST', '/api/email/test', { campaign_id: camp.id, to: 'eu@exemplo.com' });
    assert.equal(r.status, 200);
    assert.deepEqual(resend.at(-1).to, ['eu@exemplo.com']);
    assert.equal(resend.at(-1).subject, '[TESTE] Sinal GPS');
    assert.equal(resend.at(-1).attachments[0].content_id, 'arte');
    assert.equal((await call('admin', 'POST', '/api/email/test', { to: 'nada' })).status, 400);
  } finally { globalThis.fetch = prev; }
});

// ---------- duas empresas no mesmo CRM
test('empresas: funil, campanhas, ajustes de e-mail e "sair da lista" separados; contatos em comum', async () => {
  const B2 = { 'x-brand': '2' };
  const me1 = (await call('admin', 'GET', '/api/me')).body;
  const me2 = (await call('admin', 'GET', '/api/me', null, B2)).body;
  assert.deepEqual(me1.brands.map((b) => b.name), ['AgroVox', 'AgroPool']);
  assert.equal(me2.brand, 2);
  assert.equal(me2.general.company, 'AgroPool');
  assert.deepEqual(me2.pipelines.map((p) => p.name), ['Funil AgroPool']);
  assert.ok(!me1.pipelines.some((p) => p.name === 'Funil AgroPool'));
  assert.equal(me2.channels.length, 0); // WhatsApp e e-mail da AgroVox não aparecem na AgroPool
  // ajustes de e-mail por empresa
  await call('admin', 'PATCH', '/api/settings', { email: { from: 'AgroPool <oi@agro-pool.com>', api_key: 're_pool' } }, B2);
  assert.equal((await call('admin', 'GET', '/api/me', null, B2)).body.email.from, 'AgroPool <oi@agro-pool.com>');
  assert.notEqual((await call('admin', 'GET', '/api/me')).body.email.from, 'AgroPool <oi@agro-pool.com>');
  // contato em comum; sair da AgroPool não tira da AgroVox
  const ana = one("select contact_id id from contact_points where value_norm = 'joana@ex.com'").id;
  assert.equal((await call('admin', 'PATCH', `/api/contacts/${ana}`, { opt_out: true }, B2)).status, 200);
  assert.ok((await call('admin', 'GET', `/api/contacts/${ana}`, null, B2)).body.opt_out_at);
  assert.equal((await call('admin', 'GET', `/api/contacts/${ana}`)).body.opt_out_at, null);
  const aud = { name: 'x', channel: 'email', tags: ['Email Arte'], subject: 's', body: 'b', skip_recent_days: 0 };
  assert.equal((await call('admin', 'POST', '/api/campaigns/audience', aud, B2)).body.count, 0);
  assert.equal((await call('admin', 'POST', '/api/campaigns/audience', aud)).body.count, 1);
  // campanha criada na AgroPool fica na AgroPool
  const id = (await call('admin', 'POST', '/api/campaigns', aud, B2)).body.id;
  assert.equal(one('select brand_id from campaigns where id = ?', id).brand_id, 2);
  assert.ok((await call('admin', 'GET', '/api/campaigns', null, B2)).body.every((c) => c.brand_id === 2));
  assert.ok(!(await call('admin', 'GET', '/api/campaigns')).body.some((c) => c.id === id));
  // lead novo na AgroPool cai no funil dela; o painel da AgroPool só olha o funil dela
  const lead = (await call('admin', 'POST', '/api/leads', { name: 'App AgroPool' }, B2)).body.id;
  assert.equal(one('select p.brand_id from leads l join pipelines p on p.id = l.pipeline_id where l.id = ?', lead).brand_id, 2);
  assert.ok(!(await call('admin', 'GET', '/api/leads')).body.some((l) => l.id === lead));
  assert.deepEqual((await call('admin', 'GET', '/api/dashboard', null, B2)).body.pipelines.map((p) => p.name), ['Funil AgroPool']);
  // trocar o nome na setinha
  await call('admin', 'PATCH', '/api/settings', { general: { company: 'AgroPool App' } }, B2);
  assert.equal(one('select name from brands where id = 2').name, 'AgroPool App');
  await call('admin', 'PATCH', '/api/settings', { general: { company: 'AgroPool' } }, B2);
});

// ---------- respostas por e-mail entram no CRM (caixa IMAP falsa)
test('e-mail: resposta vira conversa e lead, conta na campanha, robô manda a tabela no mesmo fio e SAIR tira da lista', async () => {
  const { setMailLib, tickMailboxes, stripQuoted } = await import('../server/mailbox.js');
  const box = { uidValidity: 7, uidNext: 1, msgs: [] };
  const { EventEmitter } = await import('node:events');
  class ImapFlow extends EventEmitter {
    constructor(o) { super(); this.o = o; ImapFlow.last = this; }
    async connect() { if (this.o.auth.pass !== 'abcdefghijklmnop') throw new Error('Invalid credentials'); }
    async getMailboxLock() { this.mailbox = { uidValidity: box.uidValidity, uidNext: box.uidNext }; return { release() {} }; }
    async *fetch(range) { const from = Number(range.split(':')[0]); for (const m of box.msgs) if (m.uid >= from) yield { uid: m.uid, source: m.mail }; }
    async logout() {}
  }
  setMailLib({ ImapFlow, simpleParser: async (src) => src });
  // queda da conexão com o Gmail não pode derrubar o CRM
  const errAfterPoll = () => assert.doesNotThrow(() => ImapFlow.last?.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })));
  const addMail = (mail) => { box.msgs.push({ uid: box.uidNext, mail }); box.uidNext++; };
  const resend = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) { resend.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: `em_${resend.length}` }), { status: 200 }); }
    return prev(url, init);
  };
  try {
    assert.equal(stripQuoted('É a 6000 sim\n\nEm sex., 20 de nov. de 2026 17:15, AgroVox <contato@envio.agro-vox.com>\nescreveu:\n> Olá Pedro'), 'É a 6000 sim');
    assert.equal(stripQuoted('ok\n-----Mensagem original-----\nDe: x'), 'ok');
    // ligar a caixa: senha errada avisa; certa conecta e só marca o ponto de partida
    let r = await call('admin', 'POST', '/api/mailbox', { address: 'Contato@Agro-Vox.com', imap_pass: 'errada' });
    assert.equal((await call('admin', 'POST', `/api/channels/${r.body.id}/test`)).status, 400);
    r = await call('admin', 'POST', '/api/mailbox', { address: 'contato@agro-vox.com', imap_pass: 'abcd efgh ijkl mnop' });
    const mbId = r.body.id;
    addMail({ from: { value: [{ address: 'velho@ex.com' }] }, subject: 'antigo', text: 'mensagem antiga', messageId: '<old@x>' });
    assert.equal((await call('admin', 'POST', `/api/channels/${mbId}/test`)).status, 200);
    const ch = (await call('admin', 'GET', '/api/me')).body.channels.find((c) => c.id === mbId);
    assert.deepEqual([ch.kind, ch.mode, ch.has_pass], ['email', 'imap', true]);
    // campanha de e-mail: o envio fica registrado na conversa do contato
    await realFetch(base + '/api/import/contacts', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'x-filename': 'p.csv' }, body: 'nome,email,tags\nPedro Rocha,pedro@ex.com,Email Resp\n' });
    const cid = (await call('admin', 'POST', '/api/campaigns', { name: 'Email resp', channel: 'email', tags: ['Email Resp'], subject: 'Sinal GPS', body: 'Olá {{primeiro_nome}}, qual o modelo?', window_start: 0, window_end: 24 })).body.id;
    await call('admin', 'POST', `/api/campaigns/${cid}/start`);
    assert.equal(await stepCampaign(one('select * from campaigns where id = ?', cid), Date.now()), 'sent');
    const conv = one("select * from conversations where channel_id = ? and external_id = 'pedro@ex.com'", mbId);
    assert.ok(conv);
    assert.equal(conv.lead_id, null);
    // liga o fluxo do e-mail; chega a resposta do Pedro (com a citação) e um e-mail de quem não é contato
    const flow = one("select id from flows where name = 'Resposta ao e-mail: tabela de preços'");
    assert.equal((await call('admin', 'PATCH', `/api/flows/${flow.id}`, { active: true })).status, 200);
    addMail({ from: { value: [{ address: 'Pedro@Ex.com', name: 'Pedro' }] }, subject: 'Re: Sinal GPS', messageId: '<p1@ex.com>', date: new Date(),
      text: 'Tenho uma StarFire 6000\n\nEm sex., 20 de nov. de 2026 às 17:15, AgroVox escreveu:\n> Olá Pedro, qual o modelo?', attachments: [] });
    addMail({ from: { value: [{ address: 'promo@loja.com' }] }, subject: 'Oferta', text: 'compre', messageId: '<spam@x>' });
    await tickMailboxes();
    await flush();
    errAfterPoll();
    const msg = one("select * from messages where external_id = '<p1@ex.com>'");
    assert.equal(msg.body, 'Tenho uma StarFire 6000');
    assert.equal(one("select count(*) n from messages where external_id in ('<spam@x>', '<old@x>')").n, 0);
    const c2 = one('select * from conversations where id = ?', conv.id);
    assert.ok(c2.lead_id);
    assert.equal(JSON.parse(one("select data from events where entity = 'lead' and entity_id = ? and type = 'lead_added'", c2.lead_id).data).source, 'campanha-email');
    assert.equal(one('select status from campaign_recipients where campaign_id = ?', cid).status, 'replied');
    // o robô respondeu no mesmo fio, com a tabela da StarFire 6000, e passou para humano
    const reply = resend.at(-1);
    assert.deepEqual(reply.to, ['pedro@ex.com']);
    assert.equal(reply.subject, 'Re: Sinal GPS');
    assert.equal(reply.headers['In-Reply-To'], '<p1@ex.com>');
    assert.equal(reply.attachments[0].filename, 'starfire-6000.png');
    assert.match(reply.html, /Tenho esses planos, qual seria ideal para o senhor\?/);
    assert.equal(one('select state from flow_runs where conversation_id = ? order by id desc', conv.id).state, 'handoff');
    // atendente responde pelo CRM: sai por e-mail no mesmo fio
    await call('admin', 'POST', `/api/conversations/${conv.id}/messages`, { text: 'Pedro, qual prazo prefere?' });
    assert.equal(resend.at(-1).subject, 'Re: Sinal GPS');
    assert.match(resend.at(-1).text, /qual prazo prefere/);
    // SAIR por e-mail tira da lista da AgroVox
    addMail({ from: { value: [{ address: 'pedro@ex.com' }] }, subject: 'SAIR', text: '', messageId: '<p2@ex.com>' });
    await tickMailboxes();
    await flush();
    assert.ok(one('select 1 from contact_optouts o join contact_points p on p.contact_id = o.contact_id where p.value_norm = ? and o.brand_id = 1', 'pedro@ex.com'));
    await call('admin', 'PATCH', `/api/flows/${flow.id}`, { active: false });
  } finally { globalThis.fetch = prev; }
});

test('e-mail: assinatura com WhatsApp, Instagram e site clicáveis; arte abre o WhatsApp', async () => {
  const resend = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) { resend.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'em_s' }), { status: 200 }); }
    return prev(url, init);
  };
  try {
    const sig = await (await realFetch(base + '/api/files', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'content-type': 'image/png', 'x-filename': 'mascote.png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })).json();
    await call('admin', 'PATCH', '/api/settings', { email: { whatsapp: '(67) 99999-0000', instagram: '@agrovoxtech', site: 'www.agro-vox.com', sig_image_file_id: sig.id } });
    const camp = one("select * from campaigns where name = 'Email arte'");
    await call('admin', 'POST', '/api/email/test', { campaign_id: camp.id, to: 'eu@exemplo.com' });
    const m = resend.at(-1);
    assert.match(m.html, /<a href="https:\/\/wa\.me\/5567999990000\?text=[^"]+"><img src="cid:arte"/);
    assert.match(m.html, /Chamar no WhatsApp/);
    assert.match(m.html, /href="https:\/\/instagram\.com\/agrovoxtech"/);
    assert.match(m.html, /href="https:\/\/www\.agro-vox\.com"/);
    assert.match(m.html, /<img src="cid:assinatura"/);
    assert.deepEqual(m.attachments.map((a) => a.content_id), ['arte', 'assinatura']);
    assert.match(m.text, /WhatsApp: https:\/\/wa\.me\/5567999990000/);
  } finally { globalThis.fetch = prev; }
});

test('anúncio clique-para-WhatsApp: lead com origem, etiqueta e nota do anúncio, fluxo do anúncio e quem escreveu com o CRM fechado', async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = waFake.client;
  c.emit('ready');
  c.saved = [];
  c.saveOrEditAddressbookContact = async (...a) => { c.saved.push(a); };
  const ts = () => Math.floor(Date.now() / 1000);
  const msg = (from, body, id, ad) => ({ from, to: '556793300144@c.us', body, type: 'chat', id: { _serialized: id }, timestamp: ts(), fromMe: false, hasMedia: false,
    getContact: async () => ({ number: from.split('@')[0], pushname: 'João Produtor' }), _data: ad ? { ctwaContext: ad } : {} });
  const AD = { sourceId: '120252076903650189', sourceUrl: 'https://fb.me/abc123', title: 'Sinal GPS com até 50% off', description: 'Ative pelo código', sourceType: 'ad' };
  const flow = one("select * from flows where name = 'Veio do anúncio: tabela de preços'");
  assert.equal(flow.trigger, 'ad_click');
  assert.equal(flow.active, 0); // nasce desligado
  await call('admin', 'PATCH', `/api/flows/${flow.id}`, { active: true });

  c.emit('message', msg('556798880001@c.us', 'Olá! Quero saber mais.', 'ad-1', AD));
  await wait(30); await flush();
  const conv = one("select * from conversations where external_id = '556798880001'");
  assert.equal(one('select name from contacts where id = ?', conv.contact_id).name, 'Agro Sinal João Produtor');
  // anúncio entra direto em "Primeiro contato", com responsável (sem aceitar/recusar)
  const adLead = one('select l.responsible_id, s.kind from leads l join stages s on s.id = l.stage_id where l.id = ?', conv.lead_id);
  assert.equal(adLead.kind, 'normal');
  assert.ok(adLead.responsible_id);
  assert.deepEqual(c.saved?.at(-1), ['556798880001', 'Agro Sinal', 'João Produtor', true]);
  const tags = all("select t.name from entity_tags et join tags t on t.id = et.tag_id where et.entity = 'contact' and et.entity_id = ?", conv.contact_id).map((t) => t.name);
  assert.ok(tags.includes('Veio do anúncio'));
  assert.equal(JSON.parse(one("select data from events where entity = 'lead' and entity_id = ? and type = 'lead_added'", conv.lead_id).data).source, 'anuncio');
  assert.match(one("select body from notes where entity = 'lead' and entity_id = ?", conv.lead_id).body, /anúncio do Facebook[\s\S]*Sinal GPS com até 50% off[\s\S]*120252076903650189/);
  assert.equal(one('select flow_id from flow_runs where conversation_id = ? order by id desc', conv.id).flow_id, flow.id);
  assert.equal(c.sent.at(-1).content, 'Oii tudo bem? Qual modelo da sua antena e do seu monitor?');
  const dash = (await call('admin', 'GET', '/api/dashboard?days=7')).body;
  assert.ok(!dash.sources || dash.sources.some((s) => s.source === 'anuncio'));

  // mensagem comum (sem anúncio): sem etiqueta, origem WhatsApp, fluxo do anúncio não roda
  c.emit('message', msg('556798880002@c.us', 'Boa tarde', 'plain-1'));
  await wait(30); await flush();
  const conv2 = one("select * from conversations where external_id = '556798880002'");
  assert.equal(one("select count(*) n from entity_tags et join tags t on t.id = et.tag_id where et.entity = 'contact' and et.entity_id = ? and t.name = 'Veio do anúncio'", conv2.contact_id).n, 0);
  assert.equal(JSON.parse(one("select data from events where entity = 'lead' and entity_id = ? and type = 'lead_added'", conv2.lead_id).data).source, 'whatsapp');
  assert.equal(one('select count(*) n from flow_runs where conversation_id = ?', conv2.id).n, 0);

  // CRM estava fechado: ao reconectar, puxa quem escreveu nesse meio tempo (grupo e mensagem velha ficam de fora)
  const chId = one("select id from channels where json_extract(config, '$.mode') = 'web'").id;
  setSetting(`waweb_seen:${chId}`, Date.now() - 3600e3);
  const old = { ...msg('556798880004@c.us', 'velha', 'old-1'), timestamp: ts() - 2 * 3600 };
  c.getChats = async () => [
    { id: { _serialized: '556798880003@c.us' }, isGroup: false, timestamp: ts(), fetchMessages: async () => [msg('556798880003@c.us', 'Vi o anúncio', 'night-1', AD)] },
    { id: { _serialized: '120363000@g.us' }, isGroup: true, timestamp: ts(), fetchMessages: async () => [msg('120363000@g.us', 'grupo', 'grp-1')] },
    { id: { _serialized: '556798880004@c.us' }, isGroup: false, timestamp: old.timestamp, fetchMessages: async () => [old] },
    // este você já respondeu pelo celular enquanto o CRM estava fechado: o robô não responde por cima
    { id: { _serialized: '556798880006@c.us' }, isGroup: false, timestamp: ts(), fetchMessages: async () => [
      msg('556798880006@c.us', 'Vi o anúncio, quanto custa?', 'night-6', AD),
      { ...msg('556798880006@c.us', 'Bom dia! Aqui é o Kleber, qual sua antena?', 'own-6'), fromMe: true, from: '556793300144@c.us', to: '556798880006@c.us' }] },
  ];
  const sentBefore = c.sent.length;
  c.emit('ready');
  await wait(60); await flush();
  const night = one("select * from conversations where external_id = '556798880003'");
  assert.ok(night && night.lead_id);
  const night6 = one("select * from conversations where external_id = '556798880006'");
  assert.ok(night6);
  assert.equal(one('select count(*) n from flow_runs where conversation_id = ?', night6.id).n, 0);
  assert.ok(!c.sent.slice(sentBefore).some((m) => m.chatId.startsWith('556798880006')));
  assert.equal(one("select direction from messages where external_id = 'own-6'")?.direction, 'out');
  assert.equal(one("select count(*) n from messages where external_id in ('grp-1', 'old-1')").n, 0);
  c.emit('ready'); await wait(40); // de novo: não duplica
  assert.equal(one("select count(*) n from messages where external_id = 'night-1'").n, 1);
  // Aviso do próprio WhatsApp (criptografia/sistema, sem texto) não vira conversa nem lead
  c.emit('message', { ...msg('556798880009@c.us', '', 'sys-1'), type: 'e2e_notification' });
  c.emit('message', { ...msg('556798880009@c.us', '', 'sys-2'), type: 'unknown_thing' });
  await wait(30); await flush();
  assert.equal(one("select count(*) n from messages where external_id in ('sys-1', 'sys-2')").n, 0);
  assert.equal(one("select count(*) n from conversations where external_id = '556798880009'").n, 0);
  // Anúncio com id interno do WhatsApp (LID) no lugar do telefone: troca pelo telefone quando dá; senão responde pelo próprio id
  c.getContactLidAndPhone = async ([id]) => [{ lid: id, pn: id === '227616573395131@lid' ? '556798880005@c.us' : undefined }];
  c.emit('message', msg('227616573395131@lid', 'Posso ter mais informações?', 'lid-1', AD));
  await wait(30); await flush();
  assert.ok(one("select id from conversations where external_id = '556798880005'"));
  assert.equal(c.sent.at(-1).chatId, '556798880005@c.us');
  c.emit('message', msg('227616573395999@lid', 'Quanto custa?', 'lid-2', AD));
  await wait(30); await flush();
  assert.ok(one("select id from conversations where external_id = '227616573395999@lid'"));
  assert.equal(c.sent.at(-1).chatId, '227616573395999@lid');
  delete c.getContactLidAndPhone;
  delete c.getChats;
  await call('admin', 'PATCH', `/api/flows/${flow.id}`, { active: false });
});

test('mudança para a nuvem: o PC entrega banco e arquivos; a nuvem só recebe com o código certo', async () => {
  const head = { 'x-crm': '1', cookie: jar.admin };
  const r = await realFetch(base + '/api/admin/export/db', { headers: head });
  assert.equal(r.status, 200);
  const dbBuf = Buffer.from(await r.arrayBuffer());
  assert.equal(dbBuf.subarray(0, 15).toString(), 'SQLite format 3');
  assert.ok(Array.isArray(await (await realFetch(base + '/api/admin/export/uploads', { headers: head })).json()));
  assert.equal((await realFetch(base + '/api/admin/export/db')).status, 401); // sem login
  // recebimento desligado sem RESTORE_TOKEN, e recusa código errado
  assert.equal((await realFetch(base + '/restore/upload/a.png', { method: 'POST', body: 'x' })).status, 403);
  process.env.RESTORE_TOKEN = 'codigo-de-teste-1234567890';
  assert.equal((await realFetch(base + '/restore/upload/a.png', { method: 'POST', headers: { 'x-restore-token': 'errado-errado-errado-errado' }, body: 'x' })).status, 403);
  const ok = { 'x-restore-token': 'codigo-de-teste-1234567890' };
  assert.equal((await realFetch(base + '/restore/upload/..%2F..%2Fx.js', { method: 'POST', headers: ok, body: 'x' })).status, 400);
  assert.equal((await realFetch(base + '/restore/upload/foto-1.png', { method: 'POST', headers: ok, body: 'png' })).status, 200);
  assert.equal(fs.readFileSync(path.join(process.env.DATA_DIR, 'uploads', 'foto-1.png'), 'utf8'), 'png');
  assert.equal((await realFetch(base + '/restore/db', { method: 'POST', headers: ok, body: 'não é banco' })).status, 400);
  assert.equal((await realFetch(base + '/restore/db', { method: 'POST', headers: ok, body: dbBuf })).status, 200);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'crm.db.restore')));
  fs.rmSync(path.join(process.env.DATA_DIR, 'crm.db.restore'));
  delete process.env.RESTORE_TOKEN;
});

test('WhatsApp Web: trava do Chrome de outro servidor é apagada antes de abrir', async () => {
  const { cleanStale } = await import('../server/waweb.js');
  const dir = path.join(process.env.DATA_DIR, 'whatsapp-web', 'session-canal77');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync('outra-maquina-123', path.join(dir, 'SingletonLock'));
  fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
  cleanStale(77);
  assert.ok(!fs.readdirSync(dir).includes('SingletonLock'));
  assert.ok(fs.existsSync(path.join(dir, 'Preferences'))); // a sessão (login) continua
});

test('resposta à campanha: automática ou só "ok" não é conversa de verdade', async () => {
  const { notARealReply } = await import('../server/flows.js');
  for (const t of ['ok', 'Ok!', 'OK obrigado', 'Tá bom', 'blz', 'Obrigada 🙏', '👍', 'Recebido', 'valeu',
    'Olá, obrigado por entrar em contato com a Fazenda Boa Vista! Em breve responderemos.', 'Esta é uma mensagem automática.',
    'Nosso horário de atendimento é de 8h às 18h.', 'Seja bem-vindo! Digite 1 para vendas']) assert.equal(notARealReply(t), true, t);
  for (const t of ['Oi', 'Sim', 'Tenho interesse', 'Quanto custa?', 'ok, tenho uma 372', 'Bom dia, qual o valor?', '']) assert.equal(notARealReply(t), false, t);
});

test('WhatsApp Web: desconectar apaga a sessão guardada mesmo com a página travada', async () => {
  const ch = one("select id from channels where kind = 'whatsapp' and config like '%\"mode\":\"web\"%'");
  await call('admin', 'POST', '/api/waweb'); // garante o canal ligado
  waFake.client.logout = async () => { throw new Error('página travada'); };
  const dir = path.join(process.env.DATA_DIR, 'whatsapp-web', `session-canal${ch.id}`);
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  assert.equal((await call('admin', 'POST', `/api/waweb/${ch.id}/logout`)).status, 200);
  assert.ok(!fs.existsSync(dir));
});

test('WhatsApp Web: ao desligar o CRM fecha o Chrome com calma; travou ao abrir = tenta de novo sozinho', async () => {
  const { stopAllWeb, webStatus } = await import('../server/waweb.js');
  const ch = one("select id from channels where kind = 'whatsapp' and config like '%\"mode\":\"web\"%'");
  await call('admin', 'POST', '/api/waweb');
  let destroyed = 0;
  waFake.client.destroy = async () => { destroyed++; };
  await stopAllWeb();
  assert.equal(destroyed, 1);
  assert.equal(webStatus(ch.id).state, 'off');
  // abrir falha (página do WhatsApp não carregou): fica em erro com o motivo, e não derruba nada
  const realInit = waFake.client.constructor.prototype.initialize;
  waFake.client.constructor.prototype.initialize = async () => { throw new Error('Waiting failed: 120000ms exceeded'); };
  await call('admin', 'POST', '/api/waweb');
  await settle();
  assert.equal(webStatus(ch.id).state, 'error');
  waFake.client.constructor.prototype.initialize = realInit;
  await stopAllWeb();
});

test('WhatsApp Web: marca de "apagar" antiga não apaga o login novo depois de conectar', async () => {
  const { stopAllWeb, cleanStale } = await import('../server/waweb.js');
  const ch = one("select id from channels where kind = 'whatsapp' and config like '%\"mode\":\"web\"%'");
  const dir = path.join(process.env.DATA_DIR, 'whatsapp-web', `session-canal${ch.id}`);
  await call('admin', 'POST', '/api/waweb');
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(`${dir}.limpar`, 'antiga'); // sobrou de um desconectar que falhou
  waFake.client.emit('ready'); // leu o QR: login novo
  await stopAllWeb();
  cleanStale(ch.id); // próximo reinício
  assert.ok(fs.existsSync(path.join(dir, 'Default')));
});

test('WhatsApp Web: reabrir só o WhatsApp sem sair da conta', async () => {
  const ch = one("select id from channels where kind = 'whatsapp' and config like '%\"mode\":\"web\"%'");
  await call('admin', 'POST', '/api/waweb');
  let destroyed = 0, loggedOut = 0;
  waFake.client.destroy = async () => { destroyed++; };
  waFake.client.logout = async () => { loggedOut++; };
  const r = await call('admin', 'POST', `/api/waweb/${ch.id}/restart`);
  assert.equal(r.status, 200);
  assert.equal(destroyed, 1);
  assert.equal(loggedOut, 0);
  assert.equal((await call('admin', 'POST', '/api/waweb/99999/restart')).status, 404);
});

test('WhatsApp Web: QR vencido (parado há mais de 1 min) é renovado sozinho quando a tela consulta', async () => {
  const { refreshStaleQr, webStatus, stopAllWeb } = await import('../server/waweb.js');
  const ch = one("select id from channels where kind = 'whatsapp' and config like '%\"mode\":\"web\"%'");
  await stopAllWeb();
  await call('admin', 'POST', '/api/waweb');
  await new Promise((r) => setTimeout(r, 20)); // o falso manda o QR
  const before = waFake.client;
  assert.equal(webStatus(ch.id).state, 'qr');
  assert.equal(refreshStaleQr(ch.id), false); // QR recente: não mexe
  assert.equal(refreshStaleQr(ch.id, -1), true); // "vencido": recomeça
  await new Promise((r) => setTimeout(r, 30));
  assert.notEqual(waFake.client, before);
  assert.equal(webStatus(ch.id).state, 'qr');
  await stopAllWeb();
});

test('vários números: conectar outro WhatsApp (Paraguai) com QR próprio, sem mexer no primeiro', async () => {
  const { webStatus, stopAllWeb } = await import('../server/waweb.js');
  await stopAllWeb();
  const br = (await call('admin', 'POST', '/api/waweb')).body;
  const py = (await call('admin', 'POST', '/api/waweb', { novo: true, name: 'Paraguai' })).body;
  assert.notEqual(py.id, br.id);
  const ch = one('select * from channels where id = ?', py.id);
  assert.equal(ch.name, 'Paraguai');
  assert.equal(JSON.parse(ch.config).mode, 'web');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(webStatus(py.id).state, 'qr');
  assert.equal(webStatus(br.id).state, 'qr');
  // conectar de novo um número específico
  assert.equal((await call('admin', 'POST', '/api/waweb', { channel_id: py.id })).body.id, py.id);
  assert.equal((await call('admin', 'POST', '/api/waweb', { channel_id: 999999 })).status, 404);
  // a campanha escolhe por qual número sai
  const c = (await call('admin', 'POST', '/api/campaigns', { name: 'PY', channel: 'whatsapp', tags: ['x'], body: 'Hola', wa_channel_id: py.id, window_start: 0, window_end: 24 })).body;
  assert.equal(one('select wa_channel_id from campaigns where id = ?', c.id).wa_channel_id, py.id);
  await stopAllWeb();
  run("update channels set status = 'disabled' where id = ?", py.id);
});

test('IA responde no idioma do cliente', async () => {
  const { aiAgent } = await import('../server/ai.js');
  aiAnswers = ['{"resposta":"¡Hola! ¿Qué modelo de antena y monitor usa?","tabelas":[],"acao":"continuar"}'];
  const r = await aiAgent([{ direction: 'in', body: 'Hola, cuánto cuesta la señal?' }], { items: [] });
  assert.match(anthropic.at(-1).body.system, /idioma em que o cliente escreveu/);
  assert.equal(r.reply, '¡Hola! ¿Qué modelo de antena y monitor usa?');
});

test('fluxo de um número só (Paraguai, tabelas em dólar) passa na frente do fluxo geral; os outros números seguem no geral', async () => {
  const { flowOnInbound } = await import('../server/flows.js');
  const clone = (table, row, over) => {
    const r = { ...row, ...over }; delete r.id;
    const k = Object.keys(r);
    return Number(run(`insert into ${table}(${k.join(',')}) values(${k.map(() => '?').join(',')})`, ...k.map((x) => r[x])).lastInsertRowid);
  };
  const base = one("select c.* from conversations c join channels ch on ch.id = c.channel_id where ch.kind = 'whatsapp' order by c.id desc limit 1");
  const chRow = one('select * from channels where id = ?', base.channel_id);
  const py = clone('channels', chRow, { name: 'Paraguai (teste)', external_id: `web-py-${Date.now()}`, status: 'active' });
  const convPy = clone('conversations', base, { channel_id: py, external_id: '595976000001', status: 'open' });
  const convBr = clone('conversations', base, { external_id: '5567900000001', status: 'open' });
  const g = JSON.stringify({ nodes: [{ id: 'start', type: 'start', data: {} }, { id: 'end', type: 'end', data: {} }], edges: [{ from: 'start', port: 'next', to: 'end' }] });
  const mk = (name, tc) => Number(run("insert into flows(name, trigger, trigger_config, active, graph, created_at, updated_at, brand_id) values(?, 'ad_click', ?, 1, ?, 0, 0, ?)",
    name, JSON.stringify(tc), g, chRow.brand_id ?? 1).lastInsertRowid);
  const geral = mk('Anúncio geral (teste)', { channel: 'whatsapp' });
  const soPy = mk('Anúncio Paraguai em dólar (teste)', { channel: 'whatsapp', channel_id: py });
  await flowOnInbound({ conversationId: convPy, text: 'Hola, quiero más información', fromAd: true });
  await flowOnInbound({ conversationId: convBr, text: 'Olá, quero mais informações', fromAd: true });
  assert.equal(one('select flow_id from flow_runs where conversation_id = ?', convPy).flow_id, soPy);
  assert.notEqual(one('select flow_id from flow_runs where conversation_id = ?', convBr).flow_id, soPy);
  run('update flows set active = 0 where id in (?, ?)', geral, soPy);
  run("update channels set status = 'disabled' where id = ?", py);
});

test('IA espera uns segundos antes de responder; se uma pessoa assumir nesse meio tempo, o robô não entra', async () => {
  const { flowOnInbound, flowOnHuman } = await import('../server/flows.js');
  const clone = (table, row, over) => {
    const r = { ...row, ...over }; delete r.id;
    const k = Object.keys(r);
    return Number(run(`insert into ${table}(${k.join(',')}) values(${k.map(() => '?').join(',')})`, ...k.map((x) => r[x])).lastInsertRowid);
  };
  const baseConv = one("select c.* from conversations c join channels ch on ch.id = c.channel_id where ch.kind = 'whatsapp' order by c.id desc limit 1");
  const conv = clone('conversations', baseConv, { external_id: '5567900000077', status: 'open' });
  run("insert into messages(conversation_id, direction, kind, body, status, created_at) values(?, 'in', 'text', 'Quanto custa?', 'delivered', ?)", conv, Date.now());
  const g = JSON.stringify({ nodes: [{ id: 'start', type: 'start', data: {} }, { id: 'ia', type: 'ai_agent', data: { items: [], max_turns: 6, timeout_hours: 1 } }, { id: 'h', type: 'handoff', data: {} }],
    edges: [{ from: 'start', port: 'next', to: 'ia' }, { from: 'ia', port: 'humano', to: 'h' }, { from: 'ia', port: 'enviou', to: 'h' }] });
  const ch = one('select * from channels where id = ?', baseConv.channel_id);
  const fid = Number(run("insert into flows(name, trigger, trigger_config, active, graph, created_at, updated_at, brand_id) values('IA com pausa (teste)', 'ad_click', ?, 1, ?, 0, 0, ?)",
    JSON.stringify({ channel_id: ch.id }), g, ch.brand_id ?? 1).lastInsertRowid);
  process.env.AI_REPLY_DELAY = '0.3';
  const calls = anthropic.length;
  const t0 = Date.now();
  const p = flowOnInbound({ conversationId: conv, text: 'Quanto custa?', fromAd: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(one('select state from flow_runs where conversation_id = ?', conv).state, 'running'); // "digitando..."
  flowOnHuman(conv); // o Kleber respondeu pelo celular
  await p;
  assert.ok(Date.now() - t0 >= 250);
  assert.equal(anthropic.length, calls); // nem chamou a IA
  assert.equal(one('select state from flow_runs where conversation_id = ?', conv).state, 'stopped');
  assert.equal(one("select count(*) n from messages where conversation_id = ? and direction = 'out'", conv).n, 0);
  process.env.AI_REPLY_DELAY = '0';
  run('update flows set active = 0 where id = ?', fid);
});

test('número do Paraguai: atendente escreve em português e sai em espanhol; motor escolhido por número', async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ch = (await call('admin', 'POST', '/api/waweb', { novo: true, name: 'Paraguai (teste)' })).body;
  await wait(20);
  waFake.client.emit('ready');
  const cli = waFake.client;
  // tradução ligada só neste número
  assert.equal((await call('admin', 'POST', `/api/waweb/${ch.id}/options`, { translate_to: 'es' })).status, 200);
  assert.equal((await call('admin', 'POST', `/api/waweb/${ch.id}/options`, { translate_to: 'fr' })).status, 400);
  const me = (await call('admin', 'GET', '/api/me')).body.channels.find((c) => c.id === ch.id);
  assert.deepEqual([me.translate_to, me.engine], ['es', 'wwebjs']);
  // cliente paraguaio escreve
  cli.emit('message', { from: '595976000123@c.us', to: '556793300144@c.us', body: 'Hola, quiero saber el precio de la señal', type: 'chat', id: { _serialized: 'py-1' },
    timestamp: Math.floor(Date.now() / 1000), fromMe: false, hasMedia: false, getContact: async () => ({ number: '595976000123', pushname: 'Juan' }) });
  await wait(30); await flush();
  const conv = one("select c.* from conversations c where c.channel_id = ? order by id desc limit 1", ch.id);
  assert.ok(conv);
  run("update conversations set status = 'open' where id = ?", conv.id);
  const calls = anthropic.length;
  aiAnswers = ['¡Hola Juan! ¿Cuál es el modelo de su antena?'];
  const r = await call('admin', 'POST', `/api/conversations/${conv.id}/messages`, { text: 'Olá Juan! Qual o modelo da sua antena?' });
  assert.equal(r.status, 200);
  assert.equal(anthropic.length, calls + 1);
  assert.match(anthropic.at(-1).body.system, /espanhol/);
  assert.match(anthropic.at(-1).body.system, /quiero saber el precio/); // olha a língua do cliente
  assert.deepEqual([r.body.body, r.body.original_body], ['¡Hola Juan! ¿Cuál es el modelo de su antena?', 'Olá Juan! Qual o modelo da sua antena?']);
  assert.equal(cli.sent.at(-1).content, '¡Hola Juan! ¿Cuál es el modelo de su antena?');
  // número sem tradução: vai como escrito, sem chamar a IA
  await call('admin', 'POST', `/api/waweb/${ch.id}/options`, { translate_to: '' });
  const r2 = await call('admin', 'POST', `/api/conversations/${conv.id}/messages`, { text: 'Obrigado!' });
  assert.deepEqual([r2.body.body, r2.body.original_body, anthropic.length], ['Obrigado!', null, calls + 1]);
  // trocar o motor do número: desconecta e pede QR de novo
  const st = (await call('admin', 'POST', `/api/waweb/${ch.id}/options`, { engine: 'baileys' })).body;
  assert.ok(['starting', 'qr'].includes(st.state));
  assert.equal((await call('admin', 'GET', '/api/me')).body.channels.find((c) => c.id === ch.id).engine, 'baileys');
  assert.equal((await call('admin', 'POST', `/api/waweb/${ch.id}/options`, { engine: 'outro' })).status, 400);
  run("update channels set status = 'disabled' where id = ?", ch.id);
});

test('excluir conversa: some com as mensagens; lead não triado sai junto, lead aceito fica; vendedor não exclui', async () => {
  await webhook(waMsg('wamid.del1', '5511977770001', 'Teste para apagar', 'Teste Apagar'));
  await webhook(waMsg('wamid.del2', '5511977770002', 'Cliente de verdade', 'Cliente Real'));
  await settle();
  const c1 = one("select * from conversations where external_id = '5511977770001'");
  const c2 = one("select * from conversations where external_id = '5511977770002'");
  assert.ok([401, 403].includes((await call('beto', 'DELETE', `/api/conversations/${c1.id}`)).status));
  assert.equal(one('select count(*) n from conversations where id = ?', c1.id).n, 1);
  const r = await call('admin', 'DELETE', `/api/conversations/${c1.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.lead_removed, true);
  assert.equal(one('select count(*) n from conversations where id = ?', c1.id).n, 0);
  assert.equal(one('select count(*) n from messages where conversation_id = ?', c1.id).n, 0);
  assert.ok(one('select deleted_at from leads where id = ?', c1.lead_id).deleted_at);
  assert.ok(one('select id from contacts where id = ? and deleted_at is null', c1.contact_id)); // contato fica

  await call('admin', 'POST', `/api/conversations/${c2.id}/accept`);
  assert.equal((await call('admin', 'DELETE', `/api/conversations/${c2.id}`)).body.lead_removed, false);
  assert.equal(one('select deleted_at from leads where id = ?', c2.lead_id).deleted_at, null); // lead aceito continua no funil
  assert.equal((await call('admin', 'DELETE', `/api/conversations/${c2.id}`)).status, 404);

  // a pessoa escreve de novo: nova conversa normal
  await webhook(waMsg('wamid.del3', '5511977770002', 'Voltei'));
  await settle();
  const c3 = one("select * from conversations where external_id = '5511977770002'");
  assert.equal(c3.lead_id, c2.lead_id);
});

test('respostas prontas: padrão da AgroVox, admin edita por empresa, vendedor não edita', async () => {
  let me = (await call('admin', 'GET', '/api/me')).body;
  assert.deepEqual(me.quick_replies.map((r) => r.title), ['Site', 'Pagamento no cartão', 'Pagamento em cripto', 'Sinais Trimble (diferença)']);
  assert.match(me.quick_replies[0].es, /Conozca/);
  const r = await call('admin', 'PUT', '/api/quick-replies', [{ title: ' PIX ', pt: 'Chave PIX: contato@agro-vox.com', es: '' }, { title: 'vazia', pt: '', es: '' }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{ title: 'PIX', pt: 'Chave PIX: contato@agro-vox.com', es: '' }]); // sem texto sai da lista
  me = (await call('admin', 'GET', '/api/me')).body;
  assert.equal(me.quick_replies.length, 1);
  assert.equal((await call('admin', 'PUT', '/api/quick-replies', [{ title: '', pt: 'sem nome' }])).status, 400);
  // AgroPool (empresa 2) tem a lista dela, começa vazia
  assert.deepEqual((await call('admin', 'GET', '/api/me', undefined, { 'x-brand': '2' })).body.quick_replies, []);
  assert.ok([401, 403].includes((await call('beto', 'PUT', '/api/quick-replies', [])).status));
});

test('filtro rápido das conversas por número: Brasil, espanhol, e-mail', async () => {
  const mk = (name, ext, cfg, kind = 'whatsapp') => Number(run('insert into channels(kind, name, external_id, config, created_at) values(?, ?, ?, ?, ?)', kind, name, ext, JSON.stringify(cfg), Date.now()).lastInsertRowid);
  const es = mk('Paraguai', 'web-via-es', { mode: 'web', translate_to: 'es' });
  const contact = one('select id from contacts limit 1').id;
  run("insert into conversations(channel_id, contact_id, external_id, last_message_at, created_at) values(?, ?, 'via-es-1', ?, ?)", es, contact, Date.now(), Date.now());
  const me = (await call('admin', 'GET', '/api/me')).body;
  assert.equal(me.channels.find((c) => c.id === es).group, 'es');
  const only = (await call('admin', 'GET', '/api/conversations?via=es')).body;
  assert.ok(only.length >= 1 && only.every((c) => c.channel_name === 'Paraguai'));
  const br = (await call('admin', 'GET', '/api/conversations?via=br')).body;
  assert.ok(br.length >= 1 && br.every((c) => c.channel_name !== 'Paraguai' && c.channel !== 'email'));
  assert.deepEqual((await call('admin', 'GET', '/api/conversations?via=en')).body, []); // ainda sem número dos EUA
});

test('respostas prontas com a tabela do número e "Traduzir para português" na mensagem do cliente', async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ch = (await call('admin', 'POST', '/api/waweb', { novo: true, name: 'Paraguai (tabelas)' })).body;
  await wait(20);
  waFake.client.emit('ready');
  const cli = waFake.client;
  await call('admin', 'POST', `/api/waweb/${ch.id}/options`, { translate_to: 'es' });
  cli.emit('message', { from: '595976000999@c.us', to: '556793300144@c.us', body: 'Hola, tengo una StarFire 6000', type: 'chat', id: { _serialized: 'py-tab-1' },
    timestamp: Math.floor(Date.now() / 1000), fromMe: false, hasMedia: false, getContact: async () => ({ number: '595976000999', pushname: 'Pedro' }) });
  await wait(30); await flush();
  const conv = one('select * from conversations where channel_id = ? order by id desc limit 1', ch.id);
  const msg = one("select * from messages where external_id = 'py-tab-1'");

  // tabelas: as do fluxo ligado daquele número (em dólar) passam na frente das do fluxo geral
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const up = async (n) => (await (await fetch(base + '/api/files', { method: 'POST', headers: { 'x-crm': '1', cookie: jar.admin, 'content-type': 'image/png', 'x-filename': n }, body: png })).json()).id;
  const usd = await up('starfire-6000-usd.png');
  const graph = (items) => JSON.stringify({ nodes: [{ id: 's', type: 'start', data: {} }, { id: 'ia', type: 'ai_agent', data: { items, max_turns: 6, timeout_hours: 1 } }], edges: [] });
  const fid = Number(run("insert into flows(name, trigger, trigger_config, active, graph, created_at, updated_at) values('PY tabelas', 'ad_click', ?, 1, ?, 0, 0)",
    JSON.stringify({ channel_id: ch.id }), graph([{ name: 'StarFire 6000 (USD)', file_id: usd }])).lastInsertRowid);
  const tables = (await call('admin', 'GET', `/api/conversations/${conv.id}/tables`)).body;
  assert.deepEqual(tables, [{ name: 'StarFire 6000 (USD)', file_id: usd }]);
  run('update flows set active = 0 where id = ?', fid);

  // mandar a tabela (imagem já salva), sem subir de novo; sem texto não chama a IA
  const calls = anthropic.length;
  const r = await call('admin', 'POST', `/api/conversations/${conv.id}/messages`, { text: '', file_id: usd });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.kind, r.body.file_id], ['image', usd]);
  assert.equal(cli.sent.at(-1).content.mime, 'image/png');
  assert.equal(anthropic.length, calls);
  assert.equal((await call('admin', 'POST', `/api/conversations/${conv.id}/messages`, { text: 'x', file_id: 999999 })).status, 404);

  // traduzir a mensagem do cliente para português (uma vez só; a segunda vem guardada)
  aiAnswers = ['Olá, tenho uma StarFire 6000'];
  const t = await call('admin', 'POST', `/api/messages/${msg.id}/translate`);
  assert.equal(t.body.text, 'Olá, tenho uma StarFire 6000');
  assert.match(anthropic.at(-1).body.system, /português do Brasil/);
  const n = anthropic.length;
  assert.equal((await call('admin', 'POST', `/api/messages/${msg.id}/translate`)).body.text, 'Olá, tenho uma StarFire 6000');
  assert.equal(anthropic.length, n);
  assert.equal((await call('admin', 'GET', `/api/conversations/${conv.id}`)).body.messages.find((m) => m.id === msg.id).translated_body, 'Olá, tenho uma StarFire 6000');
  await call('admin', 'POST', `/api/waweb/${ch.id}/options`, { translate_to: '' });
});
