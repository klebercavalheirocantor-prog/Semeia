// Envio para fora: modelo do WhatsApp para um contato e e-mail (Resend). Usado pelo cartão do contato e pelas campanhas.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { one, run, now, tx, getSetting, setSetting, uploadDir, accountId } from './db.js';
import { resolveNumber, sendWeb } from './waweb.js';
import { emit } from './bus.js';
import { httpError, createLead, firstStage, openLeadOf, firstPipelineOf, brandKey } from './crm.js';
import { sendTemplate, renderTemplate, templateSupported, templateHeaderMedia } from './meta.js';
import { perfil, semPrefixo } from './perfil.js';

// ---------- variáveis da mensagem: {{nome}} e {{primeiro_nome}}
const EMPRESA = /\b(ltda|eireli|epp|s\/?a|me|mei|cia|agropecu[aá]ria|agr[ií]cola|fazenda|usina|com[eé]rcio|servi[cç]os|transportes|grupo|holding)\b/i;
export function firstName(name) {
  const n = semPrefixo(name);
  if (!n || EMPRESA.test(n) || /\d/.test(n.split(/\s+/)[0])) return '';
  const w = n.split(/\s+/)[0];
  return w.length < 2 ? '' : w[0].toUpperCase() + w.slice(1).toLowerCase();
}
export function fillVars(text, contact) {
  const first = firstName(contact.name);
  return String(text || '')
    .replace(/\{\{\s*primeiro_nome\s*\}\}/gi, first)
    .replace(/\{\{\s*nome\s*\}\}/gi, semPrefixo(contact.name))
    .replace(/[ \t]+([,!.?])/g, '$1') // "Olá , tudo bem" -> "Olá, tudo bem" quando não há nome
    .replace(/[ \t]{2,}/g, ' ');
}

// ---------- WhatsApp: modelo aprovado para um contato. Abre (ou reaproveita) a conversa.
// withLead=false (campanhas): o lead só nasce quando a pessoa responde.
// headerFileId/headerMediaId: a imagem do cabeçalho (arquivo do CRM para mostrar no inbox; id da mídia na Meta para enviar).
export async function sendTemplateTo({ tpl, contact, params = [], userId = null, leadId = null, withLead = true, phone, headerFileId = null, headerMediaId = null }) {
  if (tpl.status !== 'APPROVED') throw httpError(400, 'Este modelo ainda não foi aprovado pela Meta');
  const components = JSON.parse(tpl.components);
  if (!templateSupported(components)) throw httpError(400, 'Modelos com variável no título ou em botão ainda não são suportados');
  if (templateHeaderMedia(components) && !headerMediaId) throw httpError(400, 'Este modelo tem imagem no topo: envie pela Campanha, onde a imagem é escolhida');
  phone = phone || one("select value_norm from contact_points where contact_id = ? and kind = 'phone' order by id limit 1", contact.id)?.value_norm;
  if (!phone || phone.length < 12) throw httpError(400, 'O contato precisa de um celular com DDD');
  const channel = one("select * from channels where id = ? and status != 'disabled'", tpl.channel_id);
  if (!channel) throw httpError(400, 'O canal deste modelo está desligado');
  const body = renderTemplate(components, params);
  const { convId, lid } = tx(() => {
    let conv = one("select * from conversations where channel_id = ? and contact_id = ? and status = 'open' order by id desc limit 1", channel.id, contact.id);
    let lid = leadId || conv?.lead_id || openLeadOf(contact.id, channel.brand_id)?.id || null;
    if (!lid && withLead) {
      const cfg = JSON.parse(channel.config);
      const pid = cfg.pipeline_id || firstPipelineOf(channel.brand_id);
      lid = createLead({ name: contact.name, stage_id: firstStage(pid).id, responsible_id: userId, contact_id: contact.id, source: 'whatsapp' }, userId);
    }
    if (!conv) {
      conv = { id: Number(run('insert into conversations(channel_id, contact_id, lead_id, external_id, last_message_at, created_at) values(?, ?, ?, ?, ?, ?)',
        channel.id, contact.id, lid, phone, now(), now()).lastInsertRowid) };
    } else if (!conv.lead_id && lid) run('update conversations set lead_id = ? where id = ?', lid, conv.id);
    return { convId: conv.id, lid };
  });
  const mid = Number(run("insert into messages(conversation_id, direction, user_id, kind, body, file_id, status, created_at) values(?, 'out', ?, 'template', ?, ?, 'pending', ?)",
    convId, userId, body, headerFileId, now()).lastInsertRowid);
  run('update conversations set last_message_at = ? where id = ?', now(), convId);
  let error = null;
  try {
    const r = await sendTemplate(channel, phone, tpl, params, headerMediaId);
    run("update messages set external_id = ?, status = case when status = 'pending' then 'sent' else status end where id = ?", r.id || null, mid);
    // A Meta devolve o número no formato dela; as respostas do cliente chegam com esse mesmo id.
    if (r.wa_id && r.wa_id !== phone) {
      run("update conversations set external_id = ? where id = ? and not exists (select 1 from conversations where channel_id = ? and external_id = ? and status = 'open')",
        r.wa_id, convId, channel.id, r.wa_id);
    }
  } catch (e) {
    error = e;
    run("update messages set status = 'failed', error = ? where id = ?", e.message, mid);
  }
  emit('message', { conversation_id: convId, lead_id: lid });
  return { messageId: mid, conversationId: convId, leadId: lid, error };
}

