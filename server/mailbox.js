// Caixa de e-mail da empresa (ex.: contato@agro-vox.com, no Gmail), lida pelo CRM a cada minuto (IMAP).
// Só entra no CRM e-mail de quem já é contato (os clientes das campanhas); o resto da caixa fica de fora.
// A resposta vira conversa no CRM: marca "respondeu" na campanha, SAIR tira da lista e o fluxo da empresa roda.
import { one, all, run, now } from './db.js';
import { emit } from './bus.js';
import { handleMessage } from './inbound.js';
import { findContactByPoint, normEmail } from './crm.js';
import { sendEmail } from './outbound.js';

let lib = null;
export function setMailLib(fake) { lib = fake; } // testes usam uma caixa falsa
async function loadLib() {
  if (lib) return lib;
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  lib = { ImapFlow, simpleParser };
  return lib;
}

// Tira a parte citada ("Em sex., ... escreveu:", linhas com ">", "-----Mensagem original-----", "De: ...").
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], two = `${l} ${lines[i + 1] || ''}`;
    if (/^\s*>/.test(l)) break;
    if (/^\s*(Em|On|El)\s.+(escreveu|wrote|escribió)\s*:?\s*$/i.test(l) || /^\s*(Em|On|El)\s.+(escreveu|wrote|escribió)\s*:?\s*$/i.test(two)) break;
    if (/^\s*-{2,}\s*(Mensagem original|Original Message|Mensaje original)/i.test(l)) break;
    if (/^\s*_{5,}\s*$/.test(l)) break;
    if (out.some((x) => x.trim()) && /^\s*(De|From):\s.+@/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const cfgOf = (id) => JSON.parse(one('select config from channels where id = ?', id).config);
function saveCfg(id, patch) {
  run('update channels set config = ? where id = ?', JSON.stringify({ ...cfgOf(id), ...patch }), id);
}

// Uma mensagem da caixa -> conversa no CRM (ou nada, se não for de um contato).
export function importMail(channel, mail) {
  const from = mail.from?.value?.[0];
  const addr = normEmail(from?.address);
  if (!addr || addr === normEmail(channel.external_id) || /^(mailer-daemon|postmaster|no-?reply)@/i.test(addr)) return null;
  const contact = findContactByPoint('email', addr);
  if (!contact) return null;
  const subject = String(mail.subject || '').trim();
  let text = stripQuoted(mail.text || '');
  if (!text && /\bsair\b/i.test(subject)) text = 'SAIR'; // "cancelar inscrição" do Gmail/Outlook manda o assunto SAIR
  const img = (mail.attachments || []).find((a) => /^image\//.test(a.contentType) && a.size < 15e6);
  const res = handleMessage({
    type: 'message', kind: 'email', channelExternalId: channel.external_id, userId: addr, userName: from.name || contact.name,
    ts: mail.date ? new Date(mail.date).getTime() : now(), direction: 'in',
    msg: { kind: img && !text ? 'image' : 'text', body: text || (img ? '' : '(e-mail sem texto)'), external_id: mail.messageId || null,
      media: img ? { buf: img.content, mime: img.contentType, name: img.filename || 'imagem' } : null },
  });
  if (res) {
    run(`insert into email_threads(conversation_id, subject, last_message_id) values(?, ?, ?)
      on conflict(conversation_id) do update set subject = excluded.subject, last_message_id = excluded.last_message_id`,
      res.conversationId, subject.replace(/^((re|res|enc|fwd?)\s*:\s*)+/i, ''), mail.messageId || null);
  }
  return res;
}

// Lê o que chegou desde a última vez. Na primeira vez só marca o ponto de partida (não puxa a caixa antiga).
export async function pollMailbox(channel) {
  const cfg = JSON.parse(channel.config);
  if (!cfg.imap_pass) throw new Error('Falta a senha de app da caixa de e-mail');
  const { ImapFlow, simpleParser } = await loadLib();
  const client = new ImapFlow({ host: cfg.imap_host || 'imap.gmail.com', port: Number(cfg.imap_port || 993), secure: true,
    auth: { user: cfg.imap_user || channel.external_id, pass: cfg.imap_pass }, logger: false });
  // Queda de conexão com o Gmail (ex.: "Socket timeout" de madrugada) chega como evento 'error': sem este ouvinte, derrubava o CRM inteiro.
  client.on('error', (e) => console.error('e-mail: conexão com a caixa caiu:', e.message));
  await client.connect();
  let n = 0;
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mb = client.mailbox;
      const validity = String(mb.uidValidity);
      if (!cfg.last_uid || cfg.uid_validity !== validity) {
        saveCfg(channel.id, { last_uid: Number(mb.uidNext) - 1, uid_validity: validity });
        return 0;
      }
      if (Number(mb.uidNext) - 1 <= cfg.last_uid) return 0;
      let max = cfg.last_uid;
      for await (const m of client.fetch(`${cfg.last_uid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (m.uid <= cfg.last_uid) continue;
        max = Math.max(max, m.uid);
        try { if (importMail(channel, await simpleParser(m.source))) n++; } catch (e) { console.error('e-mail: mensagem', m.uid, e.message); }
      }
      saveCfg(channel.id, { last_uid: max });
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  return n;
}

let busy = false;
export async function tickMailboxes() {
  if (busy) return;
  busy = true;
  try {
    for (const ch of all("select * from channels where kind = 'email' and status != 'disabled'")) {
      try {
        await pollMailbox(ch);
        saveCfg(ch.id, { checked_at: now(), mail_error: null });
        run("update channels set status = 'active' where id = ? and status = 'error'", ch.id);
      } catch (e) {
        saveCfg(ch.id, { checked_at: now(), mail_error: e.message });
        run("update channels set status = 'error' where id = ?", ch.id);
      }
      emit('config');
    }
  } finally { busy = false; }
}

// Resposta pelo CRM (atendente ou robô) numa conversa de e-mail: "Re: assunto", no mesmo fio.
export async function sendMail(channel, to, { text = '', file, buttons } = {}) {
  const conv = one("select id from conversations where channel_id = ? and external_id = ? order by status = 'open' desc, id desc limit 1", channel.id, to);
  const th = conv && one('select * from email_threads where conversation_id = ?', conv.id);
  const opts = (buttons || []).filter(Boolean);
  if (opts.length) text = `${text}\n\n${opts.map((b, i) => `${i + 1}. ${b}`).join('\n')}`;
  const brand = one('select name from brands where id = ?', channel.brand_id)?.name || '';
  const subject = th?.subject ? `Re: ${th.subject}` : brand;
  return sendEmail({ to, subject, text, brandId: channel.brand_id, images: file ? [file] : [], inReplyTo: th?.last_message_id, unsubscribe: false });
}

// E-mail de campanha também fica registrado na conversa do contato (se a empresa tem caixa ligada ao CRM),
// para a resposta cair no mesmo lugar e dar para ver o que foi enviado.
export function recordCampaignEmail({ brandId, contact, address, subject, text, fileId, providerId }) {
  const ch = one("select * from channels where kind = 'email' and brand_id = ? and status != 'disabled' order by id limit 1", brandId);
  if (!ch) return null;
  let conv = one("select id from conversations where channel_id = ? and contact_id = ? and status = 'open' order by id desc limit 1", ch.id, contact.id);
  if (!conv) {
    try {
      conv = { id: Number(run('insert into conversations(channel_id, contact_id, external_id, last_message_at, created_at) values(?, ?, ?, ?, ?)',
        ch.id, contact.id, address, now(), now()).lastInsertRowid) };
    } catch { conv = one("select id from conversations where channel_id = ? and external_id = ? and status = 'open'", ch.id, address); }
  }
  run("insert into messages(conversation_id, direction, kind, body, file_id, external_id, status, created_at) values(?, 'out', ?, ?, ?, ?, 'sent', ?)",
    conv.id, fileId ? 'image' : 'text', `${subject}\n\n${text}`, fileId || null, providerId || null, now());
  run('update conversations set last_message_at = ? where id = ?', now(), conv.id);
  run('insert into email_threads(conversation_id, subject) values(?, ?) on conflict(conversation_id) do update set subject = excluded.subject', conv.id, subject);
  emit('message', { conversation_id: conv.id });
  return conv.id;
}
