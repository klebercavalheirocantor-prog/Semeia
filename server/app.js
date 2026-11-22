import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { one, all, run, now, tx, getSetting, setSetting, createPipeline, UPLOAD_DIR, DATA_DIR } from './db.js';
import { hashPassword, checkPassword, createSession, cookieFor, loadUser, scope, can } from './auth.js';
import { mountMigrate } from './migrate.js';
import { subscribe, emit } from './bus.js';
import { httpError, logEvent, setTags, getTags, setFields, getFields, setPoints, createContact, createLead, firstStage, openLeadOf, brandKey, firstPipelineOf, setOptOut } from './crm.js';
import { verifySignature, parseWebhook, sendMessage, testChannel, saveFile, listTemplates, createTemplate, renderTemplate, templateVars, templateSupported, templateHeaderMedia } from './meta.js';
import { parseVcf, parseCsv, importContacts } from './importer.js';
import { handleWebhookItems } from './inbound.js';
import { sendTemplateTo, sendEmail, contactFromUnsubToken, fillVars } from './outbound.js';
import { audienceCount, campaignStats, startCampaign, pauseCampaign } from './campaigns.js';
import { dashboard } from './dashboard.js';
import { results, readInvestment } from './results.js';
import { flowOnHuman, flowOnStage, validateGraph, simulate, portsOf } from './flows.js';
import { claude, DEFAULT_MODEL } from './ai.js';
import { isWeb, startWeb, stopWeb, webStatus } from './waweb.js';

const ROOT = path.resolve(import.meta.dirname, '..');
export const app = express();
app.disable('x-powered-by');
// No PC: o túnel (cloudflared) roda nesta máquina e informa o IP real do visitante.
// Na nuvem (Railway): TRUST_PROXY=1 confia no proxy da hospedagem, que fica na frente do CRM.
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 'loopback');
// Para a hospedagem saber que o CRM está no ar (sem login).
app.get('/healthz', (req, res) => res.type('text').send('ok'));
const fromThisPc = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.get('x-forwarded-for') && !req.get('cf-connecting-ip');

// ---------- webhooks da Meta (corpo cru para conferir a assinatura)
app.get('/webhooks/meta', (req, res) => {
  const meta = getSetting('meta', {});
  if (req.query['hub.mode'] === 'subscribe' && meta.verify_token && req.query['hub.verify_token'] === meta.verify_token) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhooks/meta', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
  const meta = getSetting('meta', {});
  if (!verifySignature(req.body, req.get('x-hub-signature-256'), meta.app_secret)) {
    console.warn('webhook com assinatura inválida (confira o App Secret em Configurações > Geral)');
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return; }
  handleWebhookItems(parseWebhook(body));
});

// ---------- arquivos estáticos
app.use('/vendor/preact.mjs', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/htm/preact/standalone.mjs')));
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));

app.use('/api', express.json({ limit: '2mb' }));

// ---------- primeiro acesso e login
app.get('/api/setup', (req, res) => res.json({ needed: !one('select 1 from users limit 1') }));
app.post('/api/setup', (req, res) => {
  const { company, name, email, password } = req.body || {};
  if (one('select 1 from users limit 1')) throw httpError(409, 'Já configurado');
  // Enquanto não há administrador, só quem está neste PC pode criar (o túnel pode estar aberto).
  if (!fromThisPc(req)) throw httpError(403, 'O primeiro acesso precisa ser feito no próprio computador do CRM (http://localhost:3000)');
  if (!name || !email || !password || password.length < 8) throw httpError(400, 'Preencha nome, email e uma senha com pelo menos 8 caracteres');
  const id = Number(run('insert into users(name, email, pass_hash, role_id, is_admin, created_at) values(?, ?, ?, (select id from roles where name = ?), 1, ?)',
    name.trim(), email.trim(), hashPassword(password), 'Gerente', now()).lastInsertRowid);
  if (company) { setSetting('general', { ...getSetting('general', {}), company }); run('update brands set name = ? where id = 1', String(company).trim()); }
  res.setHeader('Set-Cookie', cookieFor(createSession(id)));
  res.json({ ok: true });
});

const fails = new Map(); // ip -> { n, until }
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const f = fails.get(ip);
  if (f && f.n >= 10 && f.until > now()) throw httpError(429, 'Muitas tentativas. Espere 15 minutos.');
  const { email, password } = req.body || {};
  const u = one('select * from users where email = ? and is_active = 1', String(email || '').trim());
  if (!u || !checkPassword(String(password || ''), u.pass_hash)) {
    fails.set(ip, { n: (f && f.until > now() ? f.n : 0) + 1, until: now() + 15 * 60e3 });
    throw httpError(401, 'Email ou senha incorretos');
  }
  fails.delete(ip);
  res.setHeader('Set-Cookie', cookieFor(createSession(u.id)));
  res.json({ ok: true });
});

