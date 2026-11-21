import { one, all, run, now, tx } from './db.js';
import { emit } from './bus.js';

// --- telefones: guardamos só dígitos, com DDI e com o 9 do celular brasileiro
// shortcut: assume Brasil (DDI 55) para números sem DDI; trocar por libphonenumber se atender outros países.
export function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d;
  // 55 + DDD + 8 dígitos começando em 6-9 é celular antigo sem o 9: o WhatsApp às vezes manda assim.
  if (d.length === 12 && d.startsWith('55') && /[6-9]/.test(d[4])) d = d.slice(0, 4) + '9' + d.slice(4);
  return d;
}
export const normEmail = (v) => String(v || '').trim().toLowerCase();
export const normPoint = (kind, v) => (kind === 'phone' ? normPhone(v) : normEmail(v));

export function findContactByPoint(kind, value) {
  const n = normPoint(kind, value);
  if (!n) return null;
  return one(`select c.* from contact_points p join contacts c on c.id = p.contact_id where p.kind = ? and p.value_norm = ? and c.deleted_at is null`, kind, n);
}

// Substitui telefones/emails do contato. Erro claro se outro contato já usa o número.
export function setPoints(contactId, kind, values) {
  run('delete from contact_points where contact_id = ? and kind = ?', contactId, kind);
  for (const v of values || []) {
    const n = normPoint(kind, v);
    if (!n) continue;
    const other = one('select c.id, c.name from contact_points p join contacts c on c.id = p.contact_id where p.kind = ? and p.value_norm = ?', kind, n);
    if (other && other.id !== contactId) throw httpError(409, `${kind === 'phone' ? 'Telefone' : 'Email'} ${v} já pertence ao contato "${other.name}"`);
    if (!other) run('insert into contact_points(contact_id, kind, value, value_norm) values(?, ?, ?, ?)', contactId, kind, String(v).trim(), n);
  }
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function logEvent(entity, entityId, type, data = {}, userId = null) {
  run('insert into events(entity, entity_id, type, data, user_id, created_at) values(?, ?, ?, ?, ?, ?)', entity, entityId, type, JSON.stringify(data), userId, now());
}

// --- tags por nome (cria as que não existem)
export function setTags(entity, id, names) {
  run('delete from entity_tags where entity = ? and entity_id = ?', entity, id);
  for (const raw of names || []) {
    const name = String(raw).trim();
    if (!name) continue;
    let t = one('select id from tags where name = ?', name);
    if (!t) t = { id: Number(run('insert into tags(name) values(?)', name).lastInsertRowid) };
    run('insert or ignore into entity_tags(entity, entity_id, tag_id) values(?, ?, ?)', entity, id, t.id);
  }
}
export const getTags = (entity, id) =>
  all('select t.id, t.name, t.color from entity_tags et join tags t on t.id = et.tag_id where et.entity = ? and et.entity_id = ? order by t.name', entity, id);

// --- campos personalizados: { field_id: valor }; valor vazio apaga
export function setFields(entity, id, values) {
  for (const [fid, val] of Object.entries(values || {})) {
    const f = one('select id from custom_fields where id = ? and entity = ?', Number(fid), entity);
    if (!f) continue;
    const empty = val === null || val === '' || (Array.isArray(val) && !val.length) || val === false;
    if (empty) run('delete from field_values where entity = ? and entity_id = ? and field_id = ?', entity, id, f.id);
    else run('insert into field_values(entity, entity_id, field_id, value) values(?, ?, ?, ?) on conflict do update set value = excluded.value', entity, id, f.id, JSON.stringify(val));
  }
}
export function getFields(entity, id) {
  const out = {};
  for (const r of all('select field_id, value from field_values where entity = ? and entity_id = ?', entity, id)) out[r.field_id] = JSON.parse(r.value);
  return out;
}

export function firstStage(pipelineId, preferIncoming = false) {
  const kinds = preferIncoming ? "('incoming','normal')" : "('normal')";
  return one(`select * from stages where pipeline_id = ? and kind in ${kinds} order by case kind when 'incoming' then 0 else 1 end, sort limit 1`, pipelineId);
}

export function createContact({ name, phones = [], emails = [], company_id = null, responsible_id = null }, userId = null) {
  return tx(() => {
    const t = now();
    const id = Number(run('insert into contacts(name, company_id, responsible_id, created_by, created_at, updated_at) values(?, ?, ?, ?, ?, ?)',
      String(name || 'Sem nome').trim(), company_id, responsible_id, userId, t, t).lastInsertRowid);
    setPoints(id, 'phone', phones);
    setPoints(id, 'email', emails);
    return id;
  });
}

export function createLead({ name, price_cents = 0, stage_id, responsible_id = null, contact_id = null, company_id = null, source = 'manual' }, userId = null) {
  return tx(() => {
    const st = one('select * from stages where id = ?', stage_id);
    if (!st) throw httpError(400, 'Etapa inválida');
    const t = now();
    const id = Number(run(`insert into leads(name, price_cents, pipeline_id, stage_id, company_id, responsible_id, created_by, created_at, updated_at, closed_at)
      values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, String(name || 'Novo lead').trim(), Math.round(price_cents) || 0, st.pipeline_id, st.id, company_id, responsible_id, userId, t, t,
      st.kind === 'won' || st.kind === 'lost' ? t : null).lastInsertRowid);
    if (contact_id) run('insert or ignore into lead_contacts(lead_id, contact_id, is_main) values(?, ?, 1)', id, contact_id);
    logEvent('lead', id, 'lead_added', { source, stage: st.name }, userId);
    emit('lead', { id });
    return id;
  });
}

// Lead aberto (não ganho/perdido) mais recente do contato, na empresa (brand) informada
export function openLeadOf(contactId, brandId = null) {
  return one(`select l.* from leads l join lead_contacts lc on lc.lead_id = l.id join stages s on s.id = l.stage_id join pipelines p on p.id = l.pipeline_id
    where lc.contact_id = ? and l.deleted_at is null and s.kind in ('incoming','normal') and (? is null or p.brand_id = ?) order by l.updated_at desc limit 1`,
    contactId, brandId, brandId);
}

// ---------- empresas (AgroVox, AgroPool...): o que é de cada uma
// Ajustes por empresa: a empresa 1 usa a chave antiga ("email"); as outras, "email:2".
export const brandKey = (key, brandId) => (!brandId || Number(brandId) === 1 ? key : `${key}:${Number(brandId)}`);
export const brandOfChannel = (channelId) => one('select brand_id from channels where id = ?', channelId)?.brand_id ?? 1;
export const firstPipelineOf = (brandId) => one('select id from pipelines where brand_id = ? order by sort, id limit 1', brandId ?? 1)?.id
  ?? one('select id from pipelines order by sort, id limit 1').id;
export const isOptedOut = (contactId, brandId) => !!one('select 1 from contact_optouts where contact_id = ? and brand_id = ?', contactId, brandId ?? 1);
export function setOptOut(contactId, brandId, on, t = Date.now()) {
  if (on) run('insert or ignore into contact_optouts(contact_id, brand_id, at) values(?, ?, ?)', contactId, brandId ?? 1, t);
  else run('delete from contact_optouts where contact_id = ? and brand_id = ?', contactId, brandId ?? 1);
}
