// Campanhas: escolhe o público por etiqueta e envia um por um, no ritmo e no horário definidos.
// Proteções: só modelo aprovado (WhatsApp), pula quem pediu para sair, quem recebeu campanha há pouco
// e quem não tem telefone/e-mail; pausa sozinha depois de 5 falhas seguidas.
import { one, all, run, now, tx } from './db.js';
import { emit } from './bus.js';
import { httpError, isOptedOut, setOptOut, brandKey } from './crm.js';
import { sendTemplateTo, sendEmail, fillVars, sendWebTo } from './outbound.js';
import { isWeb, webStatus } from './waweb.js';
import { recordCampaignEmail } from './mailbox.js';
import { templateHeaderMedia, uploadMedia } from './meta.js';
import { uploadDir, accountId } from './db.js';
import fs from 'node:fs';
import path from 'node:path';

// A imagem do cabeçalho sobe uma vez para a Meta e o id é reaproveitado (a Meta guarda por 30 dias; renovamos com 25).
async function headerMedia(camp, channel) {
  const cached = camp.header_media && JSON.parse(camp.header_media);
  if (cached?.id && cached.channel_id === channel.id && cached.file_id === camp.header_file_id && now() - cached.at < 25 * 864e5) return cached.id;
  const f = one('select * from files where id = ?', camp.header_file_id);
  if (!f) throw Object.assign(new Error('A imagem da campanha foi apagada: escolha outra'), { fatal: true });
  const id = await uploadMedia(channel, { buf: fs.readFileSync(path.join(uploadDir(), f.path)), name: f.name, mime: f.mime });
  run('update campaigns set header_media = ? where id = ?', JSON.stringify({ id, channel_id: channel.id, file_id: f.id, at: now() }), camp.id);
  camp.header_media = JSON.stringify({ id, channel_id: channel.id, file_id: f.id, at: now() });
  return id;
}

export const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|remover|n[aã]o quero mais)\b/i;
export const REPLY_WINDOW_MS = 72 * 3600e3; // resposta em até 72 h conta para a campanha
const TZ = 'America/Sao_Paulo';

const PHONE_SQL = `(select p.value_norm from contact_points p where p.contact_id = c.id and p.kind = 'phone' and length(p.value_norm) >= 12
  order by (length(p.value_norm) = 13 and substr(p.value_norm, 5, 1) = '9') desc, p.id limit 1)`;
const EMAIL_SQL = `(select p.value_norm from contact_points p where p.contact_id = c.id and p.kind = 'email' order by p.id limit 1)`;

function audienceWhere(camp) {
  const tags = JSON.parse(camp.tags || '[]');
  const where = ['c.deleted_at is null', 'not exists (select 1 from contact_optouts o where o.contact_id = c.id and o.brand_id = ?)', `${camp.channel === 'email' ? EMAIL_SQL : PHONE_SQL} is not null`];
  const p = [camp.brand_id ?? 1];
  if (tags.length) {
    where.push(`exists (select 1 from entity_tags et join tags t on t.id = et.tag_id where et.entity = 'contact' and et.entity_id = c.id and t.name in (${tags.map(() => '?').join(',')}))`);
    p.push(...tags);
  }
  if (camp.skip_recent_days > 0) {
    where.push('not exists (select 1 from campaign_recipients r where r.contact_id = c.id and r.sent_at > ?)');
    p.push(now() - camp.skip_recent_days * 864e5);
  }
  return { sql: where.join(' and '), p };
}

export function audienceCount(camp) {
  const { sql, p } = audienceWhere(camp);
  return one(`select count(*) n from contacts c where ${sql}`, ...p).n;
}

export function campaignStats(id) {
  const r = Object.fromEntries(all('select status, count(*) n from campaign_recipients where campaign_id = ? group by status', id).map((x) => [x.status, x.n]));
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  const sent = (r.sent || 0) + (r.replied || 0) + (r.optout || 0);
  return { total, queued: r.queued || 0, sent, failed: r.failed || 0, skipped: r.skipped || 0, replied: r.replied || 0, optout: r.optout || 0 };
}

// Canal de WhatsApp Web escolhido na campanha (null = API oficial, pelo modelo).
export const webChannelOf = (c) => { const ch = c.wa_channel_id && one('select * from channels where id = ?', c.wa_channel_id); return ch && isWeb(ch) ? ch : null; };

