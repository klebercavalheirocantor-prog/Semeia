// Assistente de IA (Claude, da Anthropic) para responder as primeiras perguntas e entender a intenção do cliente.
// Chamada HTTP direta, sem dependência. Chave e base de conhecimento ficam em Ajustes > Assistente de IA.
import { getSetting, one } from './db.js';
import { httpError, brandKey } from './crm.js';
import { perfil } from './perfil.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

// A chave da Anthropic é da empresa: marca sem chave própria usa a da marca principal.
const aiCfg = (brandId) => { const c = getSetting(brandKey('ai', brandId), {}); return c.api_key ? c : { ...c, api_key: getSetting('ai', {}).api_key }; };
export async function claude({ system, messages, maxTokens = 600, brandId = 1 }) {
  const cfg = aiCfg(brandId);
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

// Chamada com ferramentas (assistente do CRM): devolve a resposta inteira (texto + pedidos de ferramenta).
export async function claudeRaw({ system, messages, tools, maxTokens = 1000, brandId = 1 }) {
  const cfg = aiCfg(brandId);
  if (!cfg.api_key) throw httpError(400, 'Para usar o assistente, cadastre a chave da Anthropic em Ajustes › Assistente de IA');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model || DEFAULT_MODEL, max_tokens: maxTokens, system, messages, tools }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`IA: ${data.error?.message || res.status}`), { status: 502 });
  return data;
}

// O modelo responde só JSON; tolera texto em volta.
// Quebra de linha ou tab "crus" dentro de um texto entre aspas deixam o JSON inválido: troca por \n / espaço
function fixStrings(t) {
  let out = '', str = false, esc = false;
  for (const c of t) {
    if (str) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false;
      else if (c === '\n') { out += '\\n'; continue; } else if (c === '\r') continue; else if (c === '\t') { out += ' '; continue; }
    } else if (c === '"') str = true;
    out += c;
  }
  return out;
}
function parseJson(text) {
  const t = fixStrings(String(text));
  const m = t.match(/\{[\s\S]*\}/);
  try { if (m) return JSON.parse(m[0]); } catch { /* tenta pedaço por pedaço abaixo */ }
  // Às vezes vem mais de um objeto ou texto com chaves depois: pega o primeiro objeto completo que dá para ler
  for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
    let depth = 0, str = false, esc = false;
    for (let k = i; k < t.length; k++) {
      const c = t[k];
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(t.slice(i, k + 1)); } catch { break; } }
    }
  }
  // Último recurso (aspas sem escape no meio do texto, JSON cortado): pega os campos um por um
  const r = t.match(/"resposta"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"(?:tabelas|acao|motivo)"|\}\s*$)/) || t.match(/"resposta"\s*:\s*"([\s\S]*?)"?\s*$/);
  if (!r) return null;
  const acao = t.match(/"acao"\s*:\s*"(\w+)"/);
  return { resposta: r[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim(), tabelas: [], acao: acao ? acao[1] : 'continuar' };
}

function base(brandId = 1) {
  const cfg = getSetting(brandKey('ai', brandId), {});
  const company = one('select name from brands where id = ?', brandId)?.name || 'a empresa';
  return { cfg, company, persona: cfg.persona || `Você é o atendente virtual de ${company}, no WhatsApp.` };
}

