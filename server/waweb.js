// WhatsApp pelo WhatsApp Web (do mesmo jeito que o WA Web Plus): o CRM vira um "aparelho conectado" do seu número.
// Usa a biblioteca whatsapp-web.js, que abre o WhatsApp Web num Chrome invisível. A sessão fica em data/whatsapp-web,
// então só é preciso ler o QR code uma vez.
// Atenção: automação pelo WhatsApp Web não é oficial; o ritmo das campanhas (intervalo, lotes e pausas) é o que protege o número.
import fs from 'node:fs';
import path from 'node:path';
import { one, all, run, now, DATA_DIR, getSetting, setSetting } from './db.js';
import { emit } from './bus.js';
import { handleMessage, handleStatus } from './inbound.js';
import { findContactByPoint } from './crm.js';

const sessions = new Map(); // channelId -> { state, qr, me, error, client }
let lib = null;
let echoDelay = 3000;
export function setWaLib(fake, opts = {}) { lib = fake; echoDelay = opts.echoDelay ?? echoDelay; } // testes usam um WhatsApp falso
async function loadLib() {
  if (lib) return lib;
  const m = await import('whatsapp-web.js');
  const qrcode = (await import('qrcode')).default;
  const w = m.default || m;
  // No Windows o Chrome segura os arquivos da sessão: apagar a pasta no "deslogou" dá EBUSY e a biblioteca derrubava o CRM.
  // Aqui o erro só é anotado; a pasta velha é apagada na próxima vez que o canal ligar, antes de abrir o Chrome.
  class SafeLocalAuth extends w.LocalAuth {
    async logout() {
      try { await super.logout(); } catch (e) {
        console.error('whatsapp web: sessão antiga presa, apago na próxima vez:', e.message);
        try { fs.writeFileSync(`${this.userDataDir}.limpar`, String(Date.now())); } catch {}
      }
    }
  }
  lib = { Client: w.Client, LocalAuth: SafeLocalAuth, MessageMedia: w.MessageMedia, toDataURL: (s) => qrcode.toDataURL(s, { margin: 1, width: 300 }) };
  return lib;
}

// Sessão marcada para apagar (deslogou com o Chrome aberto): apaga agora, com o Chrome ainda fechado.
export function cleanStale(channelId) {
  const dir = path.join(DATA_DIR, 'whatsapp-web', `session-canal${channelId}`);
  // Trava do Chrome deixada por um servidor anterior (na nuvem, cada reinício é outra máquina): sem apagar, o Chrome não abre.
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
  if (!fs.existsSync(`${dir}.limpar`)) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); fs.rmSync(`${dir}.limpar`, { force: true }); }
  catch (e) { console.error('whatsapp web: não deu para apagar a sessão antiga', e.message); }
}

export const isWeb = (channel) => { try { return JSON.parse(channel.config).mode === 'web'; } catch { return false; } };
export function webStatus(channelId) {
  const s = sessions.get(channelId);
  // booting: o CRM acabou de abrir e o WhatsApp ainda não ficou pronto nenhuma vez (campanha espera em vez de pausar)
  return s ? { state: s.state, qr: s.qr, me: s.me, error: s.error, booting: !s.wasReady && ['starting', 'qr'].includes(s.state) } : { state: 'off', qr: null, me: null, error: null, booting: true };
}