export function validate(c) {
  if (!String(c.name || '').trim()) throw httpError(400, 'Dê um nome à campanha');
  if (c.channel === 'whatsapp' && webChannelOf(c)) {
    if (!String(c.body || '').trim() && !c.header_file_id) throw httpError(400, 'Escreva a mensagem (ou escolha a imagem) da campanha');
  } else if (c.channel === 'whatsapp') {
    const tpl = c.template_id && one('select * from wa_templates where id = ?', c.template_id);
    if (!tpl) throw httpError(400, 'Escolha um modelo do WhatsApp (só modelos aprovados pela Meta podem ir para quem não te escreveu)');
    if (tpl.status !== 'APPROVED') throw httpError(400, 'Este modelo ainda não foi aprovado pela Meta');
    if (templateHeaderMedia(JSON.parse(tpl.components)) && !c.header_file_id) throw httpError(400, 'Este modelo tem imagem no topo: escolha a imagem (a arte) da campanha');
  } else if (!String(c.subject || '').trim() || !String(c.body || '').trim()) throw httpError(400, 'Preencha assunto e texto do e-mail');
  if (!(c.interval_seconds >= 1) || !(c.daily_cap >= 1)) throw httpError(400, 'Intervalo e limite por dia precisam ser maiores que zero');
  if (c.interval_max_seconds != null && c.interval_max_seconds < c.interval_seconds) throw httpError(400, 'O intervalo máximo precisa ser maior ou igual ao mínimo');
  if (c.batch_max > 0 && !(c.batch_min >= 1 && c.batch_min <= c.batch_max)) throw httpError(400, 'Lote: o mínimo precisa ser pelo menos 1 e no máximo igual ao máximo');
  if (c.batch_max > 0 && !(c.batch_pause_minutes >= 1)) throw httpError(400, 'Defina a pausa entre os lotes (minutos)');
  if (!(c.window_start >= 0 && c.window_end <= 24 && c.window_start < c.window_end)) throw httpError(400, 'Horário inválido');
}

// Congela o público na hora de iniciar: quem entrar depois na etiqueta não recebe esta campanha.
export function startCampaign(id) {
  const camp = one('select * from campaigns where id = ?', id);
  if (!camp) throw httpError(404, 'Campanha não encontrada');
  if (camp.status === 'running') return camp;
  if (camp.status === 'done') throw httpError(400, 'Campanha já terminou. Duplique para enviar de novo.');
  validate(camp);
  tx(() => {
    if (camp.status === 'draft') {
      const { sql, p } = audienceWhere(camp);
      run(`insert or ignore into campaign_recipients(campaign_id, contact_id, address)
        select ?, c.id, ${camp.channel === 'email' ? EMAIL_SQL : PHONE_SQL} from contacts c where ${sql}`, id, ...p);
      if (!one('select 1 from campaign_recipients where campaign_id = ? limit 1', id)) throw httpError(400, 'Nenhum contato no público escolhido');
    }
    run("update campaigns set status = 'running', pause_reason = null, next_at = 0, started_at = coalesce(started_at, ?), updated_at = ? where id = ?", now(), now(), id);
  });
  emit('campaign', { id });
  return one('select * from campaigns where id = ?', id);
}

export function pauseCampaign(id, reason = null) {
  run("update campaigns set status = 'paused', pause_reason = ?, updated_at = ? where id = ? and status = 'running'", reason, now(), id);
  emit('campaign', { id });
}

const localHour = (ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(ms));
function startOfLocalDay(ms) {
  const d = new Date(ms);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return ms - ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 - d.getMilliseconds();
}

