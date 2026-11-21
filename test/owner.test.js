import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-dono-'));
const { becomeOwner, releaseOwner } = await import('../server/owner.js');
const FILE = path.join(process.env.DATA_DIR, 'dono.json');

test('servidor novo espera o antigo soltar a vez; antigo desliga se outro assumir', async () => {
  // o antigo ainda está ligado (sinal recente): o novo espera
  fs.writeFileSync(FILE, JSON.stringify({ id: 'antigo', at: Date.now() }));
  let done = false;
  const p = becomeOwner({ stepMs: 20, staleMs: 60000, maxWaitMs: 60000, onLost: () => {} }).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(done, false);
  fs.rmSync(FILE); // o antigo fechou o WhatsApp e soltou a vez
  await p;
  assert.notEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).id, 'antigo');
  releaseOwner();
  assert.ok(!fs.existsSync(FILE));
});

test('sinal parado (servidor antigo morreu sem soltar): assume depois do prazo', async () => {
  fs.writeFileSync(FILE, JSON.stringify({ id: 'morto', at: Date.now() - 60000 }));
  await becomeOwner({ stepMs: 20, staleMs: 20000, onLost: () => {} });
  assert.notEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).id, 'morto');
  releaseOwner();
});
