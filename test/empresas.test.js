// Produto para várias empresas: cada empresa tem o próprio banco e nunca enxerga a outra.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-empresas-'));
process.env.AI_REPLY_DELAY = '0';
const { app } = await import('../server/app.js');
const db = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');

let server, base;
const jar = {};
async function call(who, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-crm': '1', ...(jar[who] ? { cookie: jar[who] } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie');
  if (c) jar[who] = c.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
// Empresa nova, do jeito que o comando "nova-empresa" cria.
function novaEmpresa(name, email) {
  const id = db.createAccount(name);
  db.inAccount(id, () => db.run("insert into users(name, email, pass_hash, role_id, is_admin, created_at) values('Dono', ?, ?, (select id from roles where name = 'Gerente'), 1, ?)",
    email, hashPassword('senha-forte-1'), Date.now()));
  return id;
}

let A, B;
before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = 1;
  assert.equal((await call('a', 'POST', '/api/setup', { name: 'Ana', email: 'ana@empresa-a.com', password: 'senha-forte-1' })).status, 200);
  B = novaEmpresa('Loja B', 'bia@empresa-b.com');
  assert.equal((await call('b', 'POST', '/api/login', { email: 'bia@empresa-b.com', password: 'senha-forte-1' })).status, 200);
});
after(() => server.close());

test('cada empresa tem a própria pasta e o próprio banco', () => {
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'contas', String(A), 'crm.db')));
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'contas', String(B), 'crm.db')));
  assert.deepEqual(db.accountIds(), [A, B]);
  // empresa nova começa limpa: uma marca só, com o nome dela, e nenhum cliente da outra
  const brands = db.inAccount(B, () => db.all('select name from brands'));
  assert.deepEqual(brands.map((b) => b.name), ['Loja B']);
});

test('lead e contato de uma empresa não aparecem na outra', async () => {
  const lead = (await call('a', 'POST', '/api/leads', { name: 'Segredo da A', contact: { name: 'Cliente A', phone: '11987654321' } })).body.id;
  assert.ok(lead);
  assert.ok((await call('a', 'GET', '/api/leads')).body.some((l) => l.name === 'Segredo da A'));
  assert.ok(!(await call('b', 'GET', '/api/leads')).body.some((l) => l.name === 'Segredo da A'));
  assert.ok(!(await call('b', 'GET', '/api/contacts')).body.some((c) => c.name === 'Cliente A'));
  // mesmo número de lead na B não é o lead da A
  const r = await call('b', 'GET', `/api/leads/${lead}`);
  assert.ok(r.status === 404 || r.body?.name !== 'Segredo da A');
  // cada uma só vê a própria equipe
  assert.deepEqual((await call('b', 'GET', '/api/me')).body.user.email, 'bia@empresa-b.com');
});

test('cookie trocado de empresa não entra', async () => {
  const [, token] = jar.b.split('=')[1].split('.');
  const r = await fetch(base + '/api/me', { headers: { cookie: `sid=${A}.${token}` } });
  assert.equal(r.status, 401);
  const r2 = await fetch(base + '/api/me', { headers: { cookie: `sid=999.${token}` } });
  assert.equal(r2.status, 401);
});

test('o mesmo e-mail não fica em duas empresas', async () => {
  assert.equal((await call('b', 'POST', '/api/users', { name: 'X', email: 'ANA@empresa-a.com', password: 'senha-forte-1' })).status, 409);
});

test('aviso de tela (tempo real) só vai para a própria empresa', async () => {
  const ctl = new AbortController();
  const res = await fetch(base + '/api/stream', { headers: { cookie: jar.b }, signal: ctl.signal });
  const reader = res.body.getReader();
  let got = '';
  const reading = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; got += Buffer.from(value).toString(); } } catch {} })();
  await call('a', 'POST', '/api/leads', { name: 'Outro da A' });
  await new Promise((r) => setTimeout(r, 300));
  ctl.abort();
  await reading;
  assert.ok(!got.includes('"type"'), got);
});

test('webhook da Meta: cada empresa no seu endereço', async () => {
  const tokB = db.inAccount(B, () => db.getSetting('meta').verify_token);
  const ok = await fetch(`${base}/webhooks/meta/${B}?hub.mode=subscribe&hub.verify_token=${tokB}&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  assert.equal((await fetch(`${base}/webhooks/meta/${A}?hub.mode=subscribe&hub.verify_token=${tokB}&hub.challenge=42`)).status, 403);
  assert.equal((await fetch(`${base}/webhooks/meta/77?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)).status, 404);
});

