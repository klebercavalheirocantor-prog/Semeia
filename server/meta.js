// Graph API oficial da Meta: WhatsApp Cloud API, Messenger e Instagram Messaging, com o app e os tokens do usuário.
import crypto from 'node:crypto';
import { sendWeb, webStatus } from './waweb.js';
import { sendMail } from './mailbox.js';
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, run, now, uploadDir } from './db.js';

const graph = (p) => `https://graph.facebook.com/${getSetting('meta', {}).graph_version || 'v23.0'}/${p}`;

export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const WA_KINDS = { text: 'text', image: 'image', audio: 'audio', voice: 'audio', video: 'video', document: 'document', sticker: 'sticker', location: 'location' };

// Transforma o corpo do webhook numa lista neutra de itens.
// { type:'message', kind, channelExternalId, userId, userName, direction, msg:{external_id, kind, body, media} }
// { type:'status', channelExternalId, external_id, status, error }
export function parseWebhook(body) {
  const out = [];
  if (body?.object === 'whatsapp_business_account') {
    for (const e of body.entry || []) for (const ch of e.changes || []) {
      if (ch.field === 'message_template_status_update') {
        out.push({ type: 'template_status', meta_id: String(ch.value?.message_template_id || ''), status: ch.value?.event });
        continue;
      }
      if (ch.field !== 'messages') continue;
      const v = ch.value || {};
      const pid = v.metadata?.phone_number_id;
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        if (m.type === 'reaction') continue; // shortcut: reações recebidas são ignoradas; mostrar na bolha na fase 2.
        const kind = WA_KINDS[m.type] || 'other';
        const media = m[m.type]?.id ? { id: m[m.type].id, mime: m[m.type].mime_type, filename: m[m.type].filename } : null;
        let text = m.text?.body || m[m.type]?.caption || '';
        if (m.type === 'location') text = `📍 ${m.location.name || ''} https://maps.google.com/?q=${m.location.latitude},${m.location.longitude}`.trim();
        if (m.type === 'button') text = m.button?.text || '';
        if (m.type === 'interactive') text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
        if (kind === 'other' && !text) text = `[${m.type}]`;
        out.push({ type: 'message', kind: 'whatsapp', channelExternalId: pid, userId: m.from, userName: names[m.from] || m.from, direction: 'in',
          ts: Number(m.timestamp) * 1000, msg: { external_id: m.id, kind: m.type === 'button' || m.type === 'interactive' ? 'text' : kind, body: text, media } });
      }
      for (const s of v.statuses || []) out.push({ type: 'status', channelExternalId: pid, external_id: s.id, status: s.status, error: s.errors?.[0] ? `${s.errors[0].code} ${s.errors[0].title || ''}`.trim() : null });
    }
  }
  if (body?.object === 'page' || body?.object === 'instagram') {
    const kind = body.object === 'page' ? 'messenger' : 'instagram';
    for (const e of body.entry || []) for (const ev of e.messaging || []) {
      const m = ev.message;
      if (!m || m.is_deleted) continue;
      const echo = !!m.is_echo;
      const att = m.attachments?.[0];
      const attKind = { image: 'image', audio: 'audio', video: 'video', file: 'document' }[att?.type] || (att ? 'other' : 'text');
      out.push({ type: 'message', kind, channelExternalId: String(e.id), userId: String(echo ? ev.recipient.id : ev.sender.id), userName: null,
        direction: echo ? 'out' : 'in', ts: ev.timestamp || now(),
        msg: { external_id: m.mid, kind: attKind, body: m.text || (att && !att.payload?.url ? `[${att.type}]` : ''), media: att?.payload?.url ? { url: att.payload.url } : null } });
    }
  }
  return out;
}

async function graphFetch(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    throw Object.assign(new Error(e.code === 131047 ? 'Fora da janela de 24 h: o WhatsApp só aceita mensagem modelo (template) aprovada.' : `${e.code || res.status} ${e.message || 'erro na Meta'}`), { status: 502, metaCode: e.code });
  }
  return data;
}

function saveFile(buf, name, mime) {
  const safe = String(name || 'arquivo').replace(/[^\w.\-]+/g, '_').slice(-80);
  const rel = `${now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`;
  fs.writeFileSync(path.join(uploadDir(), rel), buf);
  return Number(run('insert into files(name, mime, size, path, created_at) values(?, ?, ?, ?, ?)', safe, mime || 'application/octet-stream', buf.length, rel, now()).lastInsertRowid);
}
export { saveFile };

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'application/pdf': 'pdf' };