export async function startWeb(channel) {
  const cur = sessions.get(channel.id);
  if (cur && ['starting', 'qr', 'ready'].includes(cur.state)) return webStatus(channel.id);
  let L;
  try { L = await loadLib(); } catch (e) {
    console.error('whatsapp web: biblioteca', e.message);
    sessions.set(channel.id, { state: 'error', qr: null, me: null, error: 'Falta instalar o componente do WhatsApp Web: feche o CRM e abra o iniciar.bat de novo (precisa de internet).' });
    return webStatus(channel.id);
  }
  // Tentativa anterior travada (erro/desconectado): fecha o Chrome dela antes de abrir outro na mesma pasta.
  if (cur?.client) { try { await cur.client.destroy(); } catch {} }
  const s = { state: 'starting', qr: null, me: null, error: null, client: null };
  sessions.set(channel.id, s);
  cleanStale(channel.id);
  const set = (p) => { Object.assign(s, p); emit('waweb', { channel_id: channel.id }); };
  const client = new L.Client({
    authStrategy: new L.LocalAuth({ clientId: `canal${channel.id}`, dataPath: path.join(DATA_DIR, 'whatsapp-web') }),
    authTimeoutMs: 120000, // no servidor o WhatsApp pode levar mais de 30 s para abrir (o padrão de 30 s dava "Waiting failed")
    // Na nuvem usa o Chromium do servidor (CHROME_PATH); no PC, o Chrome que o whatsapp-web.js baixa.
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }) },
  });
  s.client = client;
  client.on('qr', async (qr) => set({ state: 'qr', qr: await L.toDataURL(qr) }));
  client.on('ready', () => {
    const me = client.info?.wid?.user || null;
    set({ state: 'ready', qr: null, me, error: null, wasReady: true });
    const cfg = JSON.parse(one('select config from channels where id = ?', channel.id).config);
    run("update channels set config = ?, status = case when status = 'error' then 'active' else status end where id = ?", JSON.stringify({ ...cfg, me }), channel.id);
    emit('config');
    catchUp(channel.id, client).catch((e) => console.error('whatsapp web: mensagens enquanto estava fechado', e.message));
  });
  client.on('auth_failure', (m) => set({ state: 'error', error: `Não conseguiu entrar: ${m}` }));
  // LOGOUT: o celular desconectou (ou a sessão guardada era velha). A biblioteca já gera um QR novo sozinha.
  client.on('disconnected', (reason) => set(reason === 'LOGOUT'
    ? { state: 'starting', qr: null, error: null }
    : { state: 'off', qr: null, error: reason ? `Desconectado (${reason})` : 'Desconectado' }));
  client.on('message', (msg) => onIncoming(channel.id, msg).catch((e) => console.error('whatsapp web: mensagem', e)));
  // Mensagens que você manda pelo celular: aparecem no CRM e fazem o robô sair da conversa.
  client.on('message_create', (msg) => { if (msg.fromMe) setTimeout(() => onOwn(channel.id, msg).catch((e) => console.error('whatsapp web: eco', e)), echoDelay); });
  client.on('message_ack', (msg, ack) => {
    const status = ack === -1 ? 'failed' : { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' }[ack];
    if (status) handleStatus({ external_id: msg.id?._serialized, status, error: null });
  });
  client.initialize().catch((e) => set({ state: 'error', error: e.message }));
  return webStatus(channel.id);
}

export async function stopWeb(channelId, { logout = false } = {}) {
  const s = sessions.get(channelId);
  if (!s?.client) return;
  try { if (logout) await s.client.logout(); } catch {}
  try { await s.client.destroy(); } catch {}
  sessions.delete(channelId);
  // Desconectar = começar do zero: com a página travada o logout da biblioteca não apaga a sessão, então apaga aqui (Chrome já fechado).
  if (logout) { try { fs.rmSync(path.join(DATA_DIR, 'whatsapp-web', `session-canal${channelId}`), { recursive: true, force: true, maxRetries: 5 }); } catch (e) { console.error('whatsapp web: não deu para apagar a sessão', e.message); } }
  emit('waweb', { channel_id: channelId });
}

// Liga sozinho, ao abrir o CRM, os canais que já leram o QR code.
export function bootWeb() {
  for (const ch of all("select * from channels where kind = 'whatsapp' and status != 'disabled'").filter(isWeb)) {
    startWeb(ch).catch((e) => console.error('whatsapp web', e));
  }
}

const ready = (channelId) => {
  const s = sessions.get(channelId);
  if (s?.state !== 'ready') throw Object.assign(new Error('WhatsApp Web desconectado: abra Ajustes › Canais e leia o QR code'), { fatal: true, status: 409 });
  return s;
};

