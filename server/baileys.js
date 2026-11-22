// Motor do WhatsApp sem navegador (Baileys, @whiskeysockets/baileys): conversa direto com o WhatsApp como um
// "aparelho conectado". O login fica em arquivos (data/whatsapp-web/baileys-canalN) e volta sozinho ao reiniciar,
// sem pedir QR de novo. É bem mais leve que abrir um Chrome, então cabe mais de um número.
// Este arquivo imita só o pedaço do whatsapp-web.js que o waweb.js usa, para o resto do CRM não mudar.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const silent = { level: 'silent', child() { return silent; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
const toC = (jid) => String(jid || '').replace(/@s\.whatsapp\.net$/, '@c.us'); // formato que o resto do CRM usa
const toS = (jid) => String(jid || '').replace(/@c\.us$/, '@s.whatsapp.net'); // formato do Baileys
const userOf = (jid) => String(jid || '').split('@')[0].split(':')[0];
const secs = (t) => (t && typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t) || Math.floor(Date.now() / 1000));

let B = null;
export function setBaileys(fake) { B = fake; } // testes
async function load() {
  if (B) return B;
  const m = await import('@whiskeysockets/baileys');
  const d = m.default && typeof m.default === 'object' ? m.default : {};
  B = { ...d, ...m };
  B.makeWASocket = [m.makeWASocket, d.makeWASocket, d.default, m.default].find((f) => typeof f === 'function');
  return B;
}

export class LocalAuth {
  constructor({ clientId, dataPath }) { this.dir = path.join(dataPath, `baileys-${clientId}`); }
}

export class MessageMedia {
  constructor(mimetype, data, filename) { Object.assign(this, { mimetype, data, filename }); }
}

// Mensagem do WhatsApp pode vir "embrulhada" (temporária, visualização única, documento com legenda).
function unwrap(m) {
  let x = m || {};
  for (let i = 0; i < 4; i++) {
    const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message
      || x.viewOnceMessageV2Extension?.message || x.documentWithCaptionMessage?.message || x.editedMessage?.message;
    if (!inner) break;
    x = inner;
  }
  return x;
}
const TYPES = [['conversation', 'chat'], ['extendedTextMessage', 'chat'], ['imageMessage', 'image'], ['videoMessage', 'video'],
  ['audioMessage', 'audio'], ['documentMessage', 'document'], ['stickerMessage', 'sticker'], ['locationMessage', 'location'],
  ['liveLocationMessage', 'location'], ['buttonsResponseMessage', 'chat'], ['listResponseMessage', 'chat'], ['templateButtonReplyMessage', 'chat']];
const MEDIA = { imageMessage: 1, videoMessage: 1, audioMessage: 1, documentMessage: 1, stickerMessage: 1 };

export function describe(wm) {
  const m = unwrap(wm.message);
  const key = (TYPES.find(([k]) => m[k]) || [])[0];
  let type = key ? Object.fromEntries(TYPES)[key] : 'protocol'; // só aviso/reação/criptografia: não é o cliente falando
  if (key === 'audioMessage' && m.audioMessage.ptt) type = 'ptt';
  const body = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption
    || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title
    || m.templateButtonReplyMessage?.selectedDisplayText || '';
  const ctx = (key && m[key]?.contextInfo) || {};
  const ad = ctx.externalAdReply; // veio de anúncio "clique para WhatsApp"
  const ctwa = ad ? { sourceId: ad.sourceId || '', sourceUrl: ad.sourceUrl || '', title: ad.title || '', description: ad.body || '' } : null;
  return { m, key, type, body, ctwa, media: key && MEDIA[key] ? m[key] : null };
}

export class Client extends EventEmitter {
  constructor({ authStrategy } = {}) {
    super();
    this.auth = authStrategy;
    this.lids = new Map(); // id interno (xxx@lid) -> telefone (5567...@c.us), quando o WhatsApp informa
    this.closed = false;
    this.retries = 0;
    this.info = null;
    this.recent = new Map(); // id -> mensagem enviada (o WhatsApp pode pedir para reenviar se o celular do cliente não conseguiu abrir)
  }

  async initialize() { await load(); await this.connect(); }