test('"sair da lista" leva a empresa no link', async () => {
  const { unsubToken } = await import('../server/outbound.js');
  const cid = db.inAccount(B, () => Number(db.run("insert into contacts(name, created_at, updated_at) values('Cli B', 0, 0)").lastInsertRowid));
  const link = `c${B}-${db.inAccount(B, () => unsubToken(cid, 1))}`;
  assert.match(await (await fetch(`${base}/sair/${link}`)).text(), /Pronto, você saiu/);
  assert.ok(db.inAccount(B, () => db.one('select 1 from contact_optouts where contact_id = ?', cid)));
  assert.ok(!db.inAccount(A, () => db.one('select 1 from contact_optouts where contact_id = ?', cid)));
});

test('com mais de uma empresa, código sem empresa definida é barrado', () => {
  assert.throws(() => db.one('select 1'), /sem empresa/);
});

test('Semeia de uma empresa só (AgroVox): os dados da raiz são a empresa nº 1, sem mudar de lugar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-antigo-'));
  // banco do jeito que está hoje na AgroVox: migrações até a 011, com usuário cadastrado
  const old = new DatabaseSync(path.join(dir, 'crm.db'));
  old.exec('pragma foreign_keys = off; create table migrations (name text primary key, at integer not null)');
  const mdir = path.resolve('server/migrations');
  for (const f of fs.readdirSync(mdir).filter((f) => f.endsWith('.sql') && f < '012').sort()) {
    old.exec(fs.readFileSync(path.join(mdir, f), 'utf8'));
    old.prepare('insert into migrations values(?, 0)').run(f);
  }
  old.exec("insert into users(name, email, pass_hash, is_admin, created_at) values('Kleber', 'k@agro-vox.com', 'x', 1, 0)");
  old.exec("create table marca(x text); insert into marca values('dados da agrovox')");
  old.close();
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(path.join(dir, 'uploads', 'foto.png'), 'png');
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `const d = await import(${JSON.stringify(path.resolve('server/db.js'))}); console.log(JSON.stringify(d.inAccount(1, () => ({ ...d.one('select x from marca'), perfil: d.getSetting('perfil'), email: d.one('select email from users').email }))));`],
  { env: { ...process.env, DATA_DIR: dir } }).toString();
  const r = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(r.x, 'dados da agrovox');
  assert.equal(r.email, 'k@agro-vox.com'); // mesmo login de antes
  assert.equal(r.perfil, 'agrovox'); // tudo continua do jeito da AgroVox
  // nada sai do lugar: a versão antiga continuaria achando tudo onde sempre esteve
  assert.ok(fs.existsSync(path.join(dir, 'uploads', 'foto.png')));
  assert.ok(fs.existsSync(path.join(dir, 'crm.db')));
  assert.ok(!fs.existsSync(path.join(dir, 'contas', '1', 'crm.db')));
});

test('empresa nova nasce neutra: sem tabelas, fluxos, respostas ou nomes da AgroVox', async () => {
  const { initFlows } = await import('../server/flows.js');
  const { adContactName } = await import('../server/inbound.js');
  const { firstName } = await import('../server/outbound.js');
  db.inAccount(B, () => {
    initFlows();
    assert.equal(db.one('select count(*) n from flows').n, 0);
    assert.doesNotMatch(db.getSetting('ai').knowledge, /AgroVox|StarFire|antena/i);
    assert.equal(adContactName('Maria Souza', '5511999990000'), 'Maria Souza');
    assert.equal(firstName('Agro Eduardo'), 'Agro'); // "Agro" só é prefixo no perfil da AgroVox
  });
  const me = (await call('b', 'GET', '/api/me')).body;
  assert.deepEqual(me.quick_replies, []);
  assert.doesNotMatch(JSON.stringify(me), /agro-vox|StarFire|Trimble/i);
  // o banco que já existia (AgroVox) continua com o perfil dela
  assert.equal(db.inAccount(A, () => db.getSetting('perfil', 'padrao')), 'padrao'); // A aqui é instalação nova de teste
});

