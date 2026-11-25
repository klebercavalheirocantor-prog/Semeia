import { one, run, now, tx } from './db.js';
import { emit } from './bus.js';
import { createContact, createLead, findContactByPoint, firstStage, openLeadOf, firstPipelineOf, logEvent } from './crm.js';
import { downloadMedia, fetchProfileName } from './meta.js';
import { onInbound, REPLY_WINDOW_MS } from './campaigns.js';
import { flowOnInbound } from './flows.js';
import { perfil } from './perfil.js';
import { transcribeMessage, groqKey } from './transcribe.js';

const RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

// Mensagem recebida (ou eco enviado pelo app da Meta). Idempotente pelo external_id.
// Devolve { messageId, conversationId, leadId, created } ou null se repetida/canal desconhecido.
// Responsável padrão dos leads que entram sozinhos (campanha e anúncio): o primeiro administrador ativo.
const owner = () => one('select id from users where is_admin = 1 and is_active = 1 order by id limit 1')?.id || null;

export function handleMessage(item) {
  const channel = one('select * from channels where kind = ? and external_id = ? and status != ?', item.kind, item.channelExternalId, 'disabled');
  if (!channel) return null;
  const res = tx(() => {
    if (item.msg.external_id && one('select 1 from messages where external_id = ?', item.msg.external_id)) return null;
    const ts = item.ts || now();
    let conv = one("select * from conversations where channel_id = ? and external_id = ? and status = 'open'", channel.id, item.userId);
    // WhatsApp: a conversa pode ter sido aberta por nós com o número noutro formato (com/sem o 9).
    // E-mail: a conversa da campanha foi aberta com o endereço do contato.
    const pointKind = channel.kind === 'whatsapp' ? 'phone' : channel.kind === 'email' ? 'email' : null;
    if (!conv && pointKind) {
      const known = findContactByPoint(pointKind, item.userId);
      const c2 = known && one("select * from conversations where channel_id = ? and contact_id = ? and status = 'open' order by id desc limit 1", channel.id, known.id);
      if (c2) { run('update conversations set external_id = ? where id = ?', item.userId, c2.id); conv = { ...c2, external_id: item.userId }; }
    }
    let created = false, newConv = false;
    if (!conv) {
      newConv = true;
      const prev = one('select contact_id from conversations where channel_id = ? and external_id = ? order by id desc limit 1', channel.id, item.userId);
      let contactId = prev?.contact_id;
      if (!contactId && pointKind) contactId = findContactByPoint(pointKind, item.userId)?.id;
      if (!contactId) {
        const placeholder = item.userName || (channel.kind === 'instagram' ? 'Cliente Instagram' : channel.kind === 'whatsapp' ? 'Cliente WhatsApp' : 'Cliente Messenger');
        contactId = createContact({ name: placeholder, phones: channel.kind === 'whatsapp' && /^\d{10,13}$/.test(item.userId) ? [item.userId] : [], // 14+ dígitos = código interno (LID), não telefone
          emails: channel.kind === 'email' ? [item.userId] : [] });
        created = true;
      }
      let lead = openLeadOf(contactId, channel.brand_id);
      if (!lead) {
        const cfg = JSON.parse(channel.config);
        const pipelineId = cfg.pipeline_id || firstPipelineOf(channel.brand_id);
        const contact = one('select name from contacts where id = ?', contactId);
        // Veio do anúncio: é cliente, entra direto em "Primeiro contato" (sem precisar aceitar). Outras conversas novas passam pela triagem.
        const leadId = createLead({ name: contact.name, stage_id: firstStage(pipelineId, !item.ad).id, contact_id: contactId, source: item.ad ? 'anuncio' : channel.kind,
          responsible_id: item.ad ? owner() : null });
        lead = { id: leadId };
      }
      const cid = Number(run(`insert into conversations(channel_id, contact_id, lead_id, external_id, last_message_at, created_at) values(?, ?, ?, ?, ?, ?)`,
        channel.id, contactId, lead.id, item.userId, ts, now()).lastInsertRowid);
      conv = one('select * from conversations where id = ?', cid);
    } else if (!conv.lead_id && item.direction === 'in') {
      // Conversa aberta por campanha (sem lead): quem responde vira lead.
      let lead = openLeadOf(conv.contact_id, channel.brand_id);
      if (!lead) {
        const cfg = JSON.parse(channel.config);
        const pipelineId = cfg.pipeline_id || firstPipelineOf(channel.brand_id);
        const contact = one('select name from contacts where id = ?', conv.contact_id);
        // Respondeu campanha: é cliente, entra direto em "Primeiro contato", já com responsável.
        lead = { id: createLead({ name: contact.name, stage_id: firstStage(pipelineId).id, contact_id: conv.contact_id, source: item.ad ? 'anuncio' : `campanha-${channel.kind}`,
          responsible_id: owner() }) };
      }
      run('update conversations set lead_id = ? where id = ?', lead.id, conv.id);
      conv = { ...conv, lead_id: lead.id };
    }
    const mid = Number(run(`insert into messages(conversation_id, direction, kind, body, external_id, status, created_at) values(?, ?, ?, ?, ?, ?, ?)`,
      conv.id, item.direction, item.msg.kind, item.msg.body || '', item.msg.external_id || null, item.direction === 'in' ? 'delivered' : 'sent', ts).lastInsertRowid);
    if (item.direction === 'in') run('update conversations set last_message_at = ?, last_inbound_at = ?, unread = unread + 1 where id = ?', ts, ts, conv.id);
    else run('update conversations set last_message_at = ? where id = ?', ts, conv.id);
    if (conv.lead_id) run('update leads set updated_at = ? where id = ?', now(), conv.lead_id);
    return { messageId: mid, conversationId: conv.id, leadId: conv.lead_id, contactId: conv.contact_id, created, newConv };
  });
  if (!res) return null;
  emit('message', { conversation_id: res.conversationId, lead_id: res.leadId });
  if (item.direction === 'in' && item.ad) markAd(res, item.ad);
  if (item.direction === 'in') {
    const r = onInbound(res.contactId, item.msg.body, now(), channel.brand_id);
    const camp = r === 'replied' ? one(`select r.campaign_id from campaign_recipients r join campaigns c on c.id = r.campaign_id
      where r.contact_id = ? and r.status = 'replied' and c.brand_id = ? order by r.replied_at desc limit 1`, res.contactId, channel.brand_id)
      // A 1ª resposta foi automática ou só "ok" (o robô esperou): a próxima mensagem ainda conta como resposta à campanha,
      // desde que ninguém tenha respondido nem o robô tenha começado nesta conversa depois disso.
      : r === null && one(`select r.campaign_id from campaign_recipients r join campaigns c on c.id = r.campaign_id
      where r.contact_id = ? and r.status = 'replied' and c.brand_id = ? and r.replied_at > ?
        and not exists (select 1 from flow_runs f where f.conversation_id = ? and f.created_at >= r.replied_at)
        and not exists (select 1 from messages m where m.conversation_id = ? and m.direction = 'out' and m.created_at >= r.replied_at)
      order by r.replied_at desc limit 1`, res.contactId, channel.brand_id, now() - REPLY_WINDOW_MS, res.conversationId, res.conversationId);
    if (!item.noFlow) res.flow = flowOnInbound({ conversationId: res.conversationId, text: item.msg.body, campaignId: camp?.campaign_id || null, newConversation: res.newConv, optout: r === 'optout', fromAd: !!item.ad });
  }
  // Depois do commit: baixar mídia e buscar o nome do perfil, sem travar o webhook.
  if (item.msg.media) {
    downloadMedia(channel, item.msg.media)
      .then((fid) => {
        run('update messages set file_id = ? where id = ?', fid, res.messageId);
        emit('message', { conversation_id: res.conversationId });
        // áudio do cliente: transcreve sozinho (se a chave da Groq estiver salva)
        if (item.direction === 'in' && item.msg.kind === 'audio' && groqKey(channel.brand_id)) {
          transcribeMessage(res.messageId).catch((e) => console.error('transcrição falhou', e.message));
        }
      })
      .catch((e) => run('update messages set error = ? where id = ?', `mídia: ${e.message}`, res.messageId));
  }
  if (res.created && channel.kind !== 'whatsapp') {
    fetchProfileName(channel, item.userId).then((name) => {
      if (!name) return;
      run('update contacts set name = ? where id = ?', name, res.contactId);
      run("update leads set name = ? where id = ? and name in ('Cliente Instagram','Cliente Messenger')", name, res.leadId);
      emit('lead', { id: res.leadId });
    }).catch(() => {});
  }
  return res;
}