  async connect() {
    if (this.closed) return;
    fs.mkdirSync(this.auth.dir, { recursive: true });
    const { state, saveCreds } = await B.useMultiFileAuthState(this.auth.dir);
    let version;
    try { ({ version } = await B.fetchLatestBaileysVersion()); } catch {}
    const sock = B.makeWASocket({
      auth: state, logger: silent, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
      getMessage: async (key) => this.recent.get(key.id),
      ...(B.Browsers?.ubuntu && { browser: B.Browsers.ubuntu('Chrome') }), ...(version && { version }),
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.onConnection(sock, u));
    sock.ev.on('messages.upsert', (u) => this.onUpsert(sock, u));
    sock.ev.on('messages.update', (ups) => {
      for (const x of ups || []) {
        const st = x.update?.status;
        if (st == null || !x.key?.id) continue;
        const ack = st === 0 ? -1 : st - 1; // ERRO / no servidor / entregue / lida / ouvida -> mesmo número do whatsapp-web.js
        if (ack === -1 || ack >= 1) this.emit('message_ack', { id: { _serialized: x.key.id } }, ack);
      }
    });
  }

  onConnection(sock, u) {
    if (sock !== this.sock || this.closed) return;
    if (u.qr) this.emit('qr', u.qr);
    if (u.connection === 'open') {
      this.retries = 0;
      this.info = { wid: { user: userOf(sock.user?.id) } };
      this.emit('ready');
    }
    if (u.connection !== 'close') return;
    const code = u.lastDisconnect?.error?.output?.statusCode;
    const R = B.DisconnectReason || {};
    if (code === R.loggedOut || code === R.badSession) {
      // O celular desconectou o aparelho (ou o login guardado não vale mais): apaga e mostra QR novo.
      try { fs.rmSync(this.auth.dir, { recursive: true, force: true }); } catch {}
      this.emit('disconnected', 'LOGOUT');
      setTimeout(() => this.connect().catch((e) => this.emit('disconnected', e.message)), 1000);
      return;
    }
    // Qualquer outra queda (reinício pedido depois do QR, internet, QR vencido): reconecta sozinho com o mesmo login.
    // connectionReplaced: outro aparelho com o mesmo login assumiu (ex.: o servidor antigo ainda ligado na atualização): espera mais.
    const wait = code === R.restartRequired ? 0 : code === R.connectionReplaced ? 30e3 : Math.min(60e3, 2000 * 2 ** this.retries++);
    setTimeout(() => this.connect().catch((e) => this.emit('disconnected', e.message)), wait);
  }

  wrap(sock, wm, me) {
    const d = describe(wm);
    const jid = toC(wm.key.remoteJid);
    const ts = secs(wm.messageTimestamp);
    return {
      id: { _serialized: wm.key.id },
      from: wm.key.fromMe ? me : jid, to: wm.key.fromMe ? jid : me, fromMe: !!wm.key.fromMe,
      body: d.body, type: d.type, timestamp: ts, hasMedia: !!d.media, isStatus: wm.key.remoteJid === 'status@broadcast',
      _data: { notifyName: wm.pushName || '', ctwaContext: d.ctwa },
      getContact: async () => ({ number: jid.endsWith('@c.us') ? userOf(jid) : null, pushname: wm.pushName || '' }),
      downloadMedia: async () => {
        const buf = await B.downloadMediaMessage(wm, 'buffer', {}, { logger: silent, reuploadRequest: sock.updateMediaMessage });
        return { data: Buffer.from(buf).toString('base64'), mimetype: d.media?.mimetype || 'application/octet-stream', filename: d.media?.fileName || null };
      },
    };
  }

  onUpsert(sock, { messages = [], type } = {}) {
    if (sock !== this.sock) return;
    const me = sock.user?.id ? `${userOf(sock.user.id)}@c.us` : '';
    // Chegou junto (ex.: mensagens de quando estava desconectado) uma resposta sua depois da do cliente: o robô não entra.
    const lastOwn = {};
    for (const wm of messages) if (wm.key?.fromMe) lastOwn[wm.key.remoteJid] = Math.max(lastOwn[wm.key.remoteJid] || 0, secs(wm.messageTimestamp));
    for (const wm of messages) {
      if (!wm.message || !wm.key?.remoteJid) continue;
      const alt = wm.key.remoteJidAlt || wm.key.senderPn || wm.key.participantAlt;
      if (wm.key.remoteJid.endsWith('@lid') && /@s\.whatsapp\.net$/.test(alt || '')) this.lids.set(wm.key.remoteJid, toC(alt));
      const msg = this.wrap(sock, wm, me);
      const age = Date.now() / 1000 - msg.timestamp;
      if (age > 24 * 3600) continue; // histórico antigo não entra
      if (msg.fromMe) { this.emit('message_create', msg); continue; }
      if (type !== 'notify' && type !== 'append') continue;
      msg._noFlow = msg.timestamp <= (lastOwn[wm.key.remoteJid] || 0);
      this.emit('message', msg);
    }
  }

  async getNumberId(digits) {
    const [r] = (await this.sock.onWhatsApp(String(digits))) || [];
    return r?.exists && r.jid ? { _serialized: toC(r.jid) } : null;
  }

  async getContactLidAndPhone(ids) {
    const out = [];
    for (const lid of ids) {
      let pn = this.lids.get(lid);
      if (!pn) {
        try { const r = await this.sock.signalRepository?.lidMapping?.getPNForLID?.(lid); if (r) pn = toC(String(r).replace(/:\d+@/, '@')); } catch {}
      }
      out.push({ lid, pn });
    }
    return out;
  }

  async sendMessage(chatId, content, opts = {}) {
    const jid = toS(chatId);
    let payload;
    if (content && typeof content === 'object' && content.data && content.mimetype) {
      const buf = Buffer.from(content.data, 'base64');
      const mime = content.mimetype;
      const caption = opts.caption || undefined;
      payload = mime.startsWith('image/') ? { image: buf, caption, mimetype: mime }
        : mime.startsWith('video/') ? { video: buf, caption, mimetype: mime }
          : mime.startsWith('audio/') ? { audio: buf, mimetype: mime }
            : { document: buf, mimetype: mime, fileName: content.filename || 'arquivo', caption };
    } else payload = { text: String(content ?? '') };
    const m = await this.sock.sendMessage(jid, payload);
    if (m?.key?.id && m.message) {
      this.recent.set(m.key.id, m.message);
      if (this.recent.size > 5000) this.recent.delete(this.recent.keys().next().value);
    }
    return { id: { _serialized: m?.key?.id || null } };
  }

  async saveOrEditAddressbookContact(phone, first, last) {
    if (typeof this.sock?.addOrEditContact !== 'function') return; // versão sem agenda: só não salva
    await this.sock.addOrEditContact(`${phone}@s.whatsapp.net`, { fullName: `${first} ${last}`.trim(), firstName: first, saveOnPrimaryAddressbook: true });
  }

  async logout() {
    this.closed = true;
    try { await this.sock?.logout(); } catch {}
    try { fs.rmSync(this.auth.dir, { recursive: true, force: true }); } catch {}
  }

  async destroy() {
    this.closed = true;
    try { this.sock?.end?.(undefined); } catch {}
    try { this.sock?.ws?.close?.(); } catch {}
  }
}
