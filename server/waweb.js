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
let lib = null; // testes: WhatsApp falso para todos os números
const libs = {}; // motor -> biblioteca carregada
let echoDelay = 3000;
export function setWaLib(fake, opts = {}) { lib = fake; echoDelay = opts.echoDelay ?? echoDelay; } // testes usam um WhatsApp falso
// Motor de cada número: "baileys" (leve, sem navegador, o login volta sozinho ao reiniciar) ou "wwebjs" (WhatsApp Web de
// verdade num Chrome invisível: mais aceito pelo WhatsApp para disparo, mas costuma pedir QR de novo a cada atualização).
// Sem escolha no número, vale WA_ENGINE (na nuvem: baileys).
export const ENGINES = ['baileys', 'wwebjs'];
export function engineOf(channel) {
  try { const e = JSON.parse(channel?.config || '{}').engine; if (ENGINES.includes(e)) return e; } catch {}
  return process.env.WA_ENGINE === 'baileys' ? 'baileys' : 'wwebjs';
}
async function loadLib(engine = engineOf(null)) {
  if (lib) return lib;
  if (libs[engine]) return libs[engine];
  const qrcode = (await import('qrcode')).default;
  const toDataURL = (s) => qrcode.toDataURL(s, { margin: 1, width: 300 });
  if (engine === 'baileys') {
    const b = await import('./baileys.js');
    return (libs[engine] = { Client: b.Client, LocalAuth: b.LocalAuth, MessageMedia: b.MessageMedia, toDataURL });
  }
  const m = await import('whatsapp-web.js');
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
  return (libs[engine] = { Client: w.Client, LocalAuth: SafeLocalAuth, MessageMedia: w.MessageMedia, toDataURL });
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

// Se cair ou travar ao abrir, tenta de novo sozinho (1, 2 e 3 min). Na 4ª falha seguida a sessão guardada está
// estragada: apaga, gera QR novo e avisa o administrador por e-mail.
const failures = new Map(); // channelId -> falhas seguidas
const everReady = new Set(); // canais que já conectaram desde que o CRM abriu
let lastAlert = 0;
async function alertAdmin(text) {
  if (Date.now() - lastAlert < 3 * 3600e3) return; // no máximo um aviso a cada 3 h
  lastAlert = Date.now();
  try {
    const to = one('select email from users where is_admin = 1 and is_active = 1 order by id limit 1')?.email;
    const base = (getSetting('general', {}).public_url || '').replace(/\/$/, '');
    if (!to) return;
    const { sendEmail } = await import('./outbound.js');
    await sendEmail({ to, subject: 'Semeia: o WhatsApp precisa ser conectado de novo', unsubscribe: false,
      text: `${text}\n\nAbra ${base || 'o Semeia'} › Ajustes › Canais e leia o QR code com o celular (WhatsApp › Aparelhos conectados).` });
  } catch (e) { console.error('whatsapp web: aviso por e-mail não saiu', e.message); }
}
function retryLater(channel, why) {
  const n = (failures.get(channel.id) || 0) + 1;
  failures.set(channel.id, n);
  if (n > 3) {
    failures.delete(channel.id);
    console.error(`whatsapp web: ${why}; 4 falhas seguidas, apago a sessão e gero QR novo`);
    stopWeb(channel.id, { logout: true }).then(() => startWeb(channel)).catch((e) => console.error('whatsapp web', e.message));
    alertAdmin('O WhatsApp do Semeia não conseguiu reconectar sozinho e pede um QR code novo.');
    return;
  }
  console.error(`whatsapp web: ${why}; tento de novo em ${n} min`);
  setTimeout(() => {
    const cur = sessions.get(channel.id);
    if (cur && ['error', 'off'].includes(cur.state)) startWeb(channel).catch((e) => console.error('whatsapp web', e.message));
  }, n * 60e3).unref();
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
  try { L = await loadLib(engineOf(channel)); } catch (e) {
    console.error('whatsapp web: biblioteca', e.message);
    sessions.set(channel.id, { state: 'error', qr: null, me: null, error: 'Falta instalar o componente do WhatsApp Web: feche o CRM e abra o iniciar.bat de novo (precisa de internet).' });
    return webStatus(channel.id);
  }
  // Tentativa anterior travada (erro/desconectado): fecha o Chrome dela antes de abrir outro na mesma pasta.
  if (cur?.client) { try { await cur.client.destroy(); } catch {} }
  const s = { state: 'starting', qr: null, me: null, error: null, client: null };
  sessions.set(channel.id, s);
  cleanStale(channel.id);
  // Diagnóstico: o login guardado existia ao abrir? (se existia e mesmo assim pediu QR, o WhatsApp recusou a sessão)
  const hadSession = fs.existsSync(path.join(DATA_DIR, 'whatsapp-web', `session-canal${channel.id}`, 'Default', 'IndexedDB'))
    || fs.existsSync(path.join(DATA_DIR, 'whatsapp-web', `baileys-canal${channel.id}`, 'creds.json'));
  let qrLogged = false;
  const set = (p) => { Object.assign(s, p); emit('waweb', { channel_id: channel.id }); };
  const client = new L.Client({
    authStrategy: new L.LocalAuth({ clientId: `canal${channel.id}`, dataPath: path.join(DATA_DIR, 'whatsapp-web') }),
    authTimeoutMs: 120000, // no servidor o WhatsApp pode levar mais de 30 s para abrir (o padrão de 30 s dava "Waiting failed")
    // Na nuvem usa o Chromium do servidor (CHROME_PATH); no PC, o Chrome que o whatsapp-web.js baixa.
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }) },
  });
  s.client = client;
  client.on('change_state', (st) => console.log('whatsapp web: estado', st));
  client.on('auth_failure', (m) => console.error('whatsapp web: login guardado recusado', m));
  client.on('qr', async (qr) => {
    if (!qrLogged) { qrLogged = true; console.log(`whatsapp web: pediu QR (login guardado ao abrir: ${hadSession ? 'sim' : 'não'})`); }
    set({ state: 'qr', qr: await L.toDataURL(qr), qrAt: Date.now() });
    if (everReady.has(channel.id)) { everReady.delete(channel.id); alertAdmin('O WhatsApp do Semeia foi desconectado pelo celular.'); }
  });
  client.on('ready', () => {
    console.log(`whatsapp web: conectado (${hadSession ? 'voltou com o login guardado' : 'login novo pelo QR'})`);
    const me = client.info?.wid?.user || null;
    set({ state: 'ready', qr: null, me, error: null, wasReady: true });
    failures.delete(channel.id); everReady.add(channel.id);
    // Conectou: a sessão desta pasta é boa. Marca de "apagar" antiga não pode apagar o login novo no próximo reinício.
    fs.rmSync(path.join(DATA_DIR, 'whatsapp-web', `session-canal${channel.id}.limpar`), { force: true });
    const cfg = JSON.parse(one('select config from channels where id = ?', channel.id).config);
    run("update channels set config = ?, status = case when status = 'error' then 'active' else status end where id = ?", JSON.stringify({ ...cfg, me }), channel.id);
    emit('config');
    catchUp(channel.id, client).catch((e) => console.error('whatsapp web: mensagens enquanto estava fechado', e.message));
  });
  client.on('auth_failure', (m) => set({ state: 'error', error: `Não conseguiu entrar: ${m}` }));
  // LOGOUT: o celular desconectou (ou a sessão guardada era velha). A biblioteca já gera um QR novo sozinha.
  client.on('disconnected', (reason) => {
    if (sessions.get(channel.id) !== s) return; // tentativa antiga, já substituída
    if (reason === 'LOGOUT') return set({ state: 'starting', qr: null, error: null });
    set({ state: 'off', qr: null, error: reason ? `Desconectado (${reason})` : 'Desconectado' });
    retryLater(channel, `caiu (${reason || 'sem motivo'})`);
  });
  client.on('message', (msg) => onIncoming(channel.id, msg, { noFlow: !!msg._noFlow }).catch((e) => console.error('whatsapp web: mensagem', e)));
  // Mensagens que você manda pelo celular: aparecem no CRM e fazem o robô sair da conversa.
  client.on('message_create', (msg) => { if (msg.fromMe) setTimeout(() => onOwn(channel.id, msg).catch((e) => console.error('whatsapp web: eco', e)), echoDelay); });
  // Leu no celular -> lida no CRM.
  client.on('chat_read', (chat) => onChatRead(channel.id, chat).catch((e) => console.error('whatsapp web: lida no celular', e.message)));
  client.on('unread_count', (chat) => { if (chat?.unreadCount === 0) onChatRead(channel.id, chat.id?._serialized).catch(() => {}); }); // whatsapp-web.js
  client.on('message_ack', (msg, ack) => {
    const status = ack === -1 ? 'failed' : { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' }[ack];
    if (status) handleStatus({ external_id: msg.id?._serialized, status, error: null });
  });
  client.initialize().catch((e) => {
    if (sessions.get(channel.id) !== s) return;
    const why = e?.message || (typeof e === 'string' ? e : '') || (() => { try { return JSON.stringify(e); } catch { return String(e); } })() || 'erro sem descrição';
    console.error('whatsapp web: falha ao abrir', e?.stack || why);
    set({ state: 'error', error: why });
    retryLater(channel, `não abriu (${why})`);
  });
  return webStatus(channel.id);
}