test('cadastro pelo site: fechado por padrão; aberto cria a empresa no teste grátis', async () => {
  const f = { company: 'Padaria Sol', name: 'Rui', email: 'rui@padaria.com', password: 'senha-forte-1', plan: 'profissional', terms: true };
  assert.equal((await call('rui', 'POST', '/api/signup', f)).status, 403);
  process.env.CADASTRO_ABERTO = '1';
  try {
    assert.equal((await call('rui', 'POST', '/api/signup', { ...f, terms: false })).status, 400);
    assert.equal((await call('rui', 'POST', '/api/signup', { ...f, email: 'ana@empresa-a.com' })).status, 409);
    assert.equal((await call('rui', 'POST', '/api/signup', f)).status, 200);
    const me = (await call('rui', 'GET', '/api/me')).body;
    assert.equal(me.general.company, 'Padaria Sol');
    assert.equal(me.billing.status, 'teste');
    assert.equal(me.billing.trial_days_left, 7);
    assert.deepEqual(me.quick_replies, []);
    // limite do plano: Profissional = 5 usuários
    for (let i = 1; i <= 4; i++) assert.equal((await call('rui', 'POST', '/api/users', { name: `U${i}`, email: `u${i}@padaria.com`, password: 'senha-forte-1' })).status, 200);
    assert.equal((await call('rui', 'POST', '/api/users', { name: 'U5', email: 'u5@padaria.com', password: 'senha-forte-1' })).status, 402);
    // teste acabou: só a tela do plano funciona; os dados ficam
    const { platform, accountIds } = db;
    const acc = accountIds().at(-1);
    platform.prepare('update accounts set trial_until = ? where id = ?').run(Date.now() - 1000, acc);
    assert.equal((await call('rui', 'GET', '/api/leads')).status, 402);
    const me2 = (await call('rui', 'GET', '/api/me')).body;
    assert.equal(me2.billing.blocked, true);
    // AgroVox (interna) nunca é bloqueada
    assert.equal((await call('a', 'GET', '/api/leads')).status, 200);
    assert.equal((await call('a', 'GET', '/api/me')).body.billing.plan, 'interno');
  } finally { delete process.env.CADASTRO_ABERTO; }
});

test('aviso do Mercado Pago ativa a assinatura só depois de conferir na API dele', async () => {
  const { syncSubscription } = await import('../server/billing.js');
  const acc = db.accountIds().at(-1);
  process.env.MP_ACCESS_TOKEN = 'TEST-token';
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).startsWith('https://api.mercadopago.com/preapproval/')
    ? new Response(JSON.stringify({ id: 'PRE1', status: 'authorized', external_reference: `${acc}:empresa` }), { status: 200 })
    : real(url, init);
  try {
    const r = await fetch(`${base}/webhooks/mercadopago`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'subscription_preapproval', data: { id: 'PRE1' } }) });
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 100));
    const row = db.platform.prepare('select plan, status from accounts where id = ?').get(acc);
    assert.deepEqual({ ...row }, { plan: 'empresa', status: 'ativo' });
    assert.equal((await call('rui', 'GET', '/api/leads')).status, 200); // voltou a usar
    assert.equal(await syncSubscription('PRE1').then((x) => x.status), 'ativo');
  } finally { globalThis.fetch = real; delete process.env.MP_ACCESS_TOKEN; }
});

test('assistente: faz no CRM com o login de quem pediu (tarefa criada na empresa certa)', async () => {
  db.inAccount(A, () => db.setSetting('ai', { ...db.getSetting('ai', {}), api_key: 'sk-ant-teste' }));
  const lead = db.inAccount(A, () => db.one("select id from leads where name = 'Segredo da A'").id);
  const real = globalThis.fetch;
  const seen = [];
  let step = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return real(url, init);
    seen.push(JSON.parse(init.body));
    step++;
    const content = step === 1
      ? [{ type: 'tool_use', id: 't1', name: 'buscar_leads', input: { busca: 'Segredo' } }]
      : step === 2 ? [{ type: 'tool_use', id: 't2', name: 'criar_tarefa', input: { lead_id: lead, texto: 'Ligar para o cliente', quando: '2026-11-26T09:00' } }]
      : [{ type: 'text', text: 'Pronto, criei a tarefa para amanhã às 9h.' }];
    return new Response(JSON.stringify({ content, stop_reason: step < 3 ? 'tool_use' : 'end_turn' }), { status: 200 });
  };
  try {
    const r = await call('a', 'POST', '/api/assistente', { messages: [{ role: 'user', content: 'cria tarefa de ligar pro Segredo amanhã 9h' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.reply, /criei a tarefa/);
    assert.equal(r.body.actions.length, 1);
    // a busca voltou o lead da própria empresa
    const toolResult = seen[1].messages.at(-1).content[0].content;
    assert.match(toolResult, /Segredo da A/);
    const t = db.inAccount(A, () => db.one("select * from tasks where entity = 'lead' and entity_id = ?", lead));
    assert.equal(t.text, 'Ligar para o cliente');
    assert.equal(new Date(t.due_at).toISOString(), '2026-11-26T12:00:00.000Z'); // 9h de Brasília
    // só tem ações seguras: nada de enviar mensagem, campanha ou apagar
    const names = seen[0].tools.map((x) => x.name);
    assert.ok(!names.some((n) => /enviar|mensagem|campanha|apagar|excluir/.test(n)), names.join(','));
    // empresa sem chave: avisa em vez de quebrar
    const rb = await call('b', 'POST', '/api/assistente', { messages: [{ role: 'user', content: 'oi' }] });
    assert.equal(rb.status, 400);
  } finally { globalThis.fetch = real; }
});

test('conector do Claude (MCP): link secreto da pessoa, mesmas ações seguras, desligável', async () => {
  const { url } = (await call('a', 'POST', '/api/mcp-link')).body;
  const path = new URL(url).pathname;
  const rpc = (body, p = path) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } } })).json();
  assert.equal(init.result.serverInfo.name, 'Fechaê');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('buscar_leads') && names.includes('criar_tarefa'));
  assert.ok(!names.some((n) => /enviar|campanha|apagar/.test(n)));
  const found = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'buscar_leads', arguments: { busca: 'Segredo' } } })).json();
  assert.match(found.result.content[0].text, /Segredo da A/);
  // link trocado de empresa ou inventado não entra
  const [acc, tok] = path.split('/').pop().split('.');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, `/mcp/${B}.${tok}`)).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, `/mcp/${acc}.${'0'.repeat(64)}`)).status, 401);
  // desligar: o link para de funcionar
  await call('a', 'DELETE', '/api/mcp-link');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' })).status, 401);
});