// "5567998881001" -> id do chat certo no WhatsApp (resolve sozinho o 9 dos celulares). null = número sem WhatsApp.
export async function resolveNumber(channel, to) {
  const s = ready(channel.id);
  if (String(to).includes('@')) return String(to);
  const digits = String(to).replace(/\D/g, '');
  // Código interno do WhatsApp (LID, 14+ dígitos) não é telefone: manda direto para ele, sem procurar número.
  if (digits.length >= 14) return `${digits}@lid`;
  const r = await s.client.getNumberId(digits);
  if (r?._serialized) return r._serialized;
  // Quem chega por anúncio pode vir só com o id interno do WhatsApp (LID, 14-15 dígitos), não com o telefone.
  return digits.length >= 14 ? `${digits}@lid` : null;
}

// Envia texto ou imagem com legenda. Botões viram uma lista numerada (o cliente responde "1", "2"...).
export async function sendWeb(channel, to, { text = '', file, buttons } = {}) {
  const s = ready(channel.id);
  const chatId = await resolveNumber(channel, to);
  if (!chatId) throw Object.assign(new Error('Este número não tem WhatsApp'), { noWhatsApp: true, status: 400 });
  const opts = (buttons || []).filter(Boolean);
  if (opts.length) text = `${text}\n\n${opts.map((b, i) => `${i + 1}. ${b}`).join('\n')}`;
  let m;
  if (file) {
    const L = await loadLib();
    m = await s.client.sendMessage(chatId, new L.MessageMedia(file.mime, Buffer.from(file.buf).toString('base64'), file.name), text ? { caption: text } : {});
  } else m = await s.client.sendMessage(chatId, text);
  return { id: m?.id?._serialized || null, wa_id: chatId.endsWith('@c.us') ? chatId.split('@')[0] : chatId };
}

const KIND = { chat: 'text', image: 'image', video: 'video', ptt: 'audio', audio: 'audio', document: 'document', sticker: 'sticker', location: 'location' };
const IGNORE = /@(g\.us|broadcast|newsletter)$/;
const SYSTEM = /^(e2e_notification|notification|notification_template|gp2|protocol|ciphertext|revoked|call_log|broadcast_notification|pinned_message)$/;

// Id interno (xxx@lid) -> telefone (5567...), quando o WhatsApp informa. Sem telefone, a conversa usa o próprio id.
async function phoneOfLid(channelId, chatId) {
  try {
    const [r] = await sessions.get(channelId).client.getContactLidAndPhone([chatId]);
    const pn = String(r?.pn || '');
    return pn.endsWith('@c.us') ? pn.split('@')[0] : null;
  } catch { return null; }
}

async function toItem(channel, msg, direction) {
  const chat = direction === 'in' ? msg.from : msg.to;
  if (!chat || IGNORE.test(chat) || msg.isStatus) return null;
  let phone = chat.endsWith('@c.us') ? chat.split('@')[0] : null;
  let name = msg._data?.notifyName || '';
  const lid = chat.endsWith('@lid');
  if (lid) phone = await phoneOfLid(channel.id, chat); // anúncio/contato novo: troca o id interno pelo telefone
  if (direction === 'in') {
    try { const c = await msg.getContact(); if (!lid) phone ||= c?.number || null; name ||= c?.pushname || c?.name || ''; } catch {}
  }
  const kind = KIND[msg.type] || 'other';
  // Avisos do próprio WhatsApp (criptografia, sistema, chamada, mensagem apagada) chegam como mensagem vazia: não são o cliente falando.
  if (SYSTEM.test(msg.type || '') || (kind === 'other' && !String(msg.body || '').trim() && !msg.hasMedia)) return null;
  let media = null;
  if (msg.hasMedia) {
    try {
      const m = await msg.downloadMedia();
      if (m?.data) media = { buf: Buffer.from(m.data, 'base64'), mime: m.mimetype, name: m.filename || `${kind}.${(m.mimetype || '').split('/')[1]?.split(';')[0] || 'bin'}` };
    } catch {}
  }
  return {
    type: 'message', kind: 'whatsapp', channelExternalId: channel.external_id,
    userId: phone || chat, userName: name, ts: msg.timestamp ? msg.timestamp * 1000 : now(), direction,
    msg: { kind, body: msg.body || '', external_id: msg.id?._serialized || null, media },
    ad: direction === 'in' ? adOf(msg) : null,
  };
}