// Campanha pelo WhatsApp Web: texto livre (com {{primeiro_nome}}) e, se tiver, a arte com o texto de legenda.
// Número sem WhatsApp não abre conversa: volta { noWhatsApp: true }.
export async function sendWebTo({ channel, contact, phone, text, fileId = null }) {
  const chatId = await resolveNumber(channel, phone);
  if (!chatId) return { noWhatsApp: true };
  const f = fileId && one('select * from files where id = ?', fileId);
  if (fileId && !f) throw Object.assign(new Error('A imagem da campanha foi apagada: escolha outra'), { fatal: true });
  const convId = tx(() => {
    const conv = one("select id from conversations where channel_id = ? and contact_id = ? and status = 'open' order by id desc limit 1", channel.id, contact.id);
    return conv?.id ?? Number(run('insert into conversations(channel_id, contact_id, external_id, last_message_at, created_at) values(?, ?, ?, ?, ?)',
      channel.id, contact.id, phone, now(), now()).lastInsertRowid);
  });
  const mid = Number(run("insert into messages(conversation_id, direction, kind, body, file_id, status, created_at) values(?, 'out', ?, ?, ?, 'pending', ?)",
    convId, f ? 'image' : 'text', text, f?.id ?? null, now()).lastInsertRowid);
  run('update conversations set last_message_at = ? where id = ?', now(), convId);
  let error = null;
  try {
    const r = await sendWeb(channel, chatId, { text, file: f && { buf: fs.readFileSync(path.join(uploadDir(), f.path)), name: f.name, mime: f.mime } });
    run("update messages set external_id = ?, status = case when status = 'pending' then 'sent' else status end where id = ?", r.id, mid);
    run("update conversations set external_id = ? where id = ? and not exists (select 1 from conversations where channel_id = ? and external_id = ? and status = 'open')",
      r.wa_id, convId, channel.id, r.wa_id);
  } catch (e) {
    run("update messages set status = 'failed', error = ? where id = ?", e.message, mid);
    if (e.fatal) throw e;
    error = e;
  }
  emit('message', { conversation_id: convId });
  return { messageId: mid, conversationId: convId, error };
}

// ---------- e-mail pela Resend (https://resend.com). Sem dependência: é uma chamada HTTP.
// Token do link "sair": contato + empresa ("12b2"); os antigos ("12") valem para a empresa 1.
export function unsubToken(contactId, brandId = 1) {
  let secret = getSetting('unsub_secret');
  if (!secret) { secret = crypto.randomBytes(16).toString('hex'); setSetting('unsub_secret', secret); }
  const who = Number(brandId) > 1 ? `${contactId}b${Number(brandId)}` : String(contactId);
  const sig = crypto.createHmac('sha256', secret).update(who).digest('hex').slice(0, 20);
  return `${who}.${sig}`;
}
export function contactFromUnsubToken(token) {
  const m = String(token || '').match(/^(\d+)(?:b(\d+))?\./);
  if (!m) return null;
  const id = Number(m[1]), brandId = Number(m[2] || 1);
  return unsubToken(id, brandId) === token ? { id, brandId } : null;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Botão "cancelar inscrição" do Gmail/Outlook: link público (um clique) ou, com o CRM só no seu PC, e-mail com SAIR.
function listUnsub(url, replyTo) {
  const addr = String(replyTo || '').match(/[^\s<>]+@[^\s<>]+/)?.[0];
  const parts = [url && `<${url}>`, addr && `<mailto:${addr}?subject=SAIR>`].filter(Boolean);
  if (!parts.length) return {};
  return { 'List-Unsubscribe': parts.join(', '), ...(url ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}) };
}

// Arquivo do CRM (id) ou já carregado ({ buf, name, mime }) -> anexo embutido (cid) da Resend.
function inlineFile(f, cid) {
  const row = typeof f === 'number' ? one('select * from files where id = ?', f) : null;
  if (typeof f === 'number' && !row) throw Object.assign(new Error('Uma imagem do e-mail foi apagada: escolha outra'), { fatal: true });
  const buf = row ? fs.readFileSync(path.join(uploadDir(), row.path)) : f.buf;
  return { content: Buffer.from(buf).toString('base64'), filename: row?.name || f.name, content_type: row?.mime || f.mime, content_id: cid };
}
// WhatsApp com DDD vira 55 + DDD + número (o link do wa.me precisa do país)
const waDigits = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 || d.length === 11 ? `55${d}` : d; };
export const waLink = (cfg) => waDigits(cfg.whatsapp).length >= 12
  ? `https://wa.me/${waDigits(cfg.whatsapp)}?text=${encodeURIComponent(cfg.whatsapp_text || perfil().textoWhatsappEmail)}` : '';