test('assistente: resposta ao cliente é só rascunho; quem envia é a pessoa', async () => {
  const real = globalThis.fetch;
  const seen = [];
  let step = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return real(url, init);
    seen.push(JSON.parse(init.body));
    step++;
    const content = step === 1 ? [{ type: 'tool_use', id: 'p1', name: 'propor_resposta', input: { conversa_id: 99999, texto: 'Oi! Segue a tabela.' } }]
      : [{ type: 'text', text: 'Não achei essa conversa.' }];
    return new Response(JSON.stringify({ content, stop_reason: step === 1 ? 'tool_use' : 'end_turn' }), { status: 200 });
  };
  try {
    const before = db.inAccount(A, () => db.one('select count(*) n from messages').n);
    const r = await call('a', 'POST', '/api/assistente', { messages: [{ role: 'user', content: 'responde o cliente da conversa 99999' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.proposals, []); // conversa que não existe (ou de outra empresa) não vira rascunho
    assert.match(seen[1].messages.at(-1).content[0].content, /erro/);
    assert.ok(seen[0].tools.some((t) => t.name === 'propor_resposta'));
    assert.equal(db.inAccount(A, () => db.one('select count(*) n from messages').n), before); // nada foi enviado
  } finally { globalThis.fetch = real; }
  // o conector do Claude não tem nem o rascunho
  const { TOOLS } = await import('../server/assistente.js');
  assert.ok(!TOOLS.some((t) => t.name === 'propor_resposta'));
});

test('cancelar pela tela: cobrança para no Mercado Pago e o acesso vai até o fim do mês pago; login fica registrado', async () => {
  const acc = db.accountIds().at(-1); // Padaria Sol, assinante ativa do teste anterior
  process.env.MP_ACCESS_TOKEN = 'TEST-token';
  const real = globalThis.fetch;
  const fim = Date.now() + 20 * 864e5;
  let put = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.mercadopago.com/preapproval/')) {
      if (init?.method === 'PUT') put = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'PRE1', status: 'cancelled', next_payment_date: new Date(fim).toISOString() }), { status: 200 });
    }
    return real(url, init);
  };
  try {
    assert.equal((await call('rui', 'POST', '/api/billing/cancel')).status, 200);
    assert.deepEqual(put, { status: 'cancelled' });
    const me = (await call('rui', 'GET', '/api/me')).body;
    assert.equal(me.billing.status, 'cancelado');
    assert.equal(me.billing.blocked, false); // ainda dentro do mês pago
    assert.equal((await call('rui', 'GET', '/api/leads')).status, 200);
    db.platform.prepare('update accounts set paid_until = ? where id = ?').run(Date.now() - 1000, acc);
    assert.equal((await call('rui', 'GET', '/api/leads')).status, 402); // mês acabou
    assert.equal((await call('rui', 'POST', '/api/billing/cancel')).status, 400); // nada mais para cancelar
  } finally { globalThis.fetch = real; delete process.env.MP_ACCESS_TOKEN; }
  // Marco Civil: login com data, hora e IP
  await call('x', 'POST', '/api/login', { email: 'bia@empresa-b.com', password: 'senha-forte-1' });
  const log = db.platform.prepare("select * from access_log where kind = 'login' and account_id = ? order by at desc").get(B);
  assert.ok(log && log.ip && log.at > Date.now() - 60e3);
});