// ---------- link "sair da lista" dos e-mails de campanha (público, sem login)
function unsubscribe(token) {
  const who = contactFromUnsubToken(token);
  if (!who) return null;
  setOptOut(who.id, who.brandId, true);
  run("update campaign_recipients set status = 'skipped', error = 'pediu para sair' where contact_id = ? and status = 'queued' and campaign_id in (select id from campaigns where brand_id = ?)", who.id, who.brandId);
  return who;
}
app.get('/sair/:token', (req, res) => {
  const id = unsubscribe(req.params.token);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pronto</title>
    <body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 16px;color:#222"><h2>${id ? 'Pronto, você saiu da lista.' : 'Link inválido.'}</h2>
    <p>${id ? 'Você não vai mais receber nossas campanhas.' : 'Responda o e-mail com SAIR que removemos você.'}</p></body>`);
});

// "Cancelar inscrição" com um clique (Gmail/Yahoo mandam POST no mesmo link).
app.post('/sair/:token', express.urlencoded({ extended: false }), (req, res) => {
  res.status(unsubscribe(req.params.token) ? 200 : 404).end();
});

// ---------- daqui para baixo: precisa estar logado
app.use('/api', (req, res, next) => {
  req.user = loadUser(req);
  if (!req.user) return res.status(401).json({ error: 'Faça login' });
  // Empresa escolhida na setinha do menu (AgroVox, AgroPool...). Vem em todo pedido da tela.
  const b = Number(req.get('x-brand')) || 1;
  req.brand = one('select id from brands where id = ?', b) ? b : 1;
  // Formulários de outros sites não conseguem mandar cabeçalho próprio: barra CSRF.
  if (req.method !== 'GET' && req.get('x-crm') !== '1') return res.status(403).json({ error: 'Requisição recusada' });
  next();
});
const admin = (req) => { if (!req.user.is_admin) throw httpError(403, 'Só administradores'); };
// Mudança do PC para a nuvem (envio do banco e dos arquivos; recebimento com RESTORE_TOKEN).
mountMigrate(app, { requireAdmin: (req, res, next) => { admin(req); next(); } });

app.post('/api/logout', (req, res) => {
  run('delete from sessions where token = ?', req.user.token);
  res.setHeader('Set-Cookie', cookieFor('', 0));
  res.json({ ok: true });
});

app.get('/api/stream', (req, res) => subscribe(req, res));

function channelsPublic(brandId) {
  return all('select id, kind, name, external_id, status, config from channels where brand_id = ? order by id', brandId).map((c) => {
    const cfg = JSON.parse(c.config);
    return { id: c.id, kind: c.kind, name: c.name, external_id: c.external_id, status: c.status, pipeline_id: cfg.pipeline_id || null, waba_id: cfg.waba_id || '', has_token: !!cfg.token,
      mode: cfg.mode === 'web' ? 'web' : c.kind === 'email' ? 'imap' : 'api', me: cfg.me || null,
      ...(c.kind === 'email' ? { imap_host: cfg.imap_host || 'imap.gmail.com', has_pass: !!cfg.imap_pass, checked_at: cfg.checked_at || null, mail_error: cfg.mail_error || null } : {}) };
  });
}

app.get('/api/me', (req, res) => {
  const u = req.user;
  const meta = getSetting('meta', {});
  res.json({
    user: { id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin, rights: u.rights },
    general: { ...getSetting('general', {}), company: one('select name from brands where id = ?', req.brand).name },
    brand: req.brand,
    brands: all('select id, name from brands order by id'),
    meta: u.is_admin ? { graph_version: meta.graph_version, verify_token: meta.verify_token, has_app_secret: !!meta.app_secret } : null,
    email: u.is_admin ? (({ api_key, ...e }) => ({ ...e, has_key: !!api_key }))(getSetting(brandKey('email', req.brand), {})) : null,
    ai: u.is_admin ? (({ api_key, ...e }) => ({ model: DEFAULT_MODEL, ...e, has_key: !!api_key }))(getSetting(brandKey('ai', req.brand), {})) : null,
    pipelines: all('select * from pipelines where brand_id = ? order by sort, id', req.brand).map((p) => ({ ...p, stages: all('select * from stages where pipeline_id = ? order by sort', p.id) })),
    users: all('select id, name, email, is_admin, is_active, role_id from users order by name'),
    roles: all('select * from roles order by id').map((r) => ({ ...r, rights: JSON.parse(r.rights) })),
    fields: all('select * from custom_fields order by entity, sort, id').map((f) => ({ ...f, options: JSON.parse(f.options) })),
    tags: all('select * from tags order by name'),
    task_types: all('select * from task_types order by id'),
    loss_reasons: all('select * from loss_reasons order by sort, id'),
    channels: u.is_admin ? channelsPublic(req.brand) : channelsPublic(req.brand).map(({ id, kind, name, status }) => ({ id, kind, name, status })),
    unread: one(`select coalesce(sum(c.unread), 0) n from conversations c join channels ch on ch.id = c.channel_id and ch.brand_id = ? left join leads l on l.id = c.lead_id
      where c.status = 'open' and (${convScope(u)})`, req.brand).n,
  });
});

app.patch('/api/settings', (req, res) => {
  admin(req);
  const { general, meta, email, ai } = req.body || {};
  if (ai) {
    const k = brandKey('ai', req.brand), cur = getSetting(k, {});
    setSetting(k, { ...cur, ...ai, api_key: ai.api_key || cur.api_key || '' }); // chave vazia = manter
  }
  if (general) {
    const { company, ...rest } = general; // o nome é da empresa escolhida na setinha
    if (company !== undefined && String(company).trim()) run('update brands set name = ? where id = ?', String(company).trim(), req.brand);
    setSetting('general', { ...getSetting('general', {}), ...rest });
  }
  if (email) {
    const k = brandKey('email', req.brand), cur = getSetting(k, {});
    setSetting(k, { ...cur, ...email, api_key: email.api_key || cur.api_key || '' }); // chave vazia = manter
  }
  if (meta) {
    const cur = getSetting('meta', {});
    const next = { ...cur, ...meta };
    if (!meta.app_secret) next.app_secret = cur.app_secret; // campo vazio = manter
    setSetting('meta', next);
  }
  emit('config');
  res.json({ ok: true });
});

// ---------- usuários e funções
app.post('/api/users', (req, res) => {
  admin(req);
  const { name, email, password, role_id, is_admin } = req.body || {};
  if (!name || !email || !password || password.length < 8) throw httpError(400, 'Nome, email e senha (mín. 8) são obrigatórios');
  if (one('select 1 from users where email = ?', email.trim())) throw httpError(409, 'Já existe um usuário com esse email');
  const id = run('insert into users(name, email, pass_hash, role_id, is_admin, created_at) values(?, ?, ?, ?, ?, ?)',
    name.trim(), email.trim(), hashPassword(password), role_id || null, is_admin ? 1 : 0, now()).lastInsertRowid;
  emit('config');
  res.json({ id: Number(id) });
});

app.patch('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const self = id === req.user.id;
  if (!req.user.is_admin && !(self && Object.keys(b).every((k) => ['name', 'password', 'current_password'].includes(k)))) throw httpError(403, 'Só administradores');
  const u = one('select * from users where id = ?', id);
  if (!u) throw httpError(404, 'Usuário não encontrado');
  if (self && !req.user.is_admin && b.password && !checkPassword(String(b.current_password || ''), u.pass_hash)) throw httpError(400, 'Senha atual incorreta');
  const admins = one('select count(*) n from users where is_admin = 1 and is_active = 1').n;
  if (u.is_admin && admins <= 1 && (b.is_admin === false || b.is_active === false)) throw httpError(400, 'Precisa existir pelo menos um administrador ativo');
  tx(() => {
    if (b.name) run('update users set name = ? where id = ?', b.name.trim(), id);
    if (b.email) run('update users set email = ? where id = ?', b.email.trim(), id);
    if (b.password) {
      if (b.password.length < 8) throw httpError(400, 'Senha com pelo menos 8 caracteres');
      run('update users set pass_hash = ? where id = ?', hashPassword(b.password), id);
      run('delete from sessions where user_id = ? and token != ?', id, req.user.token);
    }
    if ('role_id' in b) run('update users set role_id = ? where id = ?', b.role_id || null, id);
    if ('is_admin' in b) run('update users set is_admin = ? where id = ?', b.is_admin ? 1 : 0, id);
    if ('is_active' in b) {
      run('update users set is_active = ? where id = ?', b.is_active ? 1 : 0, id);
      if (!b.is_active) {
        run('delete from sessions where user_id = ?', id);
        const to = b.reassign_to ? Number(b.reassign_to) : null;
        for (const t of ['leads', 'contacts', 'companies']) run(`update ${t} set responsible_id = ? where responsible_id = ?`, to, id);
        run('update tasks set responsible_id = ? where responsible_id = ? and done_at is null', to, id);
      }
    }
  });
  emit('config');
  res.json({ ok: true });
});

app.post('/api/roles', (req, res) => {
  admin(req);
  const id = run('insert into roles(name, rights) values(?, ?)', String(req.body.name || 'Nova função'), JSON.stringify(req.body.rights || {})).lastInsertRowid;
  emit('config');
  res.json({ id: Number(id) });
});
app.patch('/api/roles/:id', (req, res) => {
  admin(req);
  if (req.body.name) run('update roles set name = ? where id = ?', req.body.name, Number(req.params.id));
  if (req.body.rights) run('update roles set rights = ? where id = ?', JSON.stringify(req.body.rights), Number(req.params.id));
  emit('config');
  res.json({ ok: true });
});
app.delete('/api/roles/:id', (req, res) => {
  admin(req);
  if (one('select 1 from users where role_id = ?', Number(req.params.id))) throw httpError(400, 'Há usuários com essa função');
  run('delete from roles where id = ?', Number(req.params.id));
  emit('config');
  res.json({ ok: true });
});

// ---------- funis e etapas
app.post('/api/pipelines', (req, res) => {
  admin(req);
  const id = tx(() => {
    const pid = createPipeline(String(req.body.name || 'Novo funil'), [{ name: 'Primeiro contato' }, { name: 'Em andamento', color: '#ffdc7f' }]);
    run('update pipelines set brand_id = ? where id = ?', req.brand, pid);
    return pid;
  });
  emit('config');
  res.json({ id });
});
app.patch('/api/pipelines/:id', (req, res) => {
  admin(req);
  run('update pipelines set name = ? where id = ?', String(req.body.name), Number(req.params.id));
  emit('config');
  res.json({ ok: true });
});
app.delete('/api/pipelines/:id', (req, res) => {
  admin(req);
  const id = Number(req.params.id);
  if (one('select 1 from leads where pipeline_id = ? and deleted_at is null', id)) throw httpError(400, 'Mova ou apague os leads deste funil antes');
  if (one('select count(*) n from pipelines where brand_id = (select brand_id from pipelines where id = ?)', id).n <= 1) throw httpError(400, 'Cada empresa precisa de pelo menos um funil');
  tx(() => {
    run('delete from leads where pipeline_id = ?', id);
    run('delete from pipelines where id = ?', id);
  });
  emit('config');
  res.json({ ok: true });
});
app.post('/api/stages', (req, res) => {
  admin(req);
  const { pipeline_id, name, color } = req.body || {};
  const sort = one("select coalesce(max(sort), 0) m from stages where pipeline_id = ? and kind in ('incoming','normal')", pipeline_id).m + 1;
  tx(() => {
    run("update stages set sort = sort + 1 where pipeline_id = ? and kind in ('won','lost')", pipeline_id);
    run('insert into stages(pipeline_id, name, color, sort) values(?, ?, ?, ?)', pipeline_id, String(name || 'Nova etapa'), color || '#99ccff', sort);
  });
  emit('config');
  res.json({ ok: true });
});
app.patch('/api/stages/:id', (req, res) => {
  admin(req);
  const id = Number(req.params.id);
  if (req.body.name) run('update stages set name = ? where id = ?', String(req.body.name), id);
  if (req.body.color) run('update stages set color = ? where id = ?', String(req.body.color), id);
  emit('config');
  res.json({ ok: true });
});
app.delete('/api/stages/:id', (req, res) => {
  admin(req);
  const st = one('select * from stages where id = ?', Number(req.params.id));
  if (!st) throw httpError(404, 'Etapa não encontrada');
  if (st.kind === 'won' || st.kind === 'lost') throw httpError(400, 'As etapas de venda fechada e perdido são fixas');
  if (one('select 1 from leads where stage_id = ? and deleted_at is null', st.id)) throw httpError(400, 'Mova os leads desta etapa antes de apagar');
  if (one("select count(*) n from stages where pipeline_id = ? and kind = 'normal'", st.pipeline_id).n <= 1 && st.kind === 'normal') throw httpError(400, 'O funil precisa de pelo menos uma etapa');
  tx(() => {
    run('delete from leads where stage_id = ?', st.id);
    run('delete from stages where id = ?', st.id);
  });
  emit('config');
  res.json({ ok: true });
});
app.post('/api/stages/reorder', (req, res) => {
  admin(req);
  // só etapas normais se movem; entrada fica no início, ganho/perdido no fim
  tx(() => (req.body.ids || []).forEach((id, i) => run("update stages set sort = ? where id = ? and kind = 'normal'", i + 1, Number(id))));
  emit('config');
  res.json({ ok: true });
});

// ---------- configuração de dados (campos, tags, tipos de tarefa, motivos de perda)
const FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'select', 'multiselect', 'checkbox', 'url'];
app.post('/api/fields', (req, res) => {
  admin(req);
  const { entity, name, type, options } = req.body || {};
  if (!['lead', 'contact', 'company'].includes(entity) || !FIELD_TYPES.includes(type) || !name) throw httpError(400, 'Campo inválido');
  run('insert into custom_fields(entity, name, type, options, sort) values(?, ?, ?, ?, ?)', entity, name, type, JSON.stringify(options || []), now() % 1e6);
  emit('config');
  res.json({ ok: true });
});
app.patch('/api/fields/:id', (req, res) => {
  admin(req);
  const id = Number(req.params.id);
  if (req.body.name) run('update custom_fields set name = ? where id = ?', req.body.name, id);
  if (req.body.options) run('update custom_fields set options = ? where id = ?', JSON.stringify(req.body.options), id);
  emit('config');
  res.json({ ok: true });
});
for (const [route, table] of [['fields', 'custom_fields'], ['tags', 'tags'], ['task-types', 'task_types'], ['loss-reasons', 'loss_reasons']]) {
  app.delete(`/api/${route}/:id`, (req, res) => {
    admin(req);
    run(`delete from ${table} where id = ?`, Number(req.params.id));
    emit('config');
    res.json({ ok: true });
  });
}
app.post('/api/tags', (req, res) => {
  admin(req);
  run('insert into tags(name, color) values(?, ?) on conflict(name) do update set color = excluded.color', String(req.body.name).trim(), req.body.color || '#ddd');
  emit('config');
  res.json({ ok: true });
});
app.patch('/api/tags/:id', (req, res) => {
  admin(req);
  if (req.body.name) run('update tags set name = ? where id = ?', req.body.name, Number(req.params.id));
  if (req.body.color) run('update tags set color = ? where id = ?', req.body.color, Number(req.params.id));
  emit('config');
  res.json({ ok: true });
});
app.post('/api/task-types', (req, res) => {
  admin(req);
  run('insert into task_types(name, color) values(?, ?)', String(req.body.name).trim(), req.body.color || '#6b8afd');
  emit('config');
  res.json({ ok: true });
});
app.post('/api/loss-reasons', (req, res) => {
  admin(req);
  run('insert into loss_reasons(name, sort) values(?, ?)', String(req.body.name).trim(), now() % 1e6);
  emit('config');
  res.json({ ok: true });
});

// ---------- leads
const LEAD_LIST_COLS = `l.id, l.name, l.price_cents, l.stage_id, l.pipeline_id, l.responsible_id, l.created_at, l.updated_at, l.closed_at,
  (select c.name from lead_contacts lc join contacts c on c.id = lc.contact_id where lc.lead_id = l.id order by lc.is_main desc, c.id limit 1) contact_name,
  (select min(due_at) from tasks t where t.entity = 'lead' and t.entity_id = l.id and t.done_at is null) next_task_at,
  (select json_object('body', m.body, 'kind', m.kind, 'dir', m.direction, 'at', m.created_at) from conversations cv join messages m on m.conversation_id = cv.id where cv.lead_id = l.id order by m.created_at desc, m.id desc limit 1) last_msg,
  (select coalesce(sum(unread), 0) from conversations cv where cv.lead_id = l.id) unread,
  (select ch.kind from conversations cv join channels ch on ch.id = cv.channel_id where cv.lead_id = l.id order by cv.last_message_at desc limit 1) channel,
  (select json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color)) from entity_tags et join tags t on t.id = et.tag_id where et.entity = 'lead' and et.entity_id = l.id) tags`;

function parseLeadRow(r) {
  return { ...r, last_msg: r.last_msg ? JSON.parse(r.last_msg) : null, tags: JSON.parse(r.tags || '[]') };
}

const like = (q) => `%${String(q).replace(/[%_]/g, '')}%`;

app.get('/api/leads', (req, res) => {
  const q = req.query;
  const where = ['l.deleted_at is null', scope(req.user, 'leads', 'view', 'l.responsible_id'), 'l.pipeline_id in (select id from pipelines where brand_id = ?)'];
  const p = [req.brand];
  if (q.pipeline_id) { where.push('l.pipeline_id = ?'); p.push(Number(q.pipeline_id)); }
  if (q.stage_id) { where.push('l.stage_id = ?'); p.push(Number(q.stage_id)); }
  if (q.responsible_id) {
    if (q.responsible_id === 'none') where.push('l.responsible_id is null');
    else { where.push('l.responsible_id = ?'); p.push(Number(q.responsible_id)); }
  }
  if (q.tag_id) { where.push("exists (select 1 from entity_tags et where et.entity = 'lead' and et.entity_id = l.id and et.tag_id = ?)"); p.push(Number(q.tag_id)); }
  if (q.q) {
    const digits = String(q.q).replace(/\D/g, '');
    where.push(`(l.name like ? or exists (select 1 from lead_contacts lc join contacts c on c.id = lc.contact_id left join contact_points cp on cp.contact_id = c.id
      where lc.lead_id = l.id and (c.name like ? or cp.value like ? ${digits.length >= 4 ? 'or cp.value_norm like ?' : ''})))`);
    p.push(like(q.q), like(q.q), like(q.q));
    if (digits.length >= 4) p.push(`%${digits}%`);
  }
  if (q.task === 'none') where.push("not exists (select 1 from tasks t where t.entity = 'lead' and t.entity_id = l.id and t.done_at is null)");
  if (q.task === 'overdue') { where.push("exists (select 1 from tasks t where t.entity = 'lead' and t.entity_id = l.id and t.done_at is null and t.due_at < ?)"); p.push(now()); }
  // Fechados aparecem por 30 dias no quadro; a lista (closed=all) mostra todos.
  if (q.closed !== 'all') { where.push('(l.closed_at is null or l.closed_at > ?)'); p.push(now() - 30 * 864e5); }
  // shortcut: limite fixo de 3000 leads por consulta; paginar por etapa quando o funil passar disso.
  const rows = all(`select ${LEAD_LIST_COLS} from leads l where ${where.join(' and ')} order by l.updated_at desc limit 3000`, ...p);
  res.json(rows.map(parseLeadRow));
});

function contactWithPoints(c) {
  if (!c) return c;
  const pts = all('select kind, value from contact_points where contact_id = ? order by id', c.id);
  return { ...c, phones: pts.filter((x) => x.kind === 'phone').map((x) => x.value), emails: pts.filter((x) => x.kind === 'email').map((x) => x.value) };
}

function feedFor(entity, id, convIds = []) {
  const items = [
    ...all('select n.*, \'note\' t from notes n where entity = ? and entity_id = ?', entity, id),
    ...all('select k.*, \'task\' t from tasks k where entity = ? and entity_id = ?', entity, id),
    ...all('select e.*, \'event\' t from events e where entity = ? and entity_id = ?', entity, id).map((e) => ({ ...e, data: JSON.parse(e.data) })),
  ];
  if (convIds.length) {
    items.push(...all(`select m.*, 'message' t, ch.kind channel, f.name file_name, f.mime file_mime from messages m join conversations cv on cv.id = m.conversation_id
      join channels ch on ch.id = cv.channel_id left join files f on f.id = m.file_id where m.conversation_id in (${convIds.map(Number).join(',')}) order by m.created_at desc limit 300`));
  }
  return items.sort((a, b) => a.created_at - b.created_at || a.id - b.id);
}

function loadLead(req, id) {
  const l = one('select * from leads where id = ? and deleted_at is null', id);
  if (!l) throw httpError(404, 'Lead não encontrado');
  if (!can(req.user, 'leads', 'view', l)) throw httpError(403, 'Você não tem acesso a este lead');
  return l;
}

app.get('/api/leads/:id', (req, res) => {
  const l = loadLead(req, Number(req.params.id));
  const contacts = all('select c.*, lc.is_main from lead_contacts lc join contacts c on c.id = lc.contact_id where lc.lead_id = ? and c.deleted_at is null order by lc.is_main desc, c.id', l.id).map(contactWithPoints);
  const conversations = all(`select cv.id, cv.status, cv.last_inbound_at, cv.unread, ch.kind channel, ch.name channel_name from conversations cv join channels ch on ch.id = cv.channel_id
    where cv.lead_id = ? order by cv.last_message_at desc`, l.id);
  res.json({
    ...l,
    company: l.company_id ? one('select id, name from companies where id = ?', l.company_id) : null,
    contacts, conversations,
    tags: getTags('lead', l.id), fields: getFields('lead', l.id),
    feed: feedFor('lead', l.id, conversations.map((c) => c.id)),
    can_edit: can(req.user, 'leads', 'edit', l), can_delete: can(req.user, 'leads', 'del', l),
  });
});

app.post('/api/leads', (req, res) => {
  if (!can(req.user, 'leads', 'edit')) throw httpError(403, 'Sem permissão para criar leads');
  const b = req.body || {};
  const id = tx(() => {
    let contactId = b.contact_id || null;
    if (!contactId && b.contact && (b.contact.name || b.contact.phone || b.contact.email)) {
      contactId = createContact({ name: b.contact.name || b.name, phones: b.contact.phone ? [b.contact.phone] : [], emails: b.contact.email ? [b.contact.email] : [], responsible_id: req.user.id }, req.user.id);
    }
    const stage = b.stage_id || firstStage(b.pipeline_id || firstPipelineOf(req.brand)).id;
    const leadId = createLead({ name: b.name || b.contact?.name, price_cents: b.price_cents, stage_id: stage, responsible_id: b.responsible_id ?? req.user.id, contact_id: contactId, company_id: b.company_id || null }, req.user.id);
    if (b.tags) setTags('lead', leadId, b.tags);
    if (b.fields) setFields('lead', leadId, b.fields);
    return leadId;
  });
  res.json({ id });
});

function updateLead(req, l, b) {
  const t = now();
  const uid = req.user.id;
  if (b.name !== undefined && b.name.trim() && b.name !== l.name) {
    run('update leads set name = ? where id = ?', b.name.trim(), l.id);
    logEvent('lead', l.id, 'name_changed', { from: l.name, to: b.name.trim() }, uid);
  }
  if (b.price_cents !== undefined && Number(b.price_cents) !== l.price_cents) {
    run('update leads set price_cents = ? where id = ?', Math.round(Number(b.price_cents)) || 0, l.id);
    logEvent('lead', l.id, 'price_changed', { from: l.price_cents, to: Math.round(Number(b.price_cents)) || 0 }, uid);
  }
  if (b.stage_id !== undefined && Number(b.stage_id) !== l.stage_id) {
    const from = one('select * from stages where id = ?', l.stage_id);
    const to = one('select * from stages where id = ?', Number(b.stage_id));
    if (!to) throw httpError(400, 'Etapa inválida');
    if (to.kind === 'lost' && !b.loss_reason_id && !l.loss_reason_id) throw httpError(400, 'Escolha o motivo da perda');
    const closed = to.kind === 'won' || to.kind === 'lost';
    run('update leads set stage_id = ?, pipeline_id = ?, closed_at = ?, loss_reason_id = ? where id = ?', to.id, to.pipeline_id, closed ? t : null,
      to.kind === 'lost' ? Number(b.loss_reason_id || l.loss_reason_id) : null, l.id);
    const reason = to.kind === 'lost' ? one('select name from loss_reasons where id = ?', Number(b.loss_reason_id || l.loss_reason_id))?.name : undefined;
    logEvent('lead', l.id, 'stage_changed', { from: from?.name, to: to.name, kind: to.kind, reason }, uid);
    flowOnStage(l.id, to.id);
  }
  if (b.responsible_id !== undefined && (b.responsible_id || null) !== l.responsible_id) {
    run('update leads set responsible_id = ? where id = ?', b.responsible_id || null, l.id);
    logEvent('lead', l.id, 'responsible_changed', { from: l.responsible_id, to: b.responsible_id || null }, uid);
  }
  if (b.company_id !== undefined) run('update leads set company_id = ? where id = ?', b.company_id || null, l.id);
  if (b.tags) setTags('lead', l.id, b.tags);
  if (b.fields) {
    const before = getFields('lead', l.id);
    setFields('lead', l.id, b.fields);
    const after = getFields('lead', l.id);
    for (const fid of Object.keys(b.fields)) {
      if (JSON.stringify(before[fid]) === JSON.stringify(after[fid])) continue;
      const f = one('select name from custom_fields where id = ?', Number(fid));
      if (f) logEvent('lead', l.id, 'field_changed', { name: f.name, from: before[fid] ?? null, to: after[fid] ?? null }, uid);
    }
  }
  run('update leads set updated_at = ? where id = ?', t, l.id);
}

app.patch('/api/leads/:id', (req, res) => {
  const l = loadLead(req, Number(req.params.id));
  if (!can(req.user, 'leads', 'edit', l)) throw httpError(403, 'Sem permissão para editar este lead');
  tx(() => updateLead(req, l, req.body || {}));
  emit('lead', { id: l.id });
  res.json({ ok: true });
});

app.delete('/api/leads/:id', (req, res) => {
  const l = loadLead(req, Number(req.params.id));
  if (!can(req.user, 'leads', 'del', l)) throw httpError(403, 'Sem permissão para apagar');
  run('update leads set deleted_at = ? where id = ?', now(), l.id);
  run('update conversations set lead_id = null where lead_id = ?', l.id);
  emit('lead', { id: l.id });
  res.json({ ok: true });
});

app.post('/api/leads/:id/contacts', (req, res) => {
  const l = loadLead(req, Number(req.params.id));
  if (!can(req.user, 'leads', 'edit', l)) throw httpError(403, 'Sem permissão');
  const b = req.body || {};
  tx(() => {
    const cid = b.contact_id || createContact({ name: b.name, phones: b.phones, emails: b.emails, responsible_id: req.user.id }, req.user.id);
    const hasMain = one('select 1 from lead_contacts where lead_id = ? and is_main = 1', l.id);
    run('insert or ignore into lead_contacts(lead_id, contact_id, is_main) values(?, ?, ?)', l.id, cid, hasMain ? 0 : 1);
    logEvent('lead', l.id, 'contact_linked', { name: one('select name from contacts where id = ?', cid).name }, req.user.id);
  });
  emit('lead', { id: l.id });
  res.json({ ok: true });
});
app.delete('/api/leads/:id/contacts/:cid', (req, res) => {
  const l = loadLead(req, Number(req.params.id));
  if (!can(req.user, 'leads', 'edit', l)) throw httpError(403, 'Sem permissão');
  run('delete from lead_contacts where lead_id = ? and contact_id = ?', l.id, Number(req.params.cid));
  logEvent('lead', l.id, 'contact_unlinked', { name: one('select name from contacts where id = ?', Number(req.params.cid))?.name }, req.user.id);
  emit('lead', { id: l.id });
  res.json({ ok: true });
});

// ---------- contatos e empresas
app.get('/api/contacts', (req, res) => {
  const where = ['c.deleted_at is null', scope(req.user, 'contacts', 'view', 'c.responsible_id')];
  const p = [];
  if (req.query.q) {
    const digits = String(req.query.q).replace(/\D/g, '');
    where.push(`(c.name like ? or exists (select 1 from contact_points cp where cp.contact_id = c.id and (cp.value like ? ${digits.length >= 4 ? 'or cp.value_norm like ?' : ''})))`);
    p.push(like(req.query.q), like(req.query.q));
    if (digits.length >= 4) p.push(`%${digits}%`);
  }
  if (req.query.company_id) { where.push('c.company_id = ?'); p.push(Number(req.query.company_id)); }
  if (req.query.tag) {
    where.push("exists (select 1 from entity_tags et join tags t on t.id = et.tag_id where et.entity = 'contact' and et.entity_id = c.id and t.name = ?)");
    p.push(String(req.query.tag));
  }
  if (req.query.optout === '1') { where.push('exists (select 1 from contact_optouts o where o.contact_id = c.id and o.brand_id = ?)'); p.push(req.brand); }
  const limit = Math.min(Number(req.query.limit) || 500, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  // opt_out_at: se pediu para sair da empresa escolhida
  const rows = all(`select c.*, (select o.at from contact_optouts o where o.contact_id = c.id and o.brand_id = ${Number(req.brand)}) opt_out_at,
    co.name company_name, (select count(*) from lead_contacts lc where lc.contact_id = c.id) leads_count,
    (select group_concat(t.name, '|') from entity_tags et join tags t on t.id = et.tag_id where et.entity = 'contact' and et.entity_id = c.id) tag_names
    from contacts c left join companies co on co.id = c.company_id
    where ${where.join(' and ')} order by c.updated_at desc, c.id desc limit ? offset ?`, ...p, limit, offset).map((r) => ({ ...contactWithPoints(r), tags: r.tag_names ? r.tag_names.split('|') : [] }));
  // with_total=1: devolve { rows, total } para a tela mostrar quantos são e "carregar mais"
  if (req.query.with_total === '1') return res.json({ rows, total: one(`select count(*) n from contacts c where ${where.join(' and ')}`, ...p).n });
  res.json(rows);
});

function loadEntity(req, kind, id) {
  const table = kind === 'contacts' ? 'contacts' : 'companies';
  const r = one(`select * from ${table} where id = ? and deleted_at is null`, id);
  if (!r) throw httpError(404, 'Não encontrado');
  if (!can(req.user, kind, 'view', r)) throw httpError(403, 'Sem acesso');
  return r;
}
const leadsOf = (sql, id) => all(`select l.id, l.name, l.price_cents, l.stage_id, l.closed_at from leads l where l.deleted_at is null and ${sql} order by l.updated_at desc`, id);

app.get('/api/contacts/:id', (req, res) => {
  const c = loadEntity(req, 'contacts', Number(req.params.id));
  const conversations = all('select cv.id, cv.status, ch.kind channel from conversations cv join channels ch on ch.id = cv.channel_id where cv.contact_id = ? order by cv.last_message_at desc', c.id);
  res.json({
    ...contactWithPoints(c),
    opt_out_at: one('select at from contact_optouts where contact_id = ? and brand_id = ?', c.id, req.brand)?.at ?? null,
    company: c.company_id ? one('select id, name from companies where id = ?', c.company_id) : null,
    leads: leadsOf('l.id in (select lead_id from lead_contacts where contact_id = ?)', c.id),
    conversations, tags: getTags('contact', c.id), fields: getFields('contact', c.id),
    feed: feedFor('contact', c.id, conversations.map((x) => x.id)),
    can_edit: can(req.user, 'contacts', 'edit', c), can_delete: can(req.user, 'contacts', 'del', c),
  });
});

app.post('/api/contacts', (req, res) => {
  if (!can(req.user, 'contacts', 'edit')) throw httpError(403, 'Sem permissão');
  const b = req.body || {};
  const id = tx(() => {
    const cid = createContact({ name: b.name, phones: b.phones, emails: b.emails, company_id: b.company_id || null, responsible_id: b.responsible_id ?? req.user.id }, req.user.id);
    if (b.fields) setFields('contact', cid, b.fields);
    if (b.tags) setTags('contact', cid, b.tags);
    return cid;
  });
  emit('contact', { id });
  res.json({ id });
});

app.patch('/api/contacts/:id', (req, res) => {
  const c = loadEntity(req, 'contacts', Number(req.params.id));
  if (!can(req.user, 'contacts', 'edit', c)) throw httpError(403, 'Sem permissão');
  const b = req.body || {};
  tx(() => {
    if (b.name) run('update contacts set name = ? where id = ?', b.name.trim(), c.id);
    if (b.company_id !== undefined) run('update contacts set company_id = ? where id = ?', b.company_id || null, c.id);
    if (b.responsible_id !== undefined) run('update contacts set responsible_id = ? where id = ?', b.responsible_id || null, c.id);
    if (b.opt_out !== undefined) setOptOut(c.id, req.brand, !!b.opt_out);
    if (b.phones) setPoints(c.id, 'phone', b.phones);
    if (b.emails) setPoints(c.id, 'email', b.emails);
    if (b.fields) setFields('contact', c.id, b.fields);
    if (b.tags) setTags('contact', c.id, b.tags);
    run('update contacts set updated_at = ? where id = ?', now(), c.id);
  });
  emit('contact', { id: c.id });
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', (req, res) => {
  const c = loadEntity(req, 'contacts', Number(req.params.id));
  if (!can(req.user, 'contacts', 'del', c)) throw httpError(403, 'Sem permissão para apagar');
  tx(() => {
    run('update contacts set deleted_at = ? where id = ?', now(), c.id);
    run('delete from contact_points where contact_id = ?', c.id); // libera o telefone para outro contato
  });
  emit('contact', { id: c.id });
  res.json({ ok: true });
});

app.get('/api/companies', (req, res) => {
  const where = ['co.deleted_at is null', scope(req.user, 'companies', 'view', 'co.responsible_id')];
  const p = [];
  if (req.query.q) { where.push('co.name like ?'); p.push(like(req.query.q)); }
  res.json(all(`select co.*, (select count(*) from contacts c where c.company_id = co.id and c.deleted_at is null) contacts_count,
    (select count(*) from leads l where l.company_id = co.id and l.deleted_at is null) leads_count from companies co where ${where.join(' and ')} order by co.name limit 500`, ...p));
});
app.get('/api/companies/:id', (req, res) => {
  const co = loadEntity(req, 'companies', Number(req.params.id));
  res.json({
    ...co,
    contacts: all('select * from contacts where company_id = ? and deleted_at is null order by name', co.id).map(contactWithPoints),
    leads: leadsOf('l.company_id = ?', co.id),
    tags: getTags('company', co.id), fields: getFields('company', co.id), feed: feedFor('company', co.id),
    can_edit: can(req.user, 'companies', 'edit', co), can_delete: can(req.user, 'companies', 'del', co),
  });
});
app.post('/api/companies', (req, res) => {
  if (!can(req.user, 'companies', 'edit')) throw httpError(403, 'Sem permissão');
  const t = now();
  const id = Number(run('insert into companies(name, responsible_id, created_by, created_at, updated_at) values(?, ?, ?, ?, ?)',
    String(req.body.name || 'Nova empresa').trim(), req.body.responsible_id ?? req.user.id, req.user.id, t, t).lastInsertRowid);
  if (req.body.fields) setFields('company', id, req.body.fields);
  emit('company', { id });
  res.json({ id });
});
app.patch('/api/companies/:id', (req, res) => {
  const co = loadEntity(req, 'companies', Number(req.params.id));
  if (!can(req.user, 'companies', 'edit', co)) throw httpError(403, 'Sem permissão');
  const b = req.body || {};
  tx(() => {
    if (b.name) run('update companies set name = ? where id = ?', b.name.trim(), co.id);
    if (b.responsible_id !== undefined) run('update companies set responsible_id = ? where id = ?', b.responsible_id || null, co.id);
    if (b.fields) setFields('company', co.id, b.fields);
    if (b.tags) setTags('company', co.id, b.tags);
    run('update companies set updated_at = ? where id = ?', now(), co.id);
  });
  emit('company', { id: co.id });
  res.json({ ok: true });
});
app.delete('/api/companies/:id', (req, res) => {
  const co = loadEntity(req, 'companies', Number(req.params.id));
  if (!can(req.user, 'companies', 'del', co)) throw httpError(403, 'Sem permissão para apagar');
  tx(() => {
    run('update companies set deleted_at = ? where id = ?', now(), co.id);
    run('update contacts set company_id = null where company_id = ?', co.id);
    run('update leads set company_id = null where company_id = ?', co.id);
  });
  emit('company', { id: co.id });
  res.json({ ok: true });
});

// ---------- notas e tarefas (ligadas a lead, contato ou empresa)
const ENT_RIGHT = { lead: 'leads', contact: 'contacts', company: 'companies' };
const ENT_TABLE = { lead: 'leads', contact: 'contacts', company: 'companies' };
function checkEntity(req, entity, id, act = 'edit') {
  if (!ENT_TABLE[entity]) throw httpError(400, 'Entidade inválida');
  const row = one(`select * from ${ENT_TABLE[entity]} where id = ? and deleted_at is null`, Number(id));
  if (!row) throw httpError(404, 'Não encontrado');
  if (!can(req.user, ENT_RIGHT[entity], act, row)) throw httpError(403, 'Sem permissão');
  return row;
}
const touch = (entity, id) => { run(`update ${ENT_TABLE[entity]} set updated_at = ? where id = ?`, now(), Number(id)); emit(entity, { id: Number(id) }); };

app.post('/api/notes', (req, res) => {
  const { entity, entity_id, body } = req.body || {};
  checkEntity(req, entity, entity_id);
  if (!String(body || '').trim()) throw httpError(400, 'Nota vazia');
  run('insert into notes(entity, entity_id, body, created_by, created_at) values(?, ?, ?, ?, ?)', entity, Number(entity_id), String(body).trim(), req.user.id, now());
  touch(entity, entity_id);
  res.json({ ok: true });
});
app.patch('/api/notes/:id', (req, res) => {
  const n = one('select * from notes where id = ?', Number(req.params.id));
  if (!n) throw httpError(404, 'Nota não encontrada');
  checkEntity(req, n.entity, n.entity_id);
  if ('is_pinned' in req.body) run('update notes set is_pinned = ? where id = ?', req.body.is_pinned ? 1 : 0, n.id);
  if (req.body.body) run('update notes set body = ? where id = ?', req.body.body, n.id);
  touch(n.entity, n.entity_id);
  res.json({ ok: true });
});
app.delete('/api/notes/:id', (req, res) => {
  const n = one('select * from notes where id = ?', Number(req.params.id));
  if (!n) throw httpError(404, 'Nota não encontrada');
  checkEntity(req, n.entity, n.entity_id);
  if (n.created_by !== req.user.id && !req.user.is_admin) throw httpError(403, 'Só quem escreveu pode apagar');
  run('delete from notes where id = ?', n.id);
  touch(n.entity, n.entity_id);
  res.json({ ok: true });
});

app.get('/api/tasks', (req, res) => {
  const q = req.query;
  const leadsAll = req.user.is_admin || req.user.rights?.leads?.view === 'all';
  const where = [leadsAll ? '1=1' : `k.responsible_id = ${Number(req.user.id)}`];
  const p = [];
  if (q.responsible_id) { where.push('k.responsible_id = ?'); p.push(Number(q.responsible_id)); }
  if (q.status === 'done') where.push('k.done_at is not null');
  else where.push('k.done_at is null');
  if (q.from) { where.push('k.due_at >= ?'); p.push(Number(q.from)); }
  if (q.to) { where.push('k.due_at < ?'); p.push(Number(q.to)); }
  // tarefa de lead de outra empresa fica na tela dela
  where.push(`(k.entity is not 'lead' or exists (select 1 from leads x join pipelines px on px.id = x.pipeline_id where x.id = k.entity_id and px.brand_id = ${Number(req.brand)}))`);
  // tarefa de lead/contato/empresa apagado some da lista (o registro não abre mais)
  where.push(`not exists (select 1 from leads x where k.entity = 'lead' and x.id = k.entity_id and x.deleted_at is not null)
    and not exists (select 1 from contacts x where k.entity = 'contact' and x.id = k.entity_id and x.deleted_at is not null)
    and not exists (select 1 from companies x where k.entity = 'company' and x.id = k.entity_id and x.deleted_at is not null)`);
  res.json(all(`select k.*, case k.entity when 'lead' then (select name from leads where id = k.entity_id) when 'contact' then (select name from contacts where id = k.entity_id)
    when 'company' then (select name from companies where id = k.entity_id) end entity_name from tasks k where ${where.join(' and ')}
    order by ${q.status === 'done' ? 'k.done_at desc' : 'k.due_at'} limit 1000`, ...p));
});
app.post('/api/tasks', (req, res) => {
  const b = req.body || {};
  if (b.entity) checkEntity(req, b.entity, b.entity_id);
  if (!String(b.text || '').trim() || !b.due_at) throw httpError(400, 'Descreva a tarefa e o prazo');
  run('insert into tasks(entity, entity_id, type_id, text, due_at, responsible_id, created_by, created_at) values(?, ?, ?, ?, ?, ?, ?, ?)',
    b.entity || null, b.entity ? Number(b.entity_id) : null, b.type_id || null, String(b.text).trim(), Number(b.due_at), b.responsible_id || req.user.id, req.user.id, now());
  if (b.entity) touch(b.entity, b.entity_id);
  emit('task');
  res.json({ ok: true });
});
app.patch('/api/tasks/:id', (req, res) => {
  const k = one('select * from tasks where id = ?', Number(req.params.id));
  if (!k) throw httpError(404, 'Tarefa não encontrada');
  if (k.entity) checkEntity(req, k.entity, k.entity_id);
  else if (k.responsible_id !== req.user.id && !req.user.is_admin) throw httpError(403, 'Sem permissão');
  const b = req.body || {};
  tx(() => {
    if (b.done === true) run('update tasks set done_at = ?, result = ? where id = ?', now(), b.result || null, k.id);
    if (b.done === false) run('update tasks set done_at = null where id = ?', k.id);
    if (b.text) run('update tasks set text = ? where id = ?', b.text, k.id);
    if (b.due_at) run('update tasks set due_at = ? where id = ?', Number(b.due_at), k.id);
    if (b.responsible_id) run('update tasks set responsible_id = ? where id = ?', Number(b.responsible_id), k.id);
    if ('type_id' in b) run('update tasks set type_id = ? where id = ?', b.type_id || null, k.id);
  });
  if (k.entity) touch(k.entity, k.entity_id);
  emit('task');
  res.json({ ok: true });
});

// ---------- conversas
// Quem só vê os próprios leads também vê conversas sem responsável, para poder atender.
function convScope(user) {
  if (user.is_admin || user.rights?.leads?.view === 'all') return '1=1';
  return `(l.responsible_id = ${Number(user.id)} or l.responsible_id is null or c.assigned_id = ${Number(user.id)})`;
}

app.get('/api/conversations', (req, res) => {
  const f = req.query.filter || 'open';
  const where = [convScope(req.user), 'ch.brand_id = ?'];
  const p = [req.brand];
  if (f === 'closed') where.push("c.status = 'closed'");
  else where.push("c.status = 'open'");
  if (f === 'unread') where.push('c.unread > 0');
  if (f === 'mine') { where.push('(l.responsible_id = ? or c.assigned_id = ?)'); p.push(req.user.id, req.user.id); }
  if (f === 'waiting') where.push("(select direction from messages m where m.conversation_id = c.id order by m.created_at desc, m.id desc limit 1) = 'in'");
  if (req.query.q) {
    where.push('(ct.name like ? or l.name like ? or exists (select 1 from messages m where m.conversation_id = c.id and m.body like ?))');
    p.push(like(req.query.q), like(req.query.q), like(req.query.q));
  }
  res.json(all(`select c.id, c.status, c.unread, c.last_message_at, c.last_inbound_at, c.lead_id, c.contact_id, ch.kind channel, ch.name channel_name, ct.name contact_name,
    l.name lead_name, l.stage_id, l.responsible_id,
    (select json_object('body', m.body, 'kind', m.kind, 'dir', m.direction, 'status', m.status) from messages m where m.conversation_id = c.id order by m.created_at desc, m.id desc limit 1) last_msg
    from conversations c join channels ch on ch.id = c.channel_id join contacts ct on ct.id = c.contact_id left join leads l on l.id = c.lead_id and l.deleted_at is null
    where ${where.join(' and ')} order by c.last_message_at desc limit 300`, ...p).map((r) => ({ ...r, last_msg: r.last_msg ? JSON.parse(r.last_msg) : null })));
});

function loadConv(req, id) {
  const c = one('select c.*, l.responsible_id from conversations c left join leads l on l.id = c.lead_id where c.id = ?', id);
  if (!c) throw httpError(404, 'Conversa não encontrada');
  const ok = one(`select 1 from conversations c left join leads l on l.id = c.lead_id where c.id = ? and ${convScope(req.user)}`, id);
  if (!ok) throw httpError(403, 'Sem acesso a esta conversa');
  return c;
}

app.get('/api/conversations/:id', (req, res) => {
  const c = loadConv(req, Number(req.params.id));
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const messages = all(`select m.*, f.name file_name, f.mime file_mime, u.name user_name from messages m left join files f on f.id = m.file_id left join users u on u.id = m.user_id
    where m.conversation_id = ? and m.created_at < ? order by m.created_at desc, m.id desc limit 200`, c.id, before).reverse();
  const channel = one('select id, kind, name from channels where id = ?', c.channel_id);
  const lead = c.lead_id ? one('select id, name, stage_id, pipeline_id, price_cents, responsible_id from leads where id = ? and deleted_at is null', c.lead_id) : null;
  res.json({ ...c, channel, contact: contactWithPoints(one('select * from contacts where id = ?', c.contact_id)), lead, messages });
});

app.post('/api/conversations/:id/messages', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  const c = loadConv(req, Number(req.params.id));
  if (c.status !== 'open') throw httpError(400, 'Reabra a conversa para responder');
  const channel = one('select * from channels where id = ?', c.channel_id);
  if (channel.status === 'disabled') throw httpError(400, 'Este canal foi desligado');
  let text = '', file = null;
  if (req.is('application/json')) text = String(req.body?.text || '').trim(); // já lido pelo express.json
  else {
    const name = decodeURIComponent(req.get('x-filename') || 'arquivo');
    file = { buf: req.body, name, mime: (req.get('content-type') || 'application/octet-stream').split(';')[0] };
    if (file.buf.length > 16 * 1024 * 1024 && !file.mime.startsWith('application/')) throw httpError(400, 'Mídia maior que 16 MB: o WhatsApp não aceita');
    text = decodeURIComponent(req.get('x-caption') || '');
  }
  if (!text && !file) throw httpError(400, 'Mensagem vazia');
  const fileId = file ? saveFile(file.buf, file.name, file.mime) : null;
  const kind = file ? (file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('audio/') ? 'audio' : file.mime.startsWith('video/') ? 'video' : 'document') : 'text';
  const mid = Number(run('insert into messages(conversation_id, direction, user_id, kind, body, file_id, status, created_at) values(?, ?, ?, ?, ?, ?, ?, ?)',
    c.id, 'out', req.user.id, kind, text, fileId, 'pending', now()).lastInsertRowid);
  run('update conversations set last_message_at = ?, unread = 0 where id = ?', now(), c.id);
  flowOnHuman(c.id); // uma pessoa respondeu: o robô para nesta conversa
  // Quem responde primeiro um lead sem dono vira o responsável.
  if (c.lead_id && !c.responsible_id) {
    run('update leads set responsible_id = ? where id = ? and responsible_id is null', req.user.id, c.lead_id);
    logEvent('lead', c.lead_id, 'responsible_changed', { from: null, to: req.user.id }, req.user.id);
  }
  emit('message', { conversation_id: c.id, lead_id: c.lead_id });
  try {
    const r = await sendMessage(channel, c.external_id, { text, file });
    run("update messages set external_id = ?, status = case when status = 'pending' then 'sent' else status end where id = ?", r.id || null, mid);
  } catch (e) {
    run("update messages set status = 'failed', error = ? where id = ?", e.message, mid);
  }
  emit('message', { conversation_id: c.id, lead_id: c.lead_id });
  res.json(one('select * from messages where id = ?', mid));
});

app.patch('/api/conversations/:id', (req, res) => {
  const c = loadConv(req, Number(req.params.id));
  const b = req.body || {};
  if (b.read) run('update conversations set unread = 0 where id = ?', c.id);
  if (b.status === 'closed') run("update conversations set status = 'closed', unread = 0 where id = ?", c.id);
  if (b.status === 'open' && c.status === 'closed') {
    if (one("select 1 from conversations where channel_id = ? and external_id = ? and status = 'open'", c.channel_id, c.external_id)) throw httpError(409, 'Já existe uma conversa aberta com este cliente');
    run("update conversations set status = 'open' where id = ?", c.id);
  }
  if ('assigned_id' in b) run('update conversations set assigned_id = ? where id = ?', b.assigned_id || null, c.id);
  emit('message', { conversation_id: c.id, lead_id: c.lead_id });
  res.json({ ok: true });
});

// Leads que chegaram pela etapa "novas conversas": aceitar, recusar ou juntar a um lead existente.
app.post('/api/conversations/:id/:action', (req, res) => {
  if (!['accept', 'decline', 'link'].includes(req.params.action)) throw httpError(404, 'Rota não encontrada');
  const c = loadConv(req, Number(req.params.id));
  const lead = c.lead_id && one('select * from leads where id = ?', c.lead_id);
  if (!lead) throw httpError(400, 'Conversa sem lead');
  const st = one('select * from stages where id = ?', lead.stage_id);
  if (st.kind !== 'incoming') throw httpError(409, 'Este lead já foi triado');
  tx(() => {
    if (req.params.action === 'accept') {
      const to = firstStage(lead.pipeline_id);
      run('update leads set stage_id = ?, responsible_id = coalesce(responsible_id, ?), updated_at = ? where id = ?', to.id, req.user.id, now(), lead.id);
      logEvent('lead', lead.id, 'stage_changed', { from: st.name, to: to.name, kind: to.kind }, req.user.id);
      flowOnStage(lead.id, to.id);
    } else if (req.params.action === 'decline') {
      run('update leads set deleted_at = ? where id = ?', now(), lead.id);
      run("update conversations set status = 'closed', lead_id = null, unread = 0 where id = ?", c.id);
    } else {
      const target = loadLead(req, Number(req.body.lead_id));
      run('update conversations set lead_id = ? where id = ?', target.id, c.id);
      run('insert or ignore into lead_contacts(lead_id, contact_id, is_main) values(?, ?, 0)', target.id, c.contact_id);
      run('update leads set deleted_at = ? where id = ?', now(), lead.id);
      logEvent('lead', target.id, 'conversation_linked', {}, req.user.id);
    }
  });
  emit('lead', { id: lead.id });
  emit('message', { conversation_id: c.id });
  res.json({ ok: true });
});

// ---------- canais
app.post('/api/channels', (req, res) => {
  admin(req);
  const { kind, name, external_id, token, pipeline_id, waba_id } = req.body || {};
  if (!['whatsapp', 'messenger', 'instagram'].includes(kind) || !external_id || !token) throw httpError(400, 'Preencha tipo, ID e token');
  if (one('select 1 from channels where kind = ? and external_id = ?', kind, String(external_id).trim())) throw httpError(409, 'Este canal já está conectado');
  run('insert into channels(kind, name, external_id, config, created_at, brand_id) values(?, ?, ?, ?, ?, ?)', kind, name || kind, String(external_id).trim(),
    JSON.stringify({ token: String(token).trim(), pipeline_id: pipeline_id || null, waba_id: String(waba_id || '').trim() }), now(), req.brand);
  emit('config');
  res.json({ ok: true });
});
app.patch('/api/channels/:id', (req, res) => {
  admin(req);
  const ch = one('select * from channels where id = ?', Number(req.params.id));
  if (!ch) throw httpError(404, 'Canal não encontrado');
  const cfg = JSON.parse(ch.config);
  const b = req.body || {};
  if (b.token) cfg.token = String(b.token).trim();
  if ('pipeline_id' in b) cfg.pipeline_id = b.pipeline_id || null;
  if ('waba_id' in b) cfg.waba_id = String(b.waba_id || '').trim();
  run('update channels set config = ?, name = coalesce(?, name), status = coalesce(?, status) where id = ?', JSON.stringify(cfg), b.name || null,
    ['active', 'disabled'].includes(b.status) ? b.status : null, ch.id);
  if (cfg.mode === 'web' && b.status === 'disabled') stopWeb(ch.id);
  if (cfg.mode === 'web' && b.status === 'active') startWeb({ ...ch, status: 'active' }).catch(() => {});
  emit('config');
  res.json({ ok: true });
});
// ---------- WhatsApp Web (QR code, como o WA Web Plus)
app.post('/api/waweb', async (req, res) => {
  admin(req);
  let ch = all("select * from channels where kind = 'whatsapp' and brand_id = ?", req.brand).find(isWeb);
  if (!ch) {
    const pid = firstPipelineOf(req.brand);
    const id = Number(run("insert into channels(kind, name, external_id, config, created_at, brand_id) values('whatsapp', 'WhatsApp Web', ?, ?, ?, ?)",
      `web-${now()}`, JSON.stringify({ mode: 'web', pipeline_id: pid }), now(), req.brand).lastInsertRowid);
    ch = one('select * from channels where id = ?', id);
    emit('config');
  } else if (ch.status === 'disabled') { run("update channels set status = 'active' where id = ?", ch.id); ch.status = 'active'; emit('config'); }
  res.json({ id: ch.id, ...(await startWeb(ch)) });
});
app.get('/api/waweb/:id', (req, res) => { admin(req); res.json(webStatus(Number(req.params.id))); });
// Reabre só o WhatsApp (sem sair da conta e sem reiniciar o servidor): para destravar e para testar se o login guardado volta.
app.post('/api/waweb/:id/restart', async (req, res) => {
  admin(req);
  const ch = one('select * from channels where id = ? and brand_id = ?', Number(req.params.id), req.brand);
  if (!ch || !isWeb(ch)) throw httpError(404, 'Canal não encontrado');
  await stopWeb(ch.id);
  res.json(await startWeb(ch));
});
app.post('/api/waweb/:id/logout', async (req, res) => {
  admin(req);
  await stopWeb(Number(req.params.id), { logout: true });
  res.json({ ok: true });
});

// ---------- caixa de e-mail da empresa (respostas das campanhas entram no CRM)
app.post('/api/mailbox', (req, res) => {
  admin(req);
  const b = req.body || {};
  const address = String(b.address || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw httpError(400, 'Informe o e-mail da caixa (ex.: contato@agro-vox.com)');
  let ch = one("select * from channels where kind = 'email' and brand_id = ?", req.brand);
  const other = one("select brand_id from channels where kind = 'email' and external_id = ? and id is not ?", address, ch?.id ?? null);
  if (other) throw httpError(409, 'Esta caixa já está ligada a outra empresa');
  const cur = ch ? JSON.parse(ch.config) : { pipeline_id: firstPipelineOf(req.brand) };
  const cfg = { ...cur, imap_host: String(b.imap_host || cur.imap_host || 'imap.gmail.com').trim(), imap_pass: String(b.imap_pass || '').replace(/\s/g, '') || cur.imap_pass || '' };
  if (ch?.external_id !== address) Object.assign(cfg, { last_uid: null, uid_validity: null }); // caixa nova: começa do zero
  let id = ch?.id;
  if (ch) run("update channels set external_id = ?, name = ?, config = ?, status = 'active' where id = ?", address, `E-mail ${address}`, JSON.stringify(cfg), ch.id);
  else id = Number(run("insert into channels(kind, name, external_id, config, created_at, brand_id) values('email', ?, ?, ?, ?, ?)", `E-mail ${address}`, address, JSON.stringify(cfg), now(), req.brand).lastInsertRowid);
  emit('config');
  res.json({ ok: true, id });
});

app.post('/api/channels/:id/test', async (req, res) => {
  admin(req);
  const ch = one('select * from channels where id = ?', Number(req.params.id));
  if (!ch) throw httpError(404, 'Canal não encontrado');
  try {
    const info = await testChannel(ch);
    run("update channels set status = 'active' where id = ? and status = 'error'", ch.id);
    res.json({ ok: true, info });
  } catch (e) {
    run("update channels set status = 'error' where id = ? and status = 'active'", ch.id);
    throw httpError(400, ch.kind === 'email' ? `Não conectou na caixa de e-mail: ${e.message}` : `A Meta recusou: ${e.message}`);
  }
});

// ---------- importar contatos (.vcf / .csv)
app.post('/api/import/contacts', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  if (!can(req.user, 'contacts', 'edit')) throw httpError(403, 'Sem permissão para criar contatos');
  const name = decodeURIComponent(req.get('x-filename') || '').toLowerCase();
  const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const isVcf = name.endsWith('.vcf') || /BEGIN:VCARD/i.test(text.slice(0, 2000));
  const list = isVcf ? parseVcf(text) : parseCsv(text);
  if (!list.length) throw httpError(400, 'Não achei contatos neste arquivo. Use .vcf (celular) ou .csv (Google Contatos / Excel).');
  const r = importContacts(list, req.user.id);
  emit('contact', {});
  res.json(r);
});

// ---------- mensagens modelo do WhatsApp
const tplOut = (t) => {
  const components = JSON.parse(t.components);
  const header_media = templateHeaderMedia(components);
  // supported = dá para mandar do cartão do contato; com imagem no topo, só pela campanha (onde se escolhe a imagem).
  return { ...t, components, vars: templateVars(components), header_media, supported: templateSupported(components) && !header_media, preview: renderTemplate(components, []) };
};
app.get('/api/templates', (req, res) => res.json(all('select t.* from wa_templates t join channels ch on ch.id = t.channel_id where ch.brand_id = ? order by t.name', req.brand).map(tplOut)));

async function syncTemplates(channel) {
  const list = await listTemplates(channel);
  tx(() => {
    const keep = [];
    for (const t of list) {
      run(`insert into wa_templates(channel_id, meta_id, name, language, category, status, components, updated_at) values(?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(channel_id, name, language) do update set meta_id = excluded.meta_id, category = excluded.category, status = excluded.status,
        components = excluded.components, updated_at = excluded.updated_at`,
        channel.id, String(t.id), t.name, t.language, t.category || null, t.status, JSON.stringify(t.components || []), now());
      keep.push(String(t.id));
    }
    for (const t of all('select id, meta_id from wa_templates where channel_id = ?', channel.id)) if (!keep.includes(t.meta_id)) run('delete from wa_templates where id = ?', t.id);
  });
  return list.length;
}

app.post('/api/templates/sync', async (req, res) => {
  admin(req);
  const chans = all("select * from channels where kind = 'whatsapp' and status != 'disabled' and brand_id = ?", req.brand).filter((c) => !isWeb(c));
  if (!chans.length) throw httpError(400, 'Modelos são só da API oficial da Meta. Pelo WhatsApp Web não precisa de modelo: escreva a mensagem direto na campanha.');
  let n = 0;
  for (const ch of chans) n += await syncTemplates(ch);
  emit('config');
  res.json({ count: n });
});

app.post('/api/templates', async (req, res) => {
  admin(req);
  const { channel_id, name, category, language, body, examples } = req.body || {};
  const ch = one("select * from channels where id = ? and kind = 'whatsapp'", Number(channel_id));
  if (!ch) throw httpError(400, 'Escolha o canal de WhatsApp');
  const clean = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!clean || !String(body || '').trim()) throw httpError(400, 'Preencha nome e texto');
  if (!['MARKETING', 'UTILITY'].includes(category)) throw httpError(400, 'Categoria inválida');
  const vars = templateVars([{ type: 'BODY', text: body }]);
  const ex = (examples || []).map((x) => String(x).trim());
  if (vars.length && ex.filter(Boolean).length < vars.length) throw httpError(400, 'A Meta exige um exemplo para cada variável');
  await createTemplate(ch, { name: clean, language: language || 'pt_BR', category, body: String(body).trim(), examples: vars.length ? ex.slice(0, vars.length) : null });
  await syncTemplates(ch);
  emit('config');
  res.json({ ok: true, name: clean });
});

// Envia um modelo para um contato. Abre (ou reaproveita) a conversa e liga ao lead.
app.post('/api/whatsapp/template', async (req, res) => {
  const { template_id, contact_id, lead_id, params = [] } = req.body || {};
  const tpl = one('select * from wa_templates where id = ?', Number(template_id));
  if (!tpl) throw httpError(404, 'Modelo não encontrado');
  const contact = one('select * from contacts where id = ? and deleted_at is null', Number(contact_id));
  if (!contact) throw httpError(404, 'Contato não encontrado');
  if (!can(req.user, 'contacts', 'view', contact)) throw httpError(403, 'Sem acesso a este contato');
  if (lead_id) loadLead(req, Number(lead_id));
  const r = await sendTemplateTo({ tpl, contact, params, userId: req.user.id, leadId: lead_id ? Number(lead_id) : null });
  res.json({ ...one('select * from messages where id = ?', r.messageId), conversation_id: r.conversationId, lead_id: r.leadId });
});

// ---------- e-mail: teste
app.post('/api/email/test', async (req, res) => {
  admin(req);
  // Com campaign_id: manda o e-mail da campanha (assunto, texto e arte) como chegaria para você. "to" opcional.
  const to = String(req.body?.to || req.user.email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw httpError(400, 'E-mail de destino inválido');
  const camp = req.body?.campaign_id && one("select * from campaigns where id = ? and channel = 'email'", Number(req.body.campaign_id));
  if (camp) {
    const me = { name: req.user.name };
    await sendEmail({ to, subject: `[TESTE] ${fillVars(camp.subject, me)}`, text: fillVars(camp.body, me), imageFileId: camp.header_file_id, brandId: camp.brand_id });
  } else await sendEmail({ to, subject: 'Teste do Semeia', text: 'Se você recebeu este e-mail, o envio de campanhas por e-mail está funcionando.', brandId: req.brand });
  res.json({ ok: true, to });
});

// ---------- painel (dashboard)
app.get('/api/dashboard', (req, res) => res.json(dashboard({ days: Number(req.query.days) || 30, pipelineId: Number(req.query.pipeline_id) || null, user: req.user, brandId: req.brand })));
// Resultado (vendas x investimento): valores da empresa inteira, só para quem vê todos os leads.
app.get('/api/results', (req, res) => {
  if (!req.user.is_admin && req.user.rights?.leads?.view !== 'all') throw httpError(403, 'Só quem vê todos os leads');
  res.json(results({ brandId: req.brand }));
});
// Investimento dos anúncios: a tarefa diária grava aqui (logada como administrador), em vez do arquivo no PC.
app.get('/api/admin/investment', (req, res) => { admin(req); res.json(readInvestment() || {}); });
app.put('/api/admin/investment', (req, res) => {
  admin(req);
  const d = req.body;
  if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.canais !== 'object') throw httpError(400, 'Formato inválido: precisa do campo "canais"');
  fs.writeFileSync(path.join(DATA_DIR, 'investimento.json'), JSON.stringify(d, null, 2));
  res.json({ ok: true, updated_at: d.updated_at || null });
});

// ---------- campanhas
const CAMP_FIELDS = ['name', 'channel', 'tags', 'template_id', 'params', 'subject', 'body', 'interval_seconds', 'interval_max_seconds', 'batch_min', 'batch_max', 'batch_pause_minutes', 'window_start', 'window_end', 'daily_cap', 'skip_recent_days', 'header_file_id', 'wa_channel_id', 'mini_every', 'mini_pause_min', 'mini_pause_max'];
function campIn(b, cur = {}) {
  const c = { ...cur };
  for (const k of CAMP_FIELDS) if (b[k] !== undefined) c[k] = ['tags', 'params'].includes(k) ? JSON.stringify(b[k] || []) : b[k];
  for (const k of ['template_id', 'wa_channel_id', 'header_file_id', 'mini_every', 'mini_pause_min', 'mini_pause_max', 'interval_max_seconds', 'batch_min', 'batch_max', 'batch_pause_minutes', 'interval_seconds', 'window_start', 'window_end', 'daily_cap', 'skip_recent_days']) if (c[k] !== undefined && c[k] !== null) c[k] = Number(c[k]);
  if (!['whatsapp', 'email'].includes(c.channel)) throw httpError(400, 'Canal inválido');
  return c;
}
// Lotes e intervalo sorteado (colunas da migração 005). Mudar o tamanho do lote recomeça a contagem do lote atual.
function saveRhythm(id, c) {
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const bmax = n(c.batch_max), bmin = bmax ? n(c.batch_min) : 0;
  const cur = one('select batch_min, batch_max from campaigns where id = ?', id);
  const changed = cur.batch_min !== bmin || cur.batch_max !== bmax;
  run(`update campaigns set interval_max_seconds = ?, batch_min = ?, batch_max = ?, batch_pause_minutes = ?, wa_channel_id = ?${changed ? ', batch_target = null, batch_sent = 0' : ''} where id = ?`,
    c.interval_max_seconds ? n(c.interval_max_seconds) : null, bmin, bmax, bmax ? n(c.batch_pause_minutes) : 0, c.wa_channel_id || null, id);
  // Pausa curta (migração 009): a cada N mensagens, de X a Y minutos.
  const every = n(c.mini_every), pmin = every ? n(c.mini_pause_min) : 0, pmax = every ? Math.max(pmin, n(c.mini_pause_max)) : 0;
  run('update campaigns set mini_every = ?, mini_pause_min = ?, mini_pause_max = ?, mini_sent = case when mini_every = ? then mini_sent else 0 end where id = ?', every, pmin, pmax, every, id);
}
const campOut = (c) => ({ ...c, tags: JSON.parse(c.tags), params: JSON.parse(c.params), stats: campaignStats(c.id) });
const loadCamp = (id) => { const c = one('select * from campaigns where id = ?', Number(id)); if (!c) throw httpError(404, 'Campanha não encontrada'); return c; };

app.get('/api/campaigns', (req, res) => { admin(req); res.json(all('select * from campaigns where brand_id = ? order by id desc', req.brand).map(campOut)); });
app.get('/api/campaigns/:id', (req, res) => {
  admin(req);
  const c = loadCamp(req.params.id);
  const recent = all(`select r.status, r.error, r.sent_at, r.replied_at, r.address, ct.id contact_id, ct.name from campaign_recipients r join contacts ct on ct.id = r.contact_id
    where r.campaign_id = ? and r.status != 'queued' order by coalesce(r.replied_at, r.sent_at, 0) desc limit 100`, c.id);
  res.json({ ...campOut(c), recent, audience: c.status === 'draft' ? audienceCount(c) : null });
});
// Quantos contatos receberiam (antes de salvar)
app.post('/api/campaigns/audience', (req, res) => {
  admin(req);
  const c = campIn({ skip_recent_days: 7, ...req.body });
  res.json({ count: audienceCount({ ...c, brand_id: req.brand }) });
});
app.post('/api/campaigns', (req, res) => {
  admin(req);
  // WhatsApp: o ritmo que já funciona no WA Web Plus — 15 a 30 s entre mensagens, 6h às 22h (Brasília), lotes de 310 a 332 e 2 h de pausa.
  const defaults = req.body?.channel === 'email'
    ? { interval_seconds: 5, window_start: 8, window_end: 20, daily_cap: 300 }
    : { interval_seconds: 15, interval_max_seconds: 30, batch_min: 310, batch_max: 332, batch_pause_minutes: 120, mini_every: 50, mini_pause_min: 20, mini_pause_max: 23, window_start: 6, window_end: 22, daily_cap: 1300 };
  // Com WhatsApp Web conectado, a campanha sai por ele (texto livre, sem modelo da Meta).
  const web = req.body?.channel !== 'email' && all("select * from channels where kind = 'whatsapp' and status != 'disabled' and brand_id = ?", req.brand).find(isWeb);
  const c = campIn({ ...defaults, skip_recent_days: 7, ...(web && { wa_channel_id: web.id }), ...req.body });
  if (c.interval_max_seconds != null && c.interval_max_seconds < c.interval_seconds) c.interval_max_seconds = c.interval_seconds;
  if (!String(c.name || '').trim()) throw httpError(400, 'Dê um nome à campanha');
  const t = now();
  const id = Number(run(`insert into campaigns(name, channel, tags, template_id, params, subject, body, interval_seconds, window_start, window_end, daily_cap, skip_recent_days, header_file_id, created_by, created_at, updated_at)
    values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, c.name.trim(), c.channel, c.tags || '[]', c.template_id || null, c.params || '[]', c.subject || '', c.body || '',
    c.interval_seconds, c.window_start, c.window_end, c.daily_cap, c.skip_recent_days, c.header_file_id || null, req.user.id, t, t).lastInsertRowid);
  saveRhythm(id, c);
  run('update campaigns set brand_id = ? where id = ?', req.brand, id);
  emit('campaign', { id });
  res.json({ id });
});
app.patch('/api/campaigns/:id', (req, res) => {
  admin(req);
  const cur = loadCamp(req.params.id);
  if (cur.status === 'running' || cur.status === 'done') throw httpError(400, 'Pause a campanha antes de editar');
  const b = { ...req.body };
  if (cur.status !== 'draft') { delete b.tags; delete b.channel; delete b.skip_recent_days; } // o público já foi congelado
  const c = campIn(b, cur);
  run(`update campaigns set name = ?, channel = ?, tags = ?, template_id = ?, params = ?, subject = ?, body = ?, interval_seconds = ?, window_start = ?, window_end = ?,
    daily_cap = ?, skip_recent_days = ?, header_file_id = ?, updated_at = ? where id = ?`, String(c.name).trim(), c.channel, c.tags, c.template_id || null, c.params, c.subject, c.body,
    c.interval_seconds, c.window_start, c.window_end, c.daily_cap, c.skip_recent_days, c.header_file_id || null, now(), cur.id);
  saveRhythm(cur.id, c);
  emit('campaign', { id: cur.id });
  res.json({ ok: true });
});
app.post('/api/campaigns/:id/start', (req, res) => { admin(req); res.json(campOut(startCampaign(loadCamp(req.params.id).id))); });
app.post('/api/campaigns/:id/pause', (req, res) => { admin(req); pauseCampaign(loadCamp(req.params.id).id, 'Pausada por você'); res.json({ ok: true }); });
app.post('/api/campaigns/:id/duplicate', (req, res) => {
  admin(req);
  const c = loadCamp(req.params.id);
  const t = now();
  const id = Number(run(`insert into campaigns(name, channel, tags, template_id, params, subject, body, interval_seconds, window_start, window_end, daily_cap, skip_recent_days, header_file_id, header_media, created_by, created_at, updated_at)
    select name || ' (cópia)', channel, tags, template_id, params, subject, body, interval_seconds, window_start, window_end, daily_cap, skip_recent_days, header_file_id, header_media, ?, ?, ? from campaigns where id = ?`,
    req.user.id, t, t, c.id).lastInsertRowid);
  saveRhythm(id, c);
  run('update campaigns set brand_id = ? where id = ?', c.brand_id, id);
  emit('campaign', { id });
  res.json({ id });
});
app.delete('/api/campaigns/:id', (req, res) => {
  admin(req);
  const c = loadCamp(req.params.id);
  if (c.status === 'running') throw httpError(400, 'Pause a campanha antes de apagar');
  run('delete from campaigns where id = ?', c.id);
  emit('campaign', { id: c.id });
  res.json({ ok: true });
});

