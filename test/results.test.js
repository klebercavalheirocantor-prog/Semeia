import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-result-'));
process.env.DATA_DIR = DIR;
const { app } = await import('../server/app.js');
const { run, one, setSetting } = await import('../server/db.js');
setSetting('perfil', 'agrovox');

let server, base, cookie;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'x-crm': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/setup', { name: 'Kleber', email: 'k@x.com', password: '12345678' });
});
after(() => server.close());

test('resultado: lucro, ROAS e ROI por canal com o investimento do arquivo; venda sem custo avisa', async () => {
  const won = one("select id from stages where kind = 'won' and pipeline_id = 1").id;
  for (const n of [['Canal da venda', 'select'], ['Custo do produto', 'money'], ['Taxa de pagamento', 'money']]) await call('POST', '/api/fields', { entity: 'lead', name: n[0], type: n[1], options: n[1] === 'select' ? ['Anúncio Facebook Brasil', 'Anúncio Facebook EUA', 'Disparo no WhatsApp'] : [] });
  const f = Object.fromEntries((await call('GET', '/api/me')).body.fields.map((x) => [x.name, x.id]));
  // venda do anúncio: R$ 3.000, custo 500, taxa 100
  const a = (await call('POST', '/api/leads', { name: 'Sinal SF3 — Maria', price_cents: 300000, stage_id: won, contact: { name: 'Agro Sinal Maria', phone: '67999990001' },
    fields: { [f['Canal da venda']]: 'Anúncio Facebook Brasil', [f['Custo do produto']]: 50000, [f['Taxa de pagamento']]: 10000 } })).body.id;
  // venda do disparo sem canal escolhido e sem custo: canal vem da origem (manual = disparo)
  await call('POST', '/api/leads', { name: 'Ativação', price_cents: 100000, stage_id: won, contact: { name: 'Atualize João', phone: '67999990002' } });
  fs.writeFileSync(path.join(DIR, 'contas', '1', 'investimento.json'), JSON.stringify({ updated_at: '2026-11-20T23:00:00Z', cambio: 5.51,
    canais: { 'Anúncio Facebook Brasil': { brl: 1000 }, 'Disparo no WhatsApp': { brl: 100 } }, campanhas: [{ nome: 'Brasil', usd: 181.49, conversas: 70 }] }));
  const r = (await call('GET', '/api/results')).body;
  const fb = r.canais.find((c) => c.nome === 'Anúncio Facebook Brasil');
  assert.equal(fb.vendas, 1);
  assert.equal(fb.investido, 100000);
  assert.equal(fb.lucro, 300000 - 50000 - 10000 - 100000);
  assert.equal(fb.roas, 3);
  assert.equal(fb.roi, 1.4);
  const disp = r.canais.find((c) => c.nome === 'Disparo no WhatsApp');
  assert.equal(disp.vendas, 1);
  assert.equal(disp.sem_custo, 1);
  assert.equal(r.total.receita, 400000);
  assert.equal(r.vendas.find((v) => v.lead_id === a).cliente, 'Maria');
  assert.equal(r.vendas.find((v) => v.produto === 'Ativação').cliente, 'João');
  assert.equal(r.investment.campanhas[0].conversas, 70);
  assert.equal(r.meses.length, 1);
});

test('resultado sem arquivo de investimento: ainda responde, com investido zero', async () => {
  fs.rmSync(path.join(DIR, 'contas', '1', 'investimento.json'));
  const r = (await call('GET', '/api/results')).body;
  assert.equal(r.investment, null);
  assert.equal(r.total.investido, 0);
  assert.equal(r.total.roi, null);
});

test('investimento gravado pela tarefa diária na nuvem (rota de administrador)', async () => {
  assert.equal((await call('PUT', '/api/admin/investment', { sem: 'canais' })).status, 400);
  const inv = { updated_at: '2026-11-21T23:00:00Z', cambio: 5.4, canais: { 'Anúncio Facebook Brasil': { brl: 250 } }, campanhas: [] };
  assert.equal((await call('PUT', '/api/admin/investment', inv)).status, 200);
  assert.deepEqual((await call('GET', '/api/admin/investment')).body, inv);
  assert.equal((await call('GET', '/api/results')).body.total.investido, 25000);
});

test('investimento em anúncios é de cada marca: a marca nova não herda o da AgroVox', async () => {
  const { results } = await import('../server/results.js');
  run("insert into brands(id, name, created_at) values(9, 'KC First Class', 0) on conflict(id) do nothing");
  const kc = results({ brandId: 9 });
  assert.equal(kc.total.investido, 0);
  assert.equal(kc.total.lucro, 0);
});