// Veio de anúncio (Facebook/Instagram): etiqueta no contato e o anúncio anotado no lead.
export const AD_TAG = 'Veio do anúncio';
// Contato novo que veio do anúncio é salvo como "<prefixo do perfil> <nome do perfil>" (ex.: "Agro Sinal Maria";
// sem nome: o telefone). Empresa sem prefixo no perfil: só o nome.
export function adContactName(name, phone) {
  const prefix = perfil().prefixoAnuncio;
  const base = String(name || '').replace(/^Cliente (WhatsApp|Instagram|Messenger)$/, '').trim() || String(phone || '').replace(/@.*/, '');
  if (!prefix) return base;
  return base.toLowerCase().startsWith(prefix.toLowerCase()) ? base : `${prefix} ${base}`.trim();
}
function markAd(res, ad) {
  if (res.created) {
    const c = one('select name from contacts where id = ?', res.contactId);
    const conv = one('select external_id from conversations where id = ?', res.conversationId);
    const name = adContactName(c?.name, conv?.external_id);
    run('update contacts set name = ? where id = ?', name, res.contactId);
    if (res.leadId) run('update leads set name = ? where id = ?', name, res.leadId);
    res.adName = name;
  }
  let t = one('select id from tags where name = ?', AD_TAG);
  if (!t) t = { id: Number(run("insert into tags(name, color) values(?, '#1877f2')", AD_TAG).lastInsertRowid) };
  run("insert or ignore into entity_tags(entity, entity_id, tag_id) values('contact', ?, ?)", res.contactId, t.id);
  emit('contact', { id: res.contactId });
  if (!res.leadId) return;
  const body = [`📣 Chegou pelo anúncio do ${ad.where}`, ad.title && `Anúncio: ${ad.title}`, ad.text && `Texto: ${ad.text}`,
    ad.url && `Link: ${ad.url}`, ad.id && `ID do anúncio: ${ad.id}`].filter(Boolean).join('\n');
  run('insert into notes(entity, entity_id, body, created_by, created_at) values(?, ?, ?, null, ?)', 'lead', res.leadId, body, now());
  logEvent('lead', res.leadId, 'ad_click', ad);
  emit('lead', { id: res.leadId });
}

export function handleStatus(item) {
  const m = one('select id, status, conversation_id from messages where external_id = ?', item.external_id);
  if (!m || !(item.status in RANK)) return;
  if (RANK[item.status] <= RANK[m.status] && item.status !== 'failed') return; // status só avança
  run('update messages set status = ?, error = ? where id = ?', item.status, item.error, m.id);
  emit('message', { conversation_id: m.conversation_id });
}

export function handleWebhookItems(items) {
  for (const it of items) {
    try {
      if (it.type === 'message') handleMessage(it);
      else if (it.type === 'status') handleStatus(it);
      else if (it.type === 'template_status' && it.meta_id && it.status) {
        run('update wa_templates set status = ?, updated_at = ? where meta_id = ?', it.status, now(), it.meta_id);
        emit('config');
      }
    } catch (e) {
      console.error('webhook item falhou', e);
    }
  }
}