// ---------- fluxos automáticos (robô de respostas e follow-ups)
const flowOut = (f) => ({ ...f, active: !!f.active, graph: JSON.parse(f.graph), trigger_config: JSON.parse(f.trigger_config),
  runs: Object.fromEntries(all('select state, count(*) n from flow_runs where flow_id = ? group by state', f.id).map((r) => [r.state, r.n])) });
const loadFlowRow = (id) => { const f = one('select * from flows where id = ?', Number(id)); if (!f) throw httpError(404, 'Fluxo não encontrado'); return f; };
const TRIGGERS = ['campaign_reply', 'new_conversation', 'stage_changed', 'ad_click'];
app.get('/api/flows', (req, res) => { admin(req); res.json(all('select * from flows where brand_id = ? order by id', req.brand).map(flowOut)); });
app.get('/api/flows/:id', (req, res) => {
  admin(req);
  const f = loadFlowRow(req.params.id);
  const runs = all(`select r.id, r.state, r.node_id, r.error, r.wake_at, r.updated_at, r.created_at, r.conversation_id, ct.id contact_id, ct.name contact_name
    from flow_runs r join conversations c on c.id = r.conversation_id join contacts ct on ct.id = c.contact_id where r.flow_id = ? order by r.updated_at desc limit 100`, f.id);
  res.json({ ...flowOut(f), recent: runs });
});
app.post('/api/flows', (req, res) => {
  admin(req);
  const b = req.body || {};
  const graph = b.graph || { nodes: [{ id: 'start', type: 'start', x: 60, y: 160, data: {} }], edges: [] };
  validateGraph(graph);
  const t = now();
  const id = Number(run('insert into flows(name, trigger, trigger_config, active, graph, created_at, updated_at, brand_id) values(?, ?, ?, 0, ?, ?, ?, ?)',
    String(b.name || 'Novo fluxo').trim(), TRIGGERS.includes(b.trigger) ? b.trigger : 'campaign_reply', JSON.stringify(b.trigger_config || {}), JSON.stringify(graph), t, t, req.brand).lastInsertRowid);
  emit('flow', {});
  res.json({ id });
});
app.patch('/api/flows/:id', (req, res) => {
  admin(req);
  const cur = flowOut(loadFlowRow(req.params.id));
  const b = req.body || {};
  const f = { ...cur, ...b };
  if (!TRIGGERS.includes(f.trigger)) throw httpError(400, 'Gatilho inválido');
  if (!String(f.name || '').trim()) throw httpError(400, 'Dê um nome ao fluxo');
  validateGraph(f.graph);
  if (f.trigger === 'stage_changed' && !f.trigger_config?.stage_id) throw httpError(400, 'Escolha a etapa que dispara o fluxo');
  if (f.active) {
    const g = f.graph;
    if (g.nodes.some((n) => ['ai_reply', 'ai_classify'].includes(n.type)) && !getSetting('ai', {}).api_key) throw httpError(400, 'Este fluxo usa IA: coloque a chave da Anthropic em Ajustes > Assistente de IA antes de ligar');
    const start = g.nodes.find((n) => n.type === 'start');
    if (!g.edges.some((e) => e.from === start.id)) throw httpError(400, 'Ligue o Início a algum passo antes de ativar');
  }
  run('update flows set name = ?, trigger = ?, trigger_config = ?, active = ?, graph = ?, updated_at = ? where id = ?',
    String(f.name).trim(), f.trigger, JSON.stringify(f.trigger_config || {}), f.active ? 1 : 0, JSON.stringify(f.graph), now(), cur.id);
  emit('flow', {});
  res.json(flowOut(loadFlowRow(cur.id)));
});
app.post('/api/flows/:id/duplicate', (req, res) => {
  admin(req);
  const f = loadFlowRow(req.params.id);
  const t = now();
  const id = Number(run("insert into flows(name, trigger, trigger_config, active, graph, created_at, updated_at, brand_id) values(?, ?, ?, 0, ?, ?, ?, ?)",
    `${f.name} (cópia)`, f.trigger, f.trigger_config, f.graph, t, t, f.brand_id).lastInsertRowid);
  emit('flow', {});
  res.json({ id });
});
app.delete('/api/flows/:id', (req, res) => {
  admin(req);
  const f = loadFlowRow(req.params.id);
  run('delete from flows where id = ?', f.id);
  emit('flow', {});
  res.json({ ok: true });
});
// Testa o desenho (salvo ou não) sem enviar nada: a IA é chamada de verdade se o fluxo tiver nó de IA.
app.post('/api/flows/simulate', async (req, res) => {
  admin(req);
  const { graph, sim, action } = req.body || {};
  res.json(await simulate(graph, sim, action || { type: 'start' }, req.brand));
});
app.post('/api/flow-runs/:id/stop', (req, res) => {
  admin(req);
  run("update flow_runs set state = 'stopped', error = 'parado por você', wake_at = null, updated_at = ? where id = ? and state in ('running','waiting_reply','waiting_time')", now(), Number(req.params.id));
  emit('flow', {});
  res.json({ ok: true });
});
app.get('/api/flows-meta', (req, res) => { admin(req); res.json({ ports: Object.fromEntries(['start', 'message', 'question', 'wait', 'ai_classify', 'ai_reply', 'stage', 'tag', 'handoff', 'end'].map((t) => [t, portsOf({ type: t })])) }); });
app.post('/api/ai/test', async (req, res) => {
  admin(req);
  const text = await claude({ system: 'Responda só com: ok, funcionando', messages: [{ role: 'user', content: 'teste' }], maxTokens: 20, brandId: req.brand });
  res.json({ ok: true, text });
});