const siteUrl = (s) => (!s ? '' : /^https?:\/\//.test(s) ? s : `https://${s}`);

// Assinatura (Ajustes › E-mail): o mascote recortado (PNG) ao lado do "Abraço, Equipe", botão do WhatsApp, Instagram e site clicáveis.
// Tabela, porque é o que o Outlook respeita para pôr lado a lado.
function signatureHtml(cfg, brandName) {
  const wa = waLink(cfg), ig = String(cfg.instagram || '').replace(/^@/, ''), site = siteUrl(cfg.site);
  const font = 'font-family:Arial,sans-serif;color:#222';
  const links = [ig && `<a href="https://instagram.com/${esc(ig)}" style="color:#1E6B3F;text-decoration:none">Instagram @${esc(ig)}</a>`,
    site && `<a href="${esc(site)}" style="color:#1E6B3F;text-decoration:none">${esc(site.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const text = `<div style="${font};font-size:15px;line-height:1.45">`
    + `<div style="font-weight:bold">Abraço,</div><div>${esc(cfg.sig_name || `Equipe ${brandName}`)}</div>`
    + (wa ? `<div style="margin:12px 0 4px"><a href="${wa}" style="display:inline-block;background:#25D366;color:#ffffff;font-weight:bold;text-decoration:none;padding:10px 18px;border-radius:22px">Chamar no WhatsApp</a></div>` : '')
    + (links ? `<div style="font-size:13px;margin-top:8px">${links}</div>` : '')
    + `</div>`;
  const pic = cfg.sig_image_file_id
    ? `<td width="120" valign="bottom" style="padding:14px 16px 0 0;width:120px"><img src="cid:assinatura" alt="${esc(perfil().assinaturaAlt)}" width="120" style="display:block;width:120px;height:auto;border:0"></td>` : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;border-top:3px solid #B5F23D;max-width:460px">`
    + `<tr>${pic}<td valign="middle" style="padding:14px 0 0">${text}</td></tr></table>`;
}

// E-mail pela Resend. imageFileId: a arte no topo (clicável para o WhatsApp); images: imagens depois do texto (ex.: tabela de preços);
// inReplyTo: responde no mesmo fio; unsubscribe: rodapé "sair da lista" (campanhas).
export async function sendEmail({ to, subject, text, contactId, imageFileId = null, brandId = 1, images = [], inReplyTo = null, unsubscribe = true }) {
  const cfg = getSetting(brandKey('email', brandId), {});
  if (!cfg.api_key || !cfg.from) throw httpError(400, 'Configure o e-mail (chave da Resend e remetente) em Ajustes > E-mail');
  const brandName = one('select name from brands where id = ?', brandId)?.name || '';
  // Endereço temporário (túnel trycloudflare) muda a cada vez que abre: o link morreria. Aí o cliente sai respondendo SAIR.
  const base = (getSetting('general', {}).public_url || '').replace(/\/$/, '').replace(/^.*trycloudflare\.com$/, '');
  const unsub = unsubscribe && base && contactId ? `${base}/sair/${accountId() === 1 ? '' : `c${accountId()}-`}${unsubToken(contactId, brandId)}` : '';
  const attachments = [];
  if (imageFileId) attachments.push(inlineFile(imageFileId, 'arte'));
  images.forEach((f, i) => attachments.push(inlineFile(f, `img${i}`)));
  if (cfg.sig_image_file_id) attachments.push(inlineFile(Number(cfg.sig_image_file_id), 'assinatura'));
  const top = waLink(cfg) || siteUrl(cfg.site);
  const art = imageFileId ? `<img src="cid:arte" alt="${esc(subject)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border-radius:8px;border:0">` : '';
  const html = (art ? `<div style="margin:0 0 20px">${top ? `<a href="${top}">${art}</a>` : art}</div>` : '')
    + `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">${esc(text).replace(/\n/g, '<br>')}</div>`
    + images.map((_, i) => `<img src="cid:img${i}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;margin:16px 0 0;border-radius:8px">`).join('')
    + signatureHtml(cfg, brandName)
    + (unsubscribe ? `<p style="font-family:Arial,sans-serif;font-size:12px;color:#888;margin-top:24px">Não quer mais receber? ${unsub ? `<a href="${unsub}">Clique aqui para sair da lista</a>` : 'Responda este e-mail com SAIR'}.</p>` : '');
  const plain = [text, waLink(cfg) && `WhatsApp: ${waLink(cfg)}`, cfg.instagram && `Instagram: @${String(cfg.instagram).replace(/^@/, '')}`, cfg.site && siteUrl(cfg.site),
    unsubscribe && `--\nNão quer mais receber? ${unsub || 'Responda com SAIR'}`].filter(Boolean).join('\n\n');
  const headers = { ...(unsubscribe ? listUnsub(unsub, cfg.reply_to || cfg.from) : {}), ...(inReplyTo ? { 'In-Reply-To': inReplyTo, References: inReplyTo } : {}) };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.from, to: [to], subject, html, text: plain, ...(cfg.reply_to ? { reply_to: cfg.reply_to } : {}), headers,
      ...(attachments.length ? { attachments } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`E-mail recusado: ${data.message || res.status}`), { status: 502 });
  return { id: data.id };
}
