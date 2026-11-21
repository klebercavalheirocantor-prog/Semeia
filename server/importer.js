// Importa contatos de .vcf (celular, iCloud) e .csv (Google Contatos, Excel).
import { one, all, run, now, tx } from './db.js';
import { normPoint } from './crm.js';

const unescape = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function decodeQP(v) {
  const bytes = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '=' && /^[0-9A-F]{2}$/i.test(v.slice(i + 1, i + 3))) { bytes.push(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...Buffer.from(v[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseVcf(text) {
  // junta linhas dobradas (começam com espaço) e quebras "soft" do quoted-printable (terminam com "=")
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (const l of raw) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && /^[ \t]/.test(l)) lines[lines.length - 1] = prev + l.slice(1);
    else if (prev !== undefined && /QUOTED-PRINTABLE/i.test(prev) && prev.endsWith('=')) lines[lines.length - 1] = prev.slice(0, -1) + l;
    else lines.push(l);
  }
  const out = [];
  let cur = null;
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [prop, ...params] = line.slice(0, idx).split(';');
    const key = prop.replace(/^[^.]*\./, '').toUpperCase();
    let val = line.slice(idx + 1);
    if (params.some((p) => /QUOTED-PRINTABLE/i.test(p))) val = decodeQP(val);
    if (key === 'BEGIN' && /VCARD/i.test(val)) cur = { name: '', n: '', phones: [], emails: [], org: '' };
    else if (key === 'END' && cur) { out.push({ ...cur, name: cur.name || cur.n }); cur = null; }
    else if (!cur) continue;
    else if (key === 'FN') cur.name = unescape(val);
    else if (key === 'N') { const [last, first, middle] = val.split(';').map(unescape); cur.n = [first, middle, last].filter(Boolean).join(' '); }
    else if (key === 'TEL') cur.phones.push(unescape(val).replace(/^tel:/i, ''));
    else if (key === 'EMAIL') cur.emails.push(unescape(val));
    else if (key === 'ORG') cur.org = unescape(val.split(';')[0]);
  }
  return out;
}

export function parseCsvRows(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split('\n')[0];
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function parseCsv(text) {
  const [head, ...rows] = parseCsvRows(text);
  if (!head) return [];
  const h = head.map(plain);
  const find = (re, not = /label|type|tipo|rotulo/) => h.map((x, i) => (re.test(x) && !not.test(x) ? i : -1)).filter((i) => i >= 0);
  const nameCol = find(/^(name|nome|full name|nome completo|display name|contato)$/);
  const firstCol = find(/^(first name|given name|primeiro nome|nome proprio)$/);
  const middleCol = find(/^(middle name|additional name|nome do meio)$/);
  const lastCol = find(/^(last name|family name|sobrenome|ultimo nome)$/);
  const phoneCols = find(/phone|telefone|celular|whats|fone|mobile/);
  const emailCols = find(/e-?mail/);
  const orgCol = find(/^(organization name|organization 1 - name|company|empresa|organizacao)$/);
  const tagCols = find(/^(tags?|etiquetas?|labels?)$/, /^$/);
  return rows.map((r) => {
    const get = (cols) => cols.map((i) => (r[i] || '').trim()).filter(Boolean);
    const split = (vals) => vals.flatMap((v) => v.split(/\s*:::\s*/)).filter(Boolean);
    const name = get(nameCol)[0] || [...get(firstCol), ...get(middleCol), ...get(lastCol)].join(' ');
    const tags = get(tagCols).flatMap((v) => v.split(/\s*[,;|]\s*|\s*:::\s*/)).filter(Boolean);
    return { name, phones: split(get(phoneCols)), emails: split(get(emailCols)), org: get(orgCol)[0] || '', ...(tags.length && { tags }) };
  });
}

// Acrescenta etiquetas sem tirar as que o contato já tem. Devolve quantas eram novas.
function addTags(contactId, names) {
  let added = 0;
  for (const raw of names || []) {
    const name = String(raw).trim();
    if (!name) continue;
    let t = one('select id from tags where name = ?', name);
    if (!t) t = { id: Number(run('insert into tags(name) values(?)', name).lastInsertRowid) };
    added += Number(run('insert or ignore into entity_tags(entity, entity_id, tag_id) values(?, ?, ?)', 'contact', contactId, t.id).changes);
  }
  return added;
}

// Cria quem é novo; em quem já existe (mesmo telefone ou email) só acrescenta o que falta (telefones, emails, etiquetas).
export function importContacts(list, userId) {
  const res = { created: 0, updated: 0, skipped: 0, total: list.length };
  tx(() => {
    for (const c of list) {
      const pts = [...c.phones.map((v) => ['phone', v]), ...c.emails.map((v) => ['email', v])]
        .map(([kind, value]) => ({ kind, value: value.trim(), norm: normPoint(kind, value) })).filter((p) => p.norm);
      const uniq = pts.filter((p, i) => pts.findIndex((x) => x.kind === p.kind && x.norm === p.norm) === i);
      if (!uniq.length && !c.name) { res.skipped++; continue; }
      const owners = uniq.map((p) => one('select p.contact_id from contact_points p join contacts c on c.id = p.contact_id where p.kind = ? and p.value_norm = ? and c.deleted_at is null', p.kind, p.norm)?.contact_id);
      const existing = owners.find(Boolean);
      const free = uniq.filter((p, i) => !owners[i]);
      if (existing) {
        const novasTags = addTags(existing, c.tags);
        if (!free.length && !novasTags) { res.skipped++; continue; }
        for (const p of free) run('insert into contact_points(contact_id, kind, value, value_norm) values(?, ?, ?, ?)', existing, p.kind, p.value, p.norm);
        run('update contacts set updated_at = ? where id = ?', now(), existing);
        res.updated++;
        continue;
      }
      if (!c.name && !free.length) { res.skipped++; continue; }
      let companyId = null;
      if (c.org) {
        companyId = one('select id from companies where name = ? collate nocase and deleted_at is null', c.org)?.id;
        if (!companyId) companyId = Number(run('insert into companies(name, responsible_id, created_by, created_at, updated_at) values(?, ?, ?, ?, ?)', c.org, userId, userId, now(), now()).lastInsertRowid);
      }
      const t = now();
      const id = Number(run('insert into contacts(name, company_id, responsible_id, created_by, created_at, updated_at) values(?, ?, ?, ?, ?, ?)',
        (c.name || free[0].value).slice(0, 200), companyId, userId, userId, t, t).lastInsertRowid);
      for (const p of free) run('insert into contact_points(contact_id, kind, value, value_norm) values(?, ?, ?, ?)', id, p.kind, p.value, p.norm);
      addTags(id, c.tags);
      res.created++;
    }
  });
  return res;
}