// Mensagem que veio de um anúncio "clique para WhatsApp" (Facebook/Instagram): o WhatsApp manda junto os dados do anúncio.
export function adOf(msg) {
  const c = msg._data?.ctwaContext;
  if (!c || typeof c !== 'object') return null;
  const s = (v) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
  const ad = { id: s(c.sourceId), url: s(c.sourceUrl), title: s(c.title), text: s(c.description) };
  if (!ad.id && !ad.url && !ad.title) return null;
  return { ...ad, where: /instagram\.com/i.test(ad.url) ? 'Instagram' : 'Facebook' };
}

// Ao ligar: quem escreveu enquanto o CRM estava fechado (até 24 h para trás) entra agora.
// Mensagem já gravada é ignorada (mesmo id). Na primeira vez só marca a hora, para não puxar conversas antigas.
const SEEN = (channelId) => `waweb_seen:${channelId}`;
async function catchUp(channelId, client) {
  const last = getSetting(SEEN(channelId), 0);
  setSetting(SEEN(channelId), now());
  if (!last || typeof client.getChats !== 'function') return;
  const since = Math.max(last - 60e3, now() - 24 * 3600e3);
  for (const chat of await client.getChats()) {
    const id = chat.id?._serialized || '';
    if (chat.isGroup || IGNORE.test(id) || (chat.timestamp || 0) * 1000 < since) continue;
    for (const m of await chat.fetchMessages({ limit: 30 })) {
      if (!m.fromMe && (m.timestamp || 0) * 1000 >= since) await onIncoming(channelId, m).catch((e) => console.error('whatsapp web: mensagem', e));
    }
  }
}

async function onIncoming(channelId, msg) {
  if (msg.fromMe) return;
  setSetting(SEEN(channelId), now());
  const channel = one("select * from channels where id = ? and status != 'disabled'", channelId);
  const item = channel && await toItem(channel, msg, 'in');
  const res = item && handleMessage(item);
  // Veio do anúncio e é contato novo: salva também na agenda do celular ("Agro Sinal <nome>").
  if (res?.adName && /^\d{10,13}$/.test(item.userId)) { // código interno (LID) não vai para a agenda
    const s = sessions.get(channelId);
    const last = res.adName.replace(/^Agro Sinal\s*/i, '');
    s?.client?.saveOrEditAddressbookContact?.(item.userId, 'Agro Sinal', last, true)
      .catch((e) => console.error('whatsapp web: salvar contato na agenda', e.message));
  }
}

// Só registra o que você mandou pelo celular em conversas que já estão no CRM (conversas pessoais ficam de fora).
// O que o próprio CRM enviou já está gravado com o mesmo id e é ignorado.
async function onOwn(channelId, msg) {
  const channel = one("select * from channels where id = ? and status != 'disabled'", channelId);
  if (!channel || !msg.id?._serialized || one('select 1 from messages where external_id = ?', msg.id._serialized)) return;
  const item = await toItem(channel, msg, 'out');
  if (!item) return;
  const known = one("select id from conversations where channel_id = ? and external_id = ? and status = 'open'", channel.id, item.userId)
    || (() => { const c = /^\d{10,15}$/.test(item.userId) && findContactByPoint('phone', item.userId); return c && one("select id from conversations where channel_id = ? and contact_id = ? and status = 'open'", channel.id, c.id); })();
  if (!known) return;
  const res = handleMessage(item);
  if (res) {
    const { flowOnHuman } = await import('./flows.js');
    flowOnHuman(res.conversationId);
  }
}