export async function downloadMedia(channel, media) {
  if (media.buf) return saveFile(media.buf, media.name, media.mime); // WhatsApp Web já entrega o arquivo baixado
  const cfg = JSON.parse(channel.config);
  let url = media.url, headers = {};
  let mime = media.mime;
  if (media.id) {
    const info = await graphFetch(graph(media.id), cfg.token);
    url = info.url;
    mime = info.mime_type || mime;
    headers = { Authorization: `Bearer ${cfg.token}` };
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download ${res.status}`);
  mime = mime || res.headers.get('content-type')?.split(';')[0];
  const buf = Buffer.from(await res.arrayBuffer());
  const base = (mime || '').split(';')[0];
  return saveFile(buf, media.filename || `midia.${EXT[base] || 'bin'}`, base);
}

export async function fetchProfileName(channel, userId) {
  const cfg = JSON.parse(channel.config);
  const fields = channel.kind === 'instagram' ? 'name,username' : 'first_name,last_name';
  const p = await graphFetch(graph(`${userId}?fields=${fields}`), cfg.token);
  return p.name || p.username || [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
}

const waType = (mime) => (mime?.startsWith('image/') ? 'image' : mime?.startsWith('audio/') ? 'audio' : mime?.startsWith('video/') ? 'video' : 'document');

// Sobe um arquivo para o WhatsApp e devolve o id da mídia (vale 30 dias na Meta).
export async function uploadMedia(channel, file) {
  const cfg = JSON.parse(channel.config);
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', file.mime);
  fd.append('file', new Blob([file.buf], { type: file.mime }), file.name);
  return (await graphFetch(graph(`${channel.external_id}/media`), cfg.token, { method: 'POST', body: fd })).id;
}

// Envia e devolve o id externo da mensagem. buttons: até 3 respostas rápidas (títulos de até 20 letras).
export async function sendMessage(channel, to, { text, file, buttons }) {
  const cfg = JSON.parse(channel.config);
  if (cfg.mode === 'web') return sendWeb(channel, to, { text, file, buttons }); // WhatsApp Web (QR code)
  if (channel.kind === 'email') return sendMail(channel, to, { text, file, buttons }); // caixa de e-mail da empresa
  buttons = (buttons || []).filter(Boolean).slice(0, 3);
  if (channel.kind === 'whatsapp') {
    let payload;
    if (file) {
      const t = waType(file.mime);
      payload = { type: t, [t]: { id: await uploadMedia(channel, file), ...(t === 'document' ? { filename: file.name } : {}), ...(text && t !== 'audio' ? { caption: text } : {}) } };
    } else if (buttons.length) {
      payload = { type: 'interactive', interactive: { type: 'button', body: { text: text.slice(0, 1024) },
        action: { buttons: buttons.map((b, i) => ({ type: 'reply', reply: { id: `b${i}`, title: String(b).slice(0, 20) } })) } } };
    } else payload = { type: 'text', text: { body: text, preview_url: true } };
    const r = await graphFetch(graph(`${channel.external_id}/messages`), cfg.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }) });
    return { id: r.messages?.[0]?.id, wa_id: r.contacts?.[0]?.wa_id };
  }
  // Messenger e Instagram (pela Página do Facebook ligada)
  const url = graph('me/messages');
  if (file) {
    if (channel.kind === 'instagram') throw Object.assign(new Error('Envio de arquivo pelo Instagram ainda não é suportado. Envie texto.'), { status: 400 });
    const fd = new FormData();
    fd.append('recipient', JSON.stringify({ id: to }));
    fd.append('messaging_type', 'RESPONSE');
    const t = { image: 'image', audio: 'audio', video: 'video' }[waType(file.mime)] || 'file';
    fd.append('message', JSON.stringify({ attachment: { type: t, payload: { is_reusable: false } } }));
    fd.append('filedata', new Blob([file.buf], { type: file.mime }), file.name);
    const r = await graphFetch(url, cfg.token, { method: 'POST', body: fd });
    if (text) await sendMessage(channel, to, { text });
    return { id: r.message_id };
  }
  const message = buttons.length ? { text, quick_replies: buttons.map((b) => ({ content_type: 'text', title: String(b).slice(0, 20), payload: String(b) })) } : { text };
  const r = await graphFetch(url, cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: to }, messaging_type: 'RESPONSE', message }) });
  return { id: r.message_id };
}

// ---------- mensagens modelo (templates) do WhatsApp
// Variáveis do corpo, na ordem: {{1}}, {{2}}... ou nomeadas {{nome}}.
export function templateVars(components) {
  const body = components.find((c) => c.type === 'BODY')?.text || '';
  return [...new Set([...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];
}
export function renderTemplate(components, params) {
  const vars = templateVars(components);
  const body = components.find((c) => c.type === 'BODY')?.text || '';
  const header = components.find((c) => c.type === 'HEADER' && c.format === 'TEXT')?.text;
  const text = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => params[vars.indexOf(v)] ?? '');
  return header ? `*${header}*
${text}` : text;
}
// Cabeçalho com mídia (IMAGE, VIDEO ou DOCUMENT): a campanha manda o arquivo junto.
export function templateHeaderMedia(components) {
  const h = components.find((c) => c.type === 'HEADER');
  return h && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(h.format) ? h.format : null;
}
// Corpo com variáveis, cabeçalho de texto fixo ou de mídia; botões com variável ficam para depois.
export function templateSupported(components) {
  const header = components.find((c) => c.type === 'HEADER');
  if (header && header.format === 'TEXT' && /\{\{/.test(header.text || '')) return false;
  if (header && !['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format)) return false;
  return !components.some((c) => c.type === 'BUTTONS' && c.buttons?.some((b) => /\{\{/.test(b.url || '')));
}

export async function listTemplates(channel) {
  const cfg = JSON.parse(channel.config);
  if (!cfg.waba_id) throw Object.assign(new Error('Falta o ID da conta do WhatsApp (WABA ID) neste canal'), { status: 400 });
  let url = graph(`${cfg.waba_id}/message_templates?fields=id,name,language,status,category,components&limit=100`);
  const out = [];
  for (let page = 0; url && page < 20; page++) {
    const r = await graphFetch(url, cfg.token);
    out.push(...(r.data || []));
    url = r.paging?.next;
  }
  return out;
}

export async function createTemplate(channel, { name, language, category, body, examples }) {
  const cfg = JSON.parse(channel.config);
  if (!cfg.waba_id) throw Object.assign(new Error('Falta o ID da conta do WhatsApp (WABA ID) neste canal'), { status: 400 });
  const comp = { type: 'BODY', text: body };
  if (examples?.length) comp.example = { body_text: [examples] };
  return graphFetch(graph(`${cfg.waba_id}/message_templates`), cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language, category, components: [comp] }) });
}

// headerMediaId: id da mídia já enviada à Meta (uploadMedia) para modelos com imagem/vídeo/documento no cabeçalho.
export async function sendTemplate(channel, to, tpl, params, headerMediaId = null) {
  const cfg = JSON.parse(channel.config);
  const components = JSON.parse(tpl.components);
  const vars = templateVars(components);
  const named = vars.some((v) => !/^\d+$/.test(v));
  const template = { name: tpl.name, language: { code: tpl.language }, components: [] };
  const media = templateHeaderMedia(components);
  if (media) {
    if (!headerMediaId) throw Object.assign(new Error('Este modelo tem imagem/vídeo no cabeçalho: escolha o arquivo na campanha'), { status: 400 });
    const t = media.toLowerCase();
    template.components.push({ type: 'header', parameters: [{ type: t, [t]: { id: headerMediaId } }] });
  }
  if (vars.length) template.components.push({ type: 'body', parameters: vars.map((v, i) => ({ type: 'text', text: String(params[i] ?? ''), ...(named ? { parameter_name: v } : {}) })) });
  if (!template.components.length) delete template.components;
  const r = await graphFetch(graph(`${channel.external_id}/messages`), cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template }) });
  return { id: r.messages?.[0]?.id, wa_id: r.contacts?.[0]?.wa_id };
}

export async function testChannel(channel) {
  const cfg = JSON.parse(channel.config);
  if (channel.kind === 'email') {
    const { pollMailbox } = await import('./mailbox.js');
    await pollMailbox(channel);
    return { display_phone_number: channel.external_id };
  }
  if (cfg.mode === 'web') {
    const st = webStatus(channel.id);
    if (st.state !== 'ready') throw Object.assign(new Error('WhatsApp Web desconectado: clique em Conectar e leia o QR code'), { status: 400 });
    return { display_phone_number: st.me };
  }
  const fields = channel.kind === 'whatsapp' ? 'display_phone_number,verified_name' : 'name';
  return graphFetch(graph(`${channel.external_id}?fields=${fields}`), cfg.token);
}