// history: [{ direction: 'in'|'out', body }] em ordem cronológica
// asJson: nossas mensagens anteriores entram como {"resposta": ...}, para a IA continuar respondendo em JSON
const toMessages = (history, asJson = false) => {
  const out = [];
  for (const m of history) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    let text = String(m.body || '').trim() || '[mídia]';
    if (asJson && role === 'assistant') text = JSON.stringify({ resposta: text, tabelas: [], acao: 'continuar', motivo: '' });
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

// Atendente da campanha: entende a resposta, conversa e escolhe qual TABELA (imagem) mandar. Nunca digita preço.
// items: [{ name, keywords }]; sent: nomes das tabelas já mandadas. Devolve { reply, tables, action, reason }.
export async function aiAgent(history, { items = [], contactName = '', brandId = 1, sent = [] } = {}) {
  const { cfg, persona } = base(brandId);
  const ag = perfil(brandId).agente;
  const tables = items.map((it) => `- ${it.name}${(it.keywords || []).length ? ` (o cliente pode escrever: ${it.keywords.join(', ')})` : ''}`).join('\n');
  const system = `${persona}
${ag.contexto}
${ag.objetivo}
Responda no idioma em que o cliente escreveu (português, espanhol ou inglês; na dúvida, português do Brasil), como uma pessoa no WhatsApp: curto (no máximo 2 frases), simpático, sem parecer robô${contactName ? `; chame pelo primeiro nome (${contactName}) só quando soar natural` : ''}.
Regras:
- NUNCA escreva preço, valor, desconto exato, prazo ou condição que não esteja na base de conhecimento. O preço está nas tabelas (imagens): você só escolhe qual mandar.
- ${ag.escolha} Com tabela, "resposta" vira a legenda da imagem (ex.: "${ag.exemploLegenda}").
- ${ag.semModelo}
- Disse que passou para outra pessoa (gerente, filho, sócio, operador): agradeça e peça o nome e o WhatsApp dessa pessoa para falar direto.
- ${ag.semInteresse}: agradeça com educação e use acao "encerrar".
- Mandou foto, áudio ou vídeo ([mídia]), quer fechar/comprar/pagar, pediu para falar com alguém, reclamou, ou o modelo não bate com nenhuma tabela: diga que vai verificar e já retorna, e use acao "humano".
- Mensagem automática (atendimento automático da empresa dele) ou só "ok"/"obrigado": resposta "" e acao "continuar".
- Não repita uma pergunta com as mesmas palavras de antes.${sent.length ? `\n- Tabelas que você JÁ mandou nesta conversa (não mande de novo): ${sent.join(', ')}.` : ''}

TABELAS DISPONÍVEIS (use o nome exato):
${tables || '(nenhuma)'}

BASE DE CONHECIMENTO:
${cfg.knowledge || '(vazia)'}

Responda APENAS com JSON: {"resposta": "texto ou vazio", "tabelas": ["nome exato"], "acao": "continuar" | "humano" | "encerrar", "motivo": "curto"}`;
  const msgs = toMessages(history.slice(-14), true);
  if (!msgs.length) return { reply: '', tables: [], action: 'continuar', reason: '' };
  let raw = await claude({ system, messages: msgs, maxTokens: 700, brandId });
  let j = parseJson(raw);
  if (!j) { // tenta mais uma vez antes de passar para um atendente
    console.warn('IA fora do formato:', raw.slice(0, 300));
    raw = await claude({ system: `${system}\nIMPORTANTE: sua saída inteira deve ser um único objeto JSON válido, sem nenhum texto fora dele.`, messages: msgs, maxTokens: 700, brandId });
    j = parseJson(raw);
  }
  // Veio só o texto da resposta, sem JSON: usa o texto (curto e sem chaves) em vez de largar o cliente sem resposta
  if (!j && raw && !/[{<]/.test(raw) && raw.length <= 500) j = { resposta: raw, acao: 'continuar' };
  if (!j) return { reply: '', tables: [], action: 'humano', reason: `IA não respondeu no formato: ${String(raw || '(vazio)').slice(-200)}` };
  const names = new Set(items.map((it) => it.name));
  return {
    reply: String(j.resposta || '').trim(),
    tables: (Array.isArray(j.tabelas) ? j.tabelas : []).map(String).filter((n) => names.has(n)),
    action: ['humano', 'encerrar'].includes(j.acao) ? j.acao : 'continuar',
    reason: String(j.motivo || ''),
  };
}

// Traduz para português o que o cliente escreveu (espanhol, inglês...), quando o atendente clica em "Traduzir".
const modelos = (b) => (perfil(b).exemplosModelos ? ` (ex.: ${perfil(b).exemplosModelos})` : '');
export async function translateIn(text, { brandId = 1 } = {}) {
  const system = `Você traduz para o português do Brasil mensagens de WhatsApp que clientes de uma empresa${perfil(brandId).ramo ? ` ${perfil(brandId).ramo}` : ''} escreveram (geralmente em espanhol ou em inglês).
Mantenha o sentido, o tom, os emojis, números, valores, nomes de produtos e modelos${modelos(brandId)} e as quebras de linha.
Se o texto já estiver em português, devolva igual.
Responda APENAS com a tradução, sem aspas, sem explicação.`;
  const out = await claude({ system, messages: [{ role: 'user', content: text }], maxTokens: 1000, brandId });
  return out.replace(/^["“]|["”]$/g, '').trim() || text;
}

// Traduz o que o atendente escreveu (em português) para a língua do cliente, antes de mandar.
// customer: últimas mensagens do cliente (se ele escreve em português, o texto vai como está).
export async function translateOut(text, { to = 'es', customer = [], brandId = 1 } = {}) {
  const lang = { es: 'espanhol', en: 'inglês' }[to] || to;
  const system = `Você traduz mensagens de WhatsApp que um vendedor brasileiro escreveu em português para o cliente dele.
Traduza para ${lang}${to === 'es' ? ' natural, como se fala no Paraguai e na Argentina, tratando o cliente por "usted"' : ''}.
Mantenha o tom, os emojis, números, valores, nomes de produtos e modelos${modelos(brandId)} e as quebras de linha.
Se as últimas mensagens do cliente estiverem em português, devolva o texto original sem mudar nada.
Se o texto já estiver em ${lang}, devolva igual.
Responda APENAS com o texto final, sem aspas, sem explicação.

Últimas mensagens do cliente:
${customer.filter(Boolean).slice(-3).map((t) => `- ${String(t).slice(0, 300)}`).join('\n') || '(nenhuma ainda)'}`;
  const out = await claude({ system, messages: [{ role: 'user', content: text }], maxTokens: 1000, brandId });
  return out.replace(/^["“]|["”]$/g, '').trim() || text;
}