// Envia UMA mensagem da campanha, se for a hora. Devolve o que fez (para testes e registro).
const BOOT = Date.now();
export async function stepCampaign(camp, t = now()) {
  if (camp.status !== 'running' || camp.next_at > t) return 'wait';
  const h = localHour(t);
  if (h < camp.window_start || h >= camp.window_end) return 'outside_window';
  const today = one("select count(*) n from campaign_recipients where campaign_id = ? and sent_at >= ? and status in ('sent','replied','optout')", camp.id, startOfLocalDay(t)).n;
  if (today >= camp.daily_cap) return 'daily_cap';
  const r = one("select * from campaign_recipients where campaign_id = ? and status = 'queued' order by id limit 1", camp.id);
  if (!r) {
    run("update campaigns set status = 'done', finished_at = ?, updated_at = ? where id = ?", t, t, camp.id);
    emit('campaign', { id: camp.id });
    return 'done';
  }
  const web0 = camp.channel === 'whatsapp' && webChannelOf(camp);
  if (web0 && webStatus(web0.id).booting && Date.now() - BOOT < 5 * 60e3) {
    run('update campaigns set next_at = ? where id = ?', t + 15e3, camp.id); // CRM acabou de abrir: o WhatsApp ainda está carregando
    return 'wait';
  }
  const contact = one('select * from contacts where id = ?', r.contact_id);
  const out = contact && isOptedOut(contact.id, camp.brand_id);
  if (!contact || contact.deleted_at || out) {
    run("update campaign_recipients set status = 'skipped', error = ? where id = ?", out ? 'pediu para sair' : 'contato apagado', r.id);
    return 'skipped';
  }
  // Intervalo sorteado entre o mínimo e o máximo; em lotes, a última mensagem do lote marca a pausa longa.
  const rand = (a, b) => a + Math.random() * (b - a);
  let wait = camp.interval_max_seconds ? rand(camp.interval_seconds, camp.interval_max_seconds) * 1000 : camp.interval_seconds * 1000 * rand(0.8, 1.2);
  if (camp.batch_max > 0) {
    const target = camp.batch_target || Math.round(rand(camp.batch_min, camp.batch_max));
    const done = (camp.batch_sent || 0) + 1;
    if (done >= target) {
      wait = camp.batch_pause_minutes * 60e3;
      run('update campaigns set batch_sent = 0, batch_target = ? where id = ?', Math.round(rand(camp.batch_min, camp.batch_max)), camp.id); // próximo lote com outro tamanho
    } else run('update campaigns set batch_sent = ?, batch_target = ? where id = ?', done, target, camp.id);
  }
  // Pausa curta: a cada N mensagens (ex.: 50), 20 a 23 min sorteados. Se coincidir com a pausa longa do lote, vale a longa.
  if (camp.mini_every > 0) {
    const longPause = camp.batch_max > 0 && wait >= camp.batch_pause_minutes * 60e3 && camp.batch_pause_minutes > 0;
    const m = longPause ? 0 : (camp.mini_sent || 0) + 1;
    if (!longPause && m >= camp.mini_every) {
      wait = Math.max(wait, rand(camp.mini_pause_min || 20, camp.mini_pause_max || camp.mini_pause_min || 23) * 60e3);
      run('update campaigns set mini_sent = 0 where id = ?', camp.id);
    } else run('update campaigns set mini_sent = ? where id = ?', m, camp.id);
  }
  run('update campaigns set next_at = ? where id = ?', t + Math.round(wait), camp.id);
  let error = null, messageId = null;
  try {
    const web = camp.channel === 'whatsapp' && webChannelOf(camp);
    if (web) {
      if (web.status === 'disabled') throw Object.assign(new Error('O canal do WhatsApp Web está desligado'), { fatal: true });
      if (webStatus(web.id).state !== 'ready') throw Object.assign(new Error('WhatsApp Web desconectado: leia o QR code em Ajustes › Canais e retome'), { fatal: true });
      const res = await sendWebTo({ channel: web, contact, phone: r.address, text: fillVars(camp.body || '', contact), fileId: camp.header_file_id });
      if (res.noWhatsApp) {
        run("update campaign_recipients set status = 'skipped', error = 'número sem WhatsApp', sent_at = ? where id = ?", t, r.id);
        // nada saiu: não conta no lote e passa logo para o próximo
        run('update campaigns set next_at = ?, batch_sent = max(batch_sent - 1, 0), mini_sent = max(mini_sent - 1, 0) where id = ?', t + 3000, camp.id);
        emit('campaign', { id: camp.id });
        return 'skipped';
      }
      messageId = res.messageId;
      error = res.error;
    } else if (camp.channel === 'whatsapp') {
      const tpl = one('select * from wa_templates where id = ?', camp.template_id);
      if (!tpl) throw Object.assign(new Error('O modelo foi apagado'), { fatal: true });
      if (tpl.status !== 'APPROVED') throw Object.assign(new Error(`O modelo está "${tpl.status}" na Meta`), { fatal: true });
      const channel = one("select * from channels where id = ? and status != 'disabled'", tpl.channel_id);
      if (!channel) throw Object.assign(new Error('O canal do WhatsApp está desligado'), { fatal: true });
      const params = JSON.parse(camp.params || '[]').map((v) => fillVars(v, contact));
      let headerMediaId = null;
      if (templateHeaderMedia(JSON.parse(tpl.components))) {
        try { headerMediaId = await headerMedia(camp, channel); } catch (e) { throw Object.assign(e, { fatal: true }); }
      }
      const res = await sendTemplateTo({ tpl, contact, params, withLead: false, phone: r.address, headerFileId: camp.header_file_id, headerMediaId });
      messageId = res.messageId;
      error = res.error;
    } else {
      const cfg = one('select value from settings where key = ?', brandKey('email', camp.brand_id));
      if (!cfg || !JSON.parse(cfg.value).api_key) throw Object.assign(new Error('E-mail não configurado em Ajustes > E-mail'), { fatal: true });
      const subject = fillVars(camp.subject, contact), text = fillVars(camp.body, contact);
      const sent = await sendEmail({ to: r.address, subject, text, contactId: contact.id, imageFileId: camp.header_file_id, brandId: camp.brand_id });
      recordCampaignEmail({ brandId: camp.brand_id, contact, address: r.address, subject, text, fileId: camp.header_file_id, providerId: sent.id });
    }
  } catch (e) { error = e; }
  if (error?.fatal) { pauseCampaign(camp.id, `Pausada: ${error.message}`); return 'paused'; } // o contato continua na fila
  if (error) run("update campaign_recipients set status = 'failed', error = ?, message_id = ?, sent_at = ? where id = ?", String(error.message).slice(0, 300), messageId, t, r.id);
  else run("update campaign_recipients set status = 'sent', message_id = ?, sent_at = ? where id = ?", messageId, t, r.id);
  if (error) {
    const last = all("select status from campaign_recipients where campaign_id = ? and status in ('sent','failed','replied','optout') order by sent_at desc, id desc limit 5", camp.id);
    if ((last.length === 5 && last.every((x) => x.status === 'failed'))) pauseCampaign(camp.id, `Pausada: ${error.message}`);
  }
  run('update campaigns set updated_at = ? where id = ?', t, camp.id);
  emit('campaign', { id: camp.id });
  return error ? 'failed' : 'sent';
}

