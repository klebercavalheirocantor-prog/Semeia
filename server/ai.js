// Assistente de IA (Claude, da Anthropic) para responder as primeiras perguntas e entender a intenção do cliente.
// Chamada HTTP direta, sem dependência. Chave e base de conhecimento ficam em Ajustes > Assistente de IA.
import { getSetting, one } from './db.js';
import { httpError, brandKey } from './crm.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export async function claude({ system, messages, maxTokens = 600, brandId = 1 }) {
  const cfg = getSetting(brandKey('ai', brandId), {});
  if (!cfg.api_key) throw Object.assign(httpError(400, 'Configure a chave da Anthropic em Ajustes > Assistente de IA'), { fatal: true });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model || DEFAULT_MODEL, max_tokens: maxTokens, system, messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`IA: ${data.error?.message || res.status}`), { status: 502 });
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}

// O modelo responde só JSON; tolera texto em volta.
function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

function base(brandId = 1) {
  const cfg = getSetting(brandKey('ai', brandId), {});
  const company = one('select name from brands where id = ?', brandId)?.name || 'a empresa';
  return { cfg, company, persona: cfg.persona || `Você é o atendente virtual de ${company}, no WhatsApp.` };
}

// history: [{ direction: 'in'|'out', body }] em ordem cronológica
const toMessages = (history) => {
  const out = [];
  for (const m of history) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const text = String(m.body || '').trim() || '[mídia]';
    if (out.length && out.at(-1).role === role) out.at(-1).content += `\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift(); // a conversa precisa começar pelo cliente
  while (out.length && out.at(-1).role !== 'user') out.pop(); // e terminar nele
  return out;
};

// Responde a última pergunta do cliente usando só a base de conhecimento. Devolve { reply, handoff, reason }.
export async function aiReply(history, { contactName = '', brandId = 1 } = {}) {
  const { cfg, persona } = base(brandId);
  const system = `${persona}
Responda em português do Brasil, curto e simpático (no máximo 3 frases, estilo WhatsApp), chamando o cliente pelo primeiro nome quando souber${contactName ? ` (${contactName})` : ''}.
Use SOMENTE as informações da BASE DE CONHECIMENTO abaixo. Nunca invente preço, prazo, compatibilidade ou condição que não esteja nela.
Passe para um humano (handoff=true) quando: o cliente quer fechar/comprar/pagar, pede para falar com uma pessoa, a resposta não está na base, ou o assunto é reclamação.
Quando passar para humano, a resposta deve avisar com naturalidade que um especialista vai continuar o atendimento.
Responda APENAS com JSON: {"resposta": "texto para o cliente", "handoff": true|false, "motivo": "curto"}

BASE DE CONHECIMENTO:
${cfg.knowledge || '(vazia — sem informações: passe para humano)'}`;
  const msgs = toMessages(history.slice(-12));
  if (!msgs.length) return { reply: '', handoff: true, reason: 'sem mensagem do cliente' };
  const j = parseJson(await claude({ system, messages: msgs, brandId }));
  if (!j?.resposta) return { reply: '', handoff: true, reason: 'IA não respondeu no formato' };
  return { reply: String(j.resposta).trim(), handoff: !!j.handoff, reason: j.motivo || '' };
}

// Classifica a última mensagem numa das classes. Devolve o nome da classe ou 'outro'.
export async function aiClassify(text, classes, history = [], brandId = 1) {
  const { persona } = base(brandId);
  const list = classes.map((c) => `- ${c.name}: ${c.description || c.name}`).join('\n');
  const system = `${persona}
Classifique a INTENÇÃO da última mensagem do cliente em exatamente uma das classes:
${list}
- outro: nenhuma das anteriores
Responda APENAS com JSON: {"classe": "nome_da_classe"}`;
  const ctx = history.slice(-6).map((m) => `${m.direction === 'in' ? 'Cliente' : 'Empresa'}: ${m.body}`).join('\n');
  const j = parseJson(await claude({ system, messages: [{ role: 'user', content: `${ctx ? `Conversa:\n${ctx}\n\n` : ''}Última mensagem do cliente: ${text}` }], maxTokens: 60, brandId }));
  const name = String(j?.classe || '').trim();
  return classes.some((c) => c.name === name) ? name : 'outro';
}
