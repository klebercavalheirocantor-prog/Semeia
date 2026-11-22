import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Client, LocalAuth, MessageMedia, setBaileys, describe } from '../server/baileys.js';

// Baileys falso: cada makeWASocket cria um "socket" com ev (eventos) e grava o que foi enviado.
const socks = [];
const R = { loggedOut: 401, badSession: 500, restartRequired: 515, timedOut: 408 };
setBaileys({
  DisconnectReason: R,
  Browsers: { ubuntu: (n) => ['Ubuntu', n, '1'] },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
  useMultiFileAuthState: async (dir) => ({ state: { dir }, saveCreds: () => fs.writeFileSync(path.join(dir, 'creds.json'), '{}') }),
  downloadMediaMessage: async () => Buffer.from('FOTO'),
  makeWASocket: (cfg) => {
    const ev = new EventEmitter();
    const sock = {
      cfg, ev, sent: [], user: null, ended: false,
      onWhatsApp: async (n) => (n === '5567999990000' ? [] : [{ exists: true, jid: `${n.length === 13 ? n.slice(0, 4) + n.slice(5) : n}@s.whatsapp.net` }]),
      sendMessage: async (jid, payload) => { sock.sent.push({ jid, payload }); return { key: { id: `SENT${sock.sent.length}` }, message: { conversation: payload.text || '' } }; },
      logout: async () => {}, end: () => { sock.ended = true; },
      signalRepository: { lidMapping: { getPNForLID: async (lid) => (lid === '999@lid' ? '5567911112222:3@s.whatsapp.net' : null) } },
    };
    socks.push(sock);
    return sock;
  },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

test('motor sem navegador: QR, conecta, recebe, responde, status, cai e volta sozinho', async () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bly-'));
  const c = new Client({ authStrategy: new LocalAuth({ clientId: 'canal1', dataPath }) });
  const ev = { qr: [], ready: 0, msg: [], own: [], ack: [], disc: [] };
  c.on('qr', (q) => ev.qr.push(q)); c.on('ready', () => ev.ready++); c.on('message', (m) => ev.msg.push(m));
  c.on('message_create', (m) => ev.own.push(m)); c.on('message_ack', (m, a) => ev.ack.push([m.id._serialized, a])); c.on('disconnected', (r) => ev.disc.push(r));
  await c.initialize();
  let s = socks.at(-1);
  assert.ok(fs.existsSync(path.join(dataPath, 'baileys-canal1')));
  assert.deepEqual(s.cfg.version, [2, 3000, 1]);
  assert.equal(s.cfg.markOnlineOnConnect, false);

  // QR -> leu -> o WhatsApp pede reinício -> reconecta na hora com o mesmo login -> pronto
  s.ev.emit('connection.update', { qr: 'QR-1' });
  assert.deepEqual(ev.qr, ['QR-1']);
  s.ev.emit('creds.update');
  s.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: R.restartRequired } } } });
  await wait(20);
  assert.equal(socks.length, 2);
  s = socks.at(-1);
  s.user = { id: '556799746861:12@s.whatsapp.net' };
  s.ev.emit('connection.update', { connection: 'open' });
  assert.equal(ev.ready, 1);
  assert.equal(c.info.wid.user, '556799746861');

  // mensagem do cliente (texto) e do anúncio (com dados do anúncio)
  s.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '5567988881111@s.whatsapp.net', id: 'IN1', fromMe: false }, pushName: 'Carlos', messageTimestamp: now(), message: { conversation: 'Qual o preço??' } },
    { key: { remoteJid: '5567988882222@s.whatsapp.net', id: 'IN2', fromMe: false }, pushName: 'Ana', messageTimestamp: now(),
      message: { extendedTextMessage: { text: 'Olá! Posso ter mais informações sobre isso?', contextInfo: { externalAdReply: { sourceId: '1205', sourceUrl: 'https://fb.me/x', title: 'Sinal GPS', body: 'Até 50%' } } } } },
    { key: { remoteJid: '5567988883333@s.whatsapp.net', id: 'IN3', fromMe: false }, messageTimestamp: now(), message: { protocolMessage: { type: 0 } } },
    { key: { remoteJid: '5567988883333@s.whatsapp.net', id: 'OLD', fromMe: false }, messageTimestamp: now() - 3 * 86400, message: { conversation: 'velha' } },
  ] });
  const [m1, m2, m3] = ev.msg;
  assert.equal(ev.msg.length, 3); // a velha (3 dias) fica de fora
  assert.deepEqual([m1.from, m1.to, m1.body, m1.type, m1.id._serialized, m1._data.notifyName], ['5567988881111@c.us', '556799746861@c.us', 'Qual o preço??', 'chat', 'IN1', 'Carlos']);
  assert.deepEqual((await m1.getContact()), { number: '5567988881111', pushname: 'Carlos' });
  assert.deepEqual(m2._data.ctwaContext, { sourceId: '1205', sourceUrl: 'https://fb.me/x', title: 'Sinal GPS', description: 'Até 50%' });
  assert.equal(m3.type, 'protocol'); // aviso do WhatsApp: o CRM ignora

  // anúncio com id interno (LID): o telefone vem junto ou pela tabela do WhatsApp
  s.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '227616573395131@lid', remoteJidAlt: '5567988885555@s.whatsapp.net', id: 'L1', fromMe: false }, messageTimestamp: now(), message: { conversation: 'oi' } }] });
  assert.equal(ev.msg.at(-1).from, '227616573395131@lid');
  assert.deepEqual(await c.getContactLidAndPhone(['227616573395131@lid', '999@lid', '111@lid']), [
    { lid: '227616573395131@lid', pn: '5567988885555@c.us' }, { lid: '999@lid', pn: '5567911112222@c.us' }, { lid: '111@lid', pn: undefined }]);

  // foto do monitor
  s.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '5567988881111@s.whatsapp.net', id: 'IMG', fromMe: false }, messageTimestamp: now(), message: { imageMessage: { mimetype: 'image/jpeg', caption: 'meu monitor' } } }] });
  const img = ev.msg.at(-1);
  assert.deepEqual([img.type, img.hasMedia, img.body], ['image', true, 'meu monitor']);
  assert.deepEqual(await img.downloadMedia(), { data: Buffer.from('FOTO').toString('base64'), mimetype: 'image/jpeg', filename: null });

  // quando estava desconectado: chegou a do cliente e depois a SUA resposta -> marca para o robô não entrar
  s.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '5567988886666@s.whatsapp.net', id: 'N1', fromMe: false }, messageTimestamp: now() - 60, message: { conversation: 'quanto custa?' } },
    { key: { remoteJid: '5567988886666@s.whatsapp.net', id: 'N2', fromMe: true }, messageTimestamp: now() - 30, message: { conversation: 'Bom dia, aqui é o Kleber' } }] });
  assert.equal(ev.msg.at(-1)._noFlow, true);
  assert.deepEqual([ev.own.at(-1).from, ev.own.at(-1).to, ev.own.at(-1).fromMe], ['556799746861@c.us', '5567988886666@c.us', true]);
  assert.equal(m1._noFlow, false);

  // enviar: número (resolve o 9), texto e imagem com legenda; status volta como no whatsapp-web.js
  assert.deepEqual(await c.getNumberId('5567988881111'), { _serialized: '556788881111@c.us' });
  assert.equal(await c.getNumberId('5567999990000'), null);
  const r1 = await c.sendMessage('556788881111@c.us', 'Pra te passar o valor certinho, qual o modelo?');
  assert.deepEqual(s.sent[0], { jid: '556788881111@s.whatsapp.net', payload: { text: 'Pra te passar o valor certinho, qual o modelo?' } });
  // o WhatsApp pede para reenviar (o celular do cliente não abriu): devolve a mensagem guardada
  assert.deepEqual(await s.cfg.getMessage({ id: r1.id._serialized }), { conversation: 'Pra te passar o valor certinho, qual o modelo?' });
  await c.sendMessage('227616573395131@lid', new MessageMedia('image/png', Buffer.from('PNG').toString('base64'), 'tabela.png'), { caption: 'Segue a tabela' });
  assert.equal(s.sent[1].jid, '227616573395131@lid');
  assert.deepEqual([s.sent[1].payload.caption, s.sent[1].payload.mimetype, String(s.sent[1].payload.image)], ['Segue a tabela', 'image/png', 'PNG']);
  await c.sendMessage('556788881111@c.us', new MessageMedia('application/pdf', Buffer.from('PDF').toString('base64'), 'proposta.pdf'));
  assert.deepEqual([s.sent[2].payload.fileName, s.sent[2].payload.mimetype], ['proposta.pdf', 'application/pdf']);
  s.ev.emit('messages.update', [{ key: { id: r1.id._serialized }, update: { status: 2 } }, { key: { id: 'SENT1' }, update: { status: 3 } },
    { key: { id: 'SENT1' }, update: { status: 4 } }, { key: { id: 'X' }, update: { status: 0 } }, { key: { id: 'Y' }, update: { status: 1 } }]);
  assert.deepEqual(ev.ack, [['SENT1', 1], ['SENT1', 2], ['SENT1', 3], ['X', -1]]);

  // internet caiu: reconecta sozinho com o MESMO login (sem QR)
  s.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await wait(2100);
  assert.equal(socks.length, 3);
  assert.equal(ev.disc.length, 0);
  assert.ok(fs.existsSync(path.join(dataPath, 'baileys-canal1', 'creds.json')));

  // o celular desconectou o aparelho: apaga o login, avisa (LOGOUT) e mostra QR novo
  s = socks.at(-1);
  s.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: R.loggedOut } } } });
  assert.deepEqual(ev.disc, ['LOGOUT']);
  assert.ok(!fs.existsSync(path.join(dataPath, 'baileys-canal1', 'creds.json')));
  await wait(1100);
  assert.equal(socks.length, 4);

  // desligar o CRM: fecha e não reconecta mais
  await c.destroy();
  socks.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await wait(50);
  assert.equal(socks.length, 4);
  assert.ok(socks.at(-1).ended);
});

test('mensagens embrulhadas (temporária, visualização única, documento com legenda) e áudio de voz', () => {
  assert.deepEqual(describe({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'oi' } } } } }).body, 'oi');
  const d = describe({ message: { documentWithCaptionMessage: { message: { documentMessage: { caption: 'tabela', mimetype: 'application/pdf', fileName: 't.pdf' } } } } });
  assert.deepEqual([d.type, d.body, d.media.fileName], ['document', 'tabela', 't.pdf']);
  assert.equal(describe({ message: { audioMessage: { ptt: true } } }).type, 'ptt');
  assert.equal(describe({ message: { reactionMessage: { text: '👍' } } }).type, 'protocol');
});