// ---------- arquivos
// Envio de arquivo avulso (ex.: a arte da campanha). Devolve o id.
app.post('/api/files', express.raw({ type: () => true, limit: '16mb' }), (req, res) => {
  admin(req);
  const name = decodeURIComponent(req.get('x-filename') || 'arquivo');
  const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0];
  if (!req.body?.length) throw httpError(400, 'Arquivo vazio');
  if (!/^image\/(jpeg|png)$/.test(mime)) throw httpError(400, 'Use uma imagem JPG ou PNG (é o que o WhatsApp aceita no topo do modelo)');
  if (req.body.length > 5 * 1024 * 1024) throw httpError(400, 'Imagem maior que 5 MB: o WhatsApp não aceita');
  res.json({ id: saveFile(req.body, name, mime), name, mime });
});
const INLINE = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/|application\/pdf)/;
app.get('/api/files/:id', (req, res) => {
  const f = one('select * from files where id = ?', Number(req.params.id));
  if (!f) throw httpError(404, 'Arquivo não encontrado');
  // shortcut: qualquer usuário logado abre qualquer arquivo pelo id; amarrar ao acesso da conversa se houver dados sensíveis.
  const inline = INLINE.test(f.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', inline ? f.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  fs.createReadStream(path.join(UPLOAD_DIR, f.path)).on('error', () => res.status(404).end()).pipe(res);
});

// ---------- erros
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  if (err.message?.includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'Já existe um registro com esses dados' });
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno. Veja o terminal do servidor.' });
});