export async function stopWeb(channelId, { logout = false } = {}) {
  const s = sessions.get(channelId);
  if (!s?.client) return;
  try { if (logout) await s.client.logout(); } catch {}
  try { await s.client.destroy(); } catch {}
  sessions.delete(channelId);
  // Desconectar = começar do zero: com a página travada o logout da biblioteca não apaga a sessão, então apaga aqui (Chrome já fechado).
  if (logout) {
    const dir = path.join(DATA_DIR, 'whatsapp-web', `session-canal${channelId}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); fs.rmSync(`${dir}.limpar`, { force: true });
      fs.rmSync(path.join(DATA_DIR, 'whatsapp-web', `baileys-canal${channelId}`), { recursive: true, force: true });
    }
    catch (e) { console.error('whatsapp web: não deu para apagar a sessão', e.message); }
  }
  emit('waweb', { channel_id: channelId });
}

// QR parado: o WhatsApp para de renovar o código depois de alguns minutos e o celular não consegue ler o vencido.
// Quando alguém está olhando a tela (ela consulta o status), começa de novo do zero e aparece um QR novo.
export function refreshStaleQr(channelId, maxAgeMs = 60e3) {
  const s = sessions.get(channelId);
  if (!s || s.state !== 'qr' || s.refreshing || Date.now() - (s.qrAt || 0) < maxAgeMs) return false;
  s.refreshing = true;
  const channel = one('select * from channels where id = ?', channelId);
  if (!channel) return false;
  stopWeb(channelId, { logout: true }).then(() => startWeb(channel)).catch((e) => console.error('whatsapp web: renovar QR', e.message));
  return true;
}

// Desligar com calma: fecha o Chrome de cada canal para a sessão ficar gravada inteira.
// Matar o Chrome no meio (reinício do servidor, fechar a janela do CRM) estragava a sessão e o WhatsApp não voltava.
export async function stopAllWeb() {
  await Promise.all([...sessions.keys()].map((id) => stopWeb(id).catch(() => {})));
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

// Mostra "digitando..." para o cliente (antes da IA responder). Se não der, só não mostra.
export async function typingWeb(channel, to) {
  try {
    const s = ready(channel.id);
    const chatId = await resolveNumber(channel, to);
    if (chatId) await s.client.typing?.(chatId);
  } catch {}
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
    const L = await loadLib(engineOf(channel));
    m = await s.client.sendMessage(chatId, new L.MessageMedia(file.mime, Buffer.from(file.buf).toString('base64'), file.name), text ? { caption: text } : {});
  } else m = await s.client.sendMessage(chatId, text);
  return { id: m?.id?._serialized || null, wa_id: chatId.endsWith('@c.us') ? chatId.split('@')[0] : chatId };
}

const KIND = { chat: 'text', image: 'image', video: 'video', ptt: 'audio', audio: 'audio', document: 'document', sticker: 'sticker', location: 'location' };
const IGNORE = /@(g\.us|broadcast|newsletter)$/;
const SYSTEM = /^(e2e_notification|notification|notification_template|gp2|protocol|ciphertext|revoked|call_log|broadcast_notification|pinned_message)$/;

// Id interno (xxx@lid) -> telefone (5567...), quando o WhatsApp informa. Sem telefone, a conversa usa o próprio id.
// Você leu a conversa no celular: zera o "não lidas" dela no CRM.
async function onChatRead(channelId, chat) {
  if (!chat || IGNORE.test(chat)) return;
  const ids = new Set([chat, chat.split('@')[0]]);
  if (chat.endsWith('@lid')) { const p = await phoneOfLid(channelId, chat); if (p) ids.add(p); }
  const list = [...ids];
  for (const c of all(`select id, lead_id from conversations where channel_id = ? and unread > 0 and external_id in (${list.map(() => '?').join(',')})`, channelId, ...list)) {
    run('update conversations set unread = 0 where id = ?', c.id);
    emit('message', { conversation_id: c.id, lead_id: c.lead_id });
  }
}

// Você leu a conversa no CRM: marca como lida no celular (as últimas `count` mensagens do cliente).
export async function markReadWeb(channel, conv, count = 1) {
  const s = sessions.get(channel.id);
  if (s?.state !== 'ready') return false;
  const ids = all("select external_id from messages where conversation_id = ? and direction = 'in' and external_id is not null order by id desc limit ?",
    conv.id, Math.min(50, Math.max(1, count))).map((m) => m.external_id).reverse();
  if (!ids.length) return false;
  const chatId = await resolveNumber(channel, conv.external_id).catch(() => null);
  if (s.client.markRead) await s.client.markRead(chatId, ids);
  else if (chatId) await (await s.client.getChatById(chatId)).sendSeen();
  else return false;
  return true;
}

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
    const msgs = await chat.fetchMessages({ limit: 30 });
    // Você respondeu pelo celular depois da mensagem do cliente: o robô não entra (não responde por cima de você).
    const lastOwn = Math.max(0, ...msgs.filter((m) => m.fromMe).map((m) => m.timestamp || 0));
    for (const m of msgs) {
      if ((m.timestamp || 0) * 1000 < since) continue;
      if (m.fromMe) await onOwn(channelId, m).catch((e) => console.error('whatsapp web: eco', e));
      else await onIncoming(channelId, m, { noFlow: (m.timestamp || 0) <= lastOwn }).catch((e) => console.error('whatsapp web: mensagem', e));
    }
  }
}

async function onIncoming(channelId, msg, { noFlow = false } = {}) {
  if (msg.fromMe) return;
  setSetting(SEEN(channelId), now());
  const channel = one("select * from channels where id = ? and status != 'disabled'", channelId);
  const item = channel && await toItem(channel, msg, 'in');
  if (item && noFlow) item.noFlow = true;
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
