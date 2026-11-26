// Transcrição de áudio (Whisper na Groq, plano gratuito). O áudio que o cliente manda vira texto;
// se não for português, a IA (Claude) traduz para português e a tradução fica em messages.translated_body.
import fs from 'node:fs';
import path from 'node:path';
import { one, run, getSetting, uploadDir } from './db.js';
import { brandKey, httpError } from './crm.js';
import { emit } from './bus.js';
import { translateIn } from './ai.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const groqKey = (brandId) => getSetting(brandKey('ai', brandId), {}).groq_key || getSetting('ai', {}).groq_key || ''; // marca sem chave usa a da principal

// "audio/ogg; codecs=opus" -> "ogg" (a Groq descobre o formato pela extensão do nome)
const extOf = (mime) => ({ mpeg: 'mp3', 'x-m4a': 'm4a', mp4: 'm4a' })[String(mime).split('/')[1]?.split(';')[0].trim()] || String(mime).split('/')[1]?.split(';')[0].trim() || 'ogg';

export async function transcribeMessage(messageId) {
  const m = one(`select m.*, f.path file_path, f.mime file_mime, ch.brand_id from messages m join files f on f.id = m.file_id
    join conversations c on c.id = m.conversation_id join channels ch on ch.id = c.channel_id where m.id = ?`, messageId);
  if (!m) throw httpError(404, 'Áudio não encontrado (ainda baixando?)');
  if (m.transcript) return { transcript: m.transcript, translated: m.translated_body };
  const key = groqKey(m.brand_id);
  if (!key) throw httpError(400, 'Cole a chave da Groq em Ajustes › Assistente de IA para transcrever áudios');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path.join(uploadDir(), m.file_path))], { type: m.file_mime.split(';')[0] }), `audio.${extOf(m.file_mime)}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  const res = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Transcrição: ${d.error?.message || `erro ${res.status}`}`);
  const text = String(d.text || '').trim() || '(áudio sem fala)';
  let translated = null;
  const lang = String(d.language || '').toLowerCase();
  if (d.text && !/^(pt|portug)/.test(lang)) {
    try { const t = await translateIn(text, { brandId: m.brand_id }); if (t && t !== text) translated = t; } catch (e) { console.error('transcrição: tradução falhou', e.message); }
  }
  run('update messages set transcript = ?, translated_body = coalesce(?, translated_body) where id = ?', text, translated, m.id);
  emit('message', { conversation_id: m.conversation_id });
  return { transcript: text, translated };
}
