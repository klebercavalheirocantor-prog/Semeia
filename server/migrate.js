// Mudança do PC para a nuvem: o CRM do PC entrega uma cópia do banco e dos arquivos (só para administrador logado),
// e o CRM novo recebe, protegido por RESTORE_TOKEN (variável da hospedagem; sem ela, recebimento desligado).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, DATA_DIR, UPLOAD_DIR } from './db.js';

const safeName = (n) => { const s = String(n || ''); return /^[\w.-]{1,200}$/.test(s) && !s.startsWith('.') ? s : null; }; // só nome simples, nunca caminho
const tokenOk = (req) => {
  const want = process.env.RESTORE_TOKEN || '', got = String(req.get('x-restore-token') || '');
  return want.length >= 16 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

export function mountMigrate(app, { requireAdmin }) {
  // ---- envio (CRM do PC)
  app.get('/api/admin/export/db', requireAdmin, (req, res) => {
    const file = path.join(DATA_DIR, `export-${Date.now()}.db`);
    db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
    res.download(file, 'semeia.db', () => fs.rmSync(file, { force: true }));
  });
  app.get('/api/admin/export/uploads', requireAdmin, (req, res) => res.json(fs.readdirSync(UPLOAD_DIR).filter(safeName)));
  app.get('/api/admin/export/upload/:name', requireAdmin, (req, res) => {
    const n = safeName(req.params.name);
    if (!n || !fs.existsSync(path.join(UPLOAD_DIR, n))) return res.sendStatus(404);
    res.sendFile(path.join(UPLOAD_DIR, n));
  });

  // ---- recebimento (CRM da nuvem). Aceita chamada vinda do CRM do PC aberto no navegador.
  const cors = (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': 'http://localhost:3000', 'Access-Control-Allow-Headers': 'x-restore-token, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!tokenOk(req)) return res.status(403).json({ error: 'Recebimento desligado ou código errado' });
    next();
  };
  const raw = express.raw({ type: () => true, limit: '300mb' });
  app.use('/restore', cors);
  app.post('/restore/upload/:name', raw, (req, res) => {
    const n = safeName(req.params.name);
    if (!n) return res.status(400).json({ error: 'Nome inválido' });
    fs.writeFileSync(path.join(UPLOAD_DIR, n), req.body);
    res.json({ ok: true, bytes: req.body.length });
  });
  // O banco entra por último: grava ao lado e reinicia; na volta, db.js troca o arquivo antes de abrir.
  app.post('/restore/db', raw, (req, res) => {
    if (req.body.subarray(0, 15).toString() !== 'SQLite format 3') return res.status(400).json({ error: 'Arquivo não é um banco do CRM' });
    fs.writeFileSync(path.join(DATA_DIR, 'crm.db.restore'), req.body);
    res.json({ ok: true, bytes: req.body.length, restarting: true });
    if (!process.env.NODE_TEST_CONTEXT) setTimeout(() => process.exit(0), 500); // a hospedagem liga de novo sozinha
  });
}