const busy = new Set(); // empresas com campanha andando agora
export async function tickCampaigns() {
  const acc = accountId();
  if (busy.has(acc)) return;
  busy.add(acc);
  try {
    for (const camp of all("select * from campaigns where status = 'running' order by id")) {
      try { await stepCampaign(camp); } catch (e) { console.error('campanha', camp.id, e); }
    }
  } finally { busy.delete(acc); }
}

// Mensagem que chegou de um contato: conta como resposta da campanha ou como pedido de saída.
// Só mexe nas campanhas da empresa do canal por onde a mensagem chegou.
export function onInbound(contactId, text, t = now(), brandId = 1) {
  const mine = 'campaign_id in (select id from campaigns where brand_id = ?)';
  if (OPT_OUT.test(text || '')) {
    setOptOut(contactId, brandId, true, t);
    run(`update campaign_recipients set status = 'optout', replied_at = ? where contact_id = ? and status in ('sent','replied') and sent_at > ? and ${mine}`, t, contactId, t - REPLY_WINDOW_MS, brandId);
    run(`update campaign_recipients set status = 'skipped', error = 'pediu para sair' where contact_id = ? and status = 'queued' and ${mine}`, contactId, brandId);
    emit('campaign', {});
    emit('contact', { id: contactId });
    return 'optout';
  }
  const r = run(`update campaign_recipients set status = 'replied', replied_at = ? where contact_id = ? and status = 'sent' and sent_at > ? and ${mine}`, t, contactId, t - REPLY_WINDOW_MS, brandId);
  if (r.changes) emit('campaign', {});
  return r.changes ? 'replied' : null;
}
