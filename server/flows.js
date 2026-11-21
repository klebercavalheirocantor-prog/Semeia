// Fluxos automáticos: o que o robô faz quando o cliente responde (pergunta, botões, IA, follow-up, passar para humano).
// O desenho (nós e ligações) vem do editor de arrastar; aqui fica o motor que anda por ele, uma conversa por vez.
import { one, all, run, now, getSetting, setSetting } from './db.js';
import { emit } from './bus.js';
import { sendMessage } from './meta.js';
import { fillVars } from './outbound.js';
import { aiReply, aiClassify } from './ai.js';
import { logEvent, httpError } from './crm.js';
import { saveFile } from './meta.js';
import { UPLOAD_DIR } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const H = 3600e3;
const ACTIVE = "('running','waiting_reply','waiting_time')";

// Saídas de cada tipo de nó (o editor desenha uma bolinha por saída).
export function portsOf(node) {
  const d = node?.data || {};
  switch (node?.type) {
    case 'start': case 'message': case 'wait': case 'stage': case 'tag': return ['next'];
    case 'question': return [...new Set((d.buttons || []).map((b) => String(b).trim()).filter(Boolean)), 'respondeu', 'sem resposta'];
    case 'ai_classify': return [...new Set((d.classes || []).map((c) => String(c.name || '').trim()).filter(Boolean)), 'outro'];
    case 'ai_reply': return ['humano', 'sem resposta'];
    case 'catalog': return ['enviou', 'nenhum'];
    default: return []; // handoff, end
  }
}

// Tabela por modelo: acha o modelo no texto do cliente sem se importar com espaço, hífen, acento ou maiúscula
// ("AG 25", "ag-25", "StarFire 6000", "sf6000"). Número só vale inteiro: "3000" não casa com "30000" nem com "13000".
const squash = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export function matchCatalog(items, text) {
  const t = squash(text);
  return (items || []).filter((it) => (it.keywords || []).some((k) => {
    const kw = squash(k);
    if (!kw) return false;
    for (let i = t.indexOf(kw); i >= 0; i = t.indexOf(kw, i + 1)) {
      const before = t[i - 1], after = t[i + kw.length];
      if (/\d/.test(kw[0]) && before && /\d/.test(before)) continue;
      if (/\d/.test(kw.at(-1)) && after && /\d/.test(after)) continue;
      return true;
    }
    return false;
  }));
}

export function validateGraph(g) {
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw httpError(400, 'Desenho do fluxo inválido');
  const starts = g.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) throw httpError(400, 'O fluxo precisa de exatamente um nó Início');
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const n of g.nodes) {
    const d = n.data || {};
    if ((n.type === 'message' || n.type === 'question') && !String(d.text || '').trim()) throw httpError(400, 'Há uma mensagem sem texto no fluxo');
    if ((d.buttons || []).length > 3) throw httpError(400, 'O WhatsApp aceita no máximo 3 botões por mensagem');
    if ((d.buttons || []).some((b) => String(b).length > 20)) throw httpError(400, 'Cada botão tem no máximo 20 letras');
    if (n.type === 'stage' && !d.stage_id) throw httpError(400, 'Escolha a etapa no nó "Mover etapa"');
    if (n.type === 'catalog' && (d.items || []).some((it) => !it.file_id || !(it.keywords || []).some((k) => String(k).trim()))) {
      throw httpError(400, 'Na "Tabela por modelo", cada linha precisa de pelo menos um modelo e da imagem da tabela');
    }
  }
  g.edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return g;
}

// ---------- o que cada nó faz. Devolve { port } (segue por essa saída), { wait } ou { state } (para).
async function execNode(node, io) {
  const d = node.data || {};
  switch (node.type) {
    case 'start': return { port: 'next' };
    case 'message':
      await io.send(d.text, d.buttons);
      return { port: 'next' };
    case 'question':
      await io.send(d.text, d.buttons);
      return { wait: 'reply', ms: (Number(d.timeout_hours) || 20) * H };
    case 'wait':
      return { wait: 'time', ms: Math.max(1, Number(d.amount) || 1) * (d.unit === 'min' ? 60e3 : d.unit === 'd' ? 24 * H : H) };
    case 'ai_classify': {
      const cls = await aiClassify(io.vars.last_reply || '', d.classes || [], await io.history(), io.brandId);
      io.vars.last_class = cls;
      return { port: cls };
    }
    case 'ai_reply': {
      const turns = (io.vars.ai_turns ||= {});
      const r = await aiReply(await io.history(), { contactName: io.firstName, brandId: io.brandId });
      if (r.reply) await io.send(r.reply);
      turns[node.id] = (turns[node.id] || 0) + 1;
      if (r.handoff) { io.vars.handoff_reason = r.reason || 'IA pediu ajuda'; return { port: 'humano' }; }
      if (turns[node.id] >= (Number(d.max_turns) || 5)) { io.vars.handoff_reason = 'limite de respostas da IA'; return { port: 'humano' }; }
      return { wait: 'reply', ms: (Number(d.timeout_hours) || 20) * H };
    }
    case 'catalog': {
      // Manda a(s) tabela(s) dos modelos citados; a frase vai junto da última imagem.
      const hits = matchCatalog(d.items, io.vars.last_reply);
      // Modelo não reconhecido (ex.: "Antena 392 trimble"): não manda tabela nenhuma (para não expor os outros preços);
      // avisa o cliente e um humano assume.
      if (!hits.length) {
        await io.send(d.fallback_text || 'Só um momento, irei verificar.');
        io.vars.handoff_reason = 'não reconheceu o modelo';
        return { port: 'nenhum' };
      }
      io.vars.models = hits.map((h) => h.name);
      for (const [i, h] of hits.entries()) await io.send(i === hits.length - 1 ? d.text : '', [], h.file_id);
      io.vars.handoff_reason = `recebeu a tabela de ${hits.map((h) => h.name).join(' e ')}`;
      return { port: 'enviou' };
    }
    case 'stage': io.setStage(Number(d.stage_id)); return { port: 'next' };
    case 'tag': io.addTag(d.tag); return { port: 'next' };
    case 'handoff':
      io.handoff(d.note || io.vars.handoff_reason || 'cliente quer falar com uma pessoa');
      return { state: 'handoff' };
    default: return { state: 'done' };
  }
}

// Saída escolhida quando o cliente responde a um nó que estava esperando.
function replyPort(node, text) {
  if (node.type === 'question') {
    const t = String(text || '').trim().toLowerCase();
    const btns = (node.data?.buttons || []).filter((b) => String(b).trim());
    // pelo WhatsApp Web os botões vão como lista numerada: "1" vale o primeiro
    const hit = btns.find((b) => String(b).trim().toLowerCase() === t) || (/^\d$/.test(t) ? btns[Number(t) - 1] : null);
    return { port: hit ? String(hit).trim() : 'respondeu' };
  }
  if (node.type === 'ai_reply') return null; // executa o nó de novo: a IA responde a nova mensagem
  return { port: 'respondeu' };
}

// Anda pelo desenho até precisar esperar ou acabar. st = { node_id, vars }; save(patch) grava o estado.
async function drive(graph, st, io, first, save) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let outcome = first;
  for (let i = 0; i < 40; i++) {
    const node = byId.get(st.node_id);
    if (!node) return save({ state: 'done' });
    if (!outcome) {
      try { outcome = await execNode(node, io); } catch (e) {
        io.handoff(`o robô parou: ${e.message}`);
        return save({ state: 'failed', error: e.message });
      }
    }
    if (outcome.port !== undefined) {
      const edge = graph.edges.find((e) => e.from === node.id && e.port === outcome.port);
      if (!edge) return save({ state: 'done' });
      st.node_id = edge.to;
      outcome = null;
      save({ state: 'running' });
      continue;
    }
    if (outcome.wait) return save({ state: outcome.wait === 'reply' ? 'waiting_reply' : 'waiting_time', wake_at: now() + outcome.ms });
    return save({ state: outcome.state });
  }
  io.handoff('o fluxo entrou em repetição');
  return save({ state: 'failed', error: 'O fluxo passou por 40 passos seguidos: verifique se há um laço' });
}

// ---------- execução de verdade (WhatsApp / Messenger / Instagram)
function realIO(conv, vars) {
  const contact = one('select * from contacts where id = ?', conv.contact_id);
  const channel = one('select * from channels where id = ?', conv.channel_id);
  const first = fillVars('{{primeiro_nome}}', contact);
  const leadOf = () => { const c = one('select lead_id from conversations where id = ?', conv.id); return c?.lead_id ? one('select * from leads where id = ? and deleted_at is null', c.lead_id) : null; };
  return {
    vars, firstName: first, brandId: channel.brand_id ?? 1,
    history: () => all('select direction, body from messages where conversation_id = ? order by created_at desc, id desc limit 14', conv.id).reverse(),
    async send(text, buttons = [], fileId = null) {
      text = fillVars(text || '', contact).trim();
      buttons = (buttons || []).map((b) => String(b).trim()).filter(Boolean).slice(0, 3);
      const f = fileId && one('select * from files where id = ?', fileId);
      if (fileId && !f) throw new Error('A imagem da tabela foi apagada: escolha de novo no fluxo');
      if (!text && !f) return;
      const c = one('select external_id, last_inbound_at, lead_id from conversations where id = ?', conv.id);
      if (channel.kind === 'whatsapp' && JSON.parse(channel.config).mode !== 'web' && (!c.last_inbound_at || now() - c.last_inbound_at > 24 * H)) {
        throw new Error('Fora da janela de 24 h do WhatsApp: o cliente não responde há mais de um dia');
      }
      const body = buttons.length ? `${text}\n\n[ ${buttons.join(' | ')} ]` : text;
      const mid = Number(run("insert into messages(conversation_id, direction, kind, body, file_id, status, bot, created_at) values(?, 'out', ?, ?, ?, 'pending', 1, ?)",
        conv.id, f ? 'image' : 'text', body, f?.id ?? null, now()).lastInsertRowid);
      run('update conversations set last_message_at = ? where id = ?', now(), conv.id);
      emit('message', { conversation_id: conv.id, lead_id: c.lead_id });
      try {
        const file = f && { buf: fs.readFileSync(path.join(UPLOAD_DIR, f.path)), name: f.name, mime: f.mime };
        const r = await sendMessage(channel, c.external_id, file ? { text, file } : { text, buttons });
        run("update messages set external_id = ?, status = case when status = 'pending' then 'sent' else status end where id = ?", r.id || null, mid);
      } catch (e) {
        run("update messages set status = 'failed', error = ? where id = ?", e.message, mid);
        throw e;
      } finally { emit('message', { conversation_id: conv.id, lead_id: c.lead_id }); }
    },
    setStage(stageId) {
      const lead = leadOf();
      const to = one('select * from stages where id = ?', stageId);
      if (!lead || !to || lead.stage_id === to.id) return;
      const from = one('select name from stages where id = ?', lead.stage_id);
      run('update leads set stage_id = ?, pipeline_id = ?, closed_at = ?, updated_at = ? where id = ?',
        to.id, to.pipeline_id, ['won', 'lost'].includes(to.kind) ? now() : null, now(), lead.id);
      logEvent('lead', lead.id, 'stage_changed', { from: from?.name, to: to.name, kind: to.kind, by: 'robô' });
      emit('lead', { id: lead.id });
    },
    addTag(name) {
      name = String(name || '').trim();
      if (!name) return;
      let t = one('select id from tags where name = ?', name);
      if (!t) t = { id: Number(run('insert into tags(name) values(?)', name).lastInsertRowid) };
      run('insert or ignore into entity_tags(entity, entity_id, tag_id) values(?, ?, ?)', 'contact', contact.id, t.id);
      emit('contact', { id: contact.id });
    },
    handoff(note) {
      const lead = leadOf();
      run('insert into tasks(entity, entity_id, text, due_at, responsible_id, created_at) values(?, ?, ?, ?, ?, ?)',
        lead ? 'lead' : 'contact', lead ? lead.id : contact.id, `Responder ${contact.name} no ${{ whatsapp: 'WhatsApp', email: 'e-mail' }[channel.kind] || 'chat'}: ${note}`,
        now(), lead?.responsible_id ?? conv.assigned_id ?? null, now());
      run('update conversations set unread = max(unread, 1) where id = ?', conv.id);
      if (lead) logEvent('lead', lead.id, 'bot_handoff', { note });
      emit('task', {});
      emit('message', { conversation_id: conv.id, lead_id: lead?.id });
    },
  };
}

function saver(runId, st) {
  return (patch) => {
    const fields = { node_id: st.node_id, vars: JSON.stringify(st.vars), updated_at: now(), wake_at: null, error: null, ...patch };
    run('update flow_runs set state = ?, node_id = ?, vars = ?, wake_at = ?, error = ?, updated_at = ? where id = ?',
      fields.state, fields.node_id, fields.vars, fields.wake_at, fields.error, fields.updated_at, runId);
    emit('flow', {});
  };
}

// Uma conversa por vez: mensagens que chegam juntas entram na fila daquela conversa.
const chains = new Map();
function serial(key, fn) {
  const p = (chains.get(key) || Promise.resolve()).then(fn).catch((e) => console.error('fluxo', e));
  chains.set(key, p);
  p.finally(() => { if (chains.get(key) === p) chains.delete(key); });
  return p;
}
export const idle = () => Promise.all([...chains.values()]);

const activeRun = (convId) => one(`select * from flow_runs where conversation_id = ? and state in ${ACTIVE}`, convId);
const loadFlow = (id) => { const f = one('select * from flows where id = ?', id); return f && { ...f, graph: JSON.parse(f.graph), trigger_config: JSON.parse(f.trigger_config) }; };

async function startRun(flow, conv, vars = {}) {
  const start = flow.graph.nodes.find((n) => n.type === 'start');
  if (!start) return null;
  let runId;
  try {
    runId = Number(run("insert into flow_runs(flow_id, conversation_id, node_id, state, vars, created_at, updated_at) values(?, ?, ?, 'running', ?, ?, ?)",
      flow.id, conv.id, start.id, JSON.stringify(vars), now(), now()).lastInsertRowid);
  } catch { return null; } // já há um fluxo rodando nesta conversa
  const st = { node_id: start.id, vars };
  await drive(flow.graph, st, realIO(conv, st.vars), null, saver(runId, st));
  return runId;
}

async function resume(r, first) {
  const flow = loadFlow(r.flow_id);
  const conv = one('select * from conversations where id = ?', r.conversation_id);
  if (!flow || !conv) return run("update flow_runs set state = 'stopped', error = 'fluxo ou conversa apagados' where id = ?", r.id);
  const st = { node_id: r.node_id, vars: JSON.parse(r.vars || '{}') };
  if (first?.reply !== undefined) st.vars.last_reply = first.reply;
  const io = realIO(conv, st.vars);
  const save = saver(r.id, st);
  if (first?.stop) { io.handoff(first.stop); return save({ state: 'handoff' }); }
  return drive(flow.graph, st, io, first?.outcome ?? null, save);
}

// ---------- gatilhos
// Resposta à campanha que não é conversa de verdade: mensagem automática do WhatsApp Business ("agradecemos seu contato,
// em breve retornaremos") ou só um "ok"/"obrigado"/👍. Aí o robô não pergunta nada e espera a próxima mensagem da pessoa.
const AUTO_REPLY = /mensagem autom[aá]tica|resposta autom[aá]tica|agradece(mos)? (o |pelo |pela |seu |sua )*(contato|mensagem)|obrigad[oa] por (entrar em |seu |sua |pelo |pela |nos )*(contato|mensagem)|em breve (retorna|responde|entra|daremos)|retornaremos|responderemos|no momento,? n[aã]o (podemos|estamos|consigo|posso)|hor[aá]rio de atendimento|fora do (nosso )?hor[aá]rio|estou ausente|ausente no momento|seja bem[- ]?vind[oa]|como (podemos|posso) (te |lhe )?ajudar|digite (o n[uú]mero|uma op|\d)|escolha uma (das )?op[cç]/i;
const ACK = /^(ok+|okay|okey|oki|blz|beleza|certo|ta|ta bom|obrigad[oa]|obg|brigad[oa]|grat[oa]|valeu|vlw|recebido|show|top|joia)( (ok+|obrigad[oa]|obg|blz|beleza|valeu|vlw|bom|certo))*$/;
export function notARealReply(text) {
  const t = String(text || '').trim();
  if (!t) return false; // foto ou áudio: pode ser a foto do monitor
  if (AUTO_REPLY.test(t)) return true;
  const n = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return !n || ACK.test(n); // só emoji (👍 🙏) ou só um "ok"
}

// Chamado depois de gravar a mensagem do cliente.
export function flowOnInbound({ conversationId, text, campaignId = null, newConversation = false, optout = false, fromAd = false }) {
  return serial(conversationId, async () => {
    const r = activeRun(conversationId);
    if (optout) {
      if (r) run("update flow_runs set state = 'stopped', error = 'cliente pediu para sair', wake_at = null, updated_at = ? where id = ?", now(), r.id);
      return;
    }
    if (r) {
      if (r.state === 'waiting_reply') {
        const flow = loadFlow(r.flow_id);
        const node = flow?.graph.nodes.find((n) => n.id === r.node_id);
        return resume(r, { reply: text, outcome: node ? replyPort(node, text) : { state: 'done' } });
      }
      if (r.state === 'waiting_time') return resume(r, { reply: text, stop: 'o cliente respondeu durante a espera do follow-up' });
      return; // ainda rodando: a IA vai ler esta mensagem no histórico
    }
    const conv = one("select c.*, ch.brand_id, ch.kind channel_kind from conversations c join channels ch on ch.id = c.channel_id where c.id = ? and c.status = 'open'", conversationId);
    if (!conv) return;
    // Só fluxos da empresa do canal; "channel" no gatilho limita a WhatsApp ou e-mail.
    // Quem chega pelo anúncio vai primeiro para o fluxo "veio do anúncio"; se não houver um ligado, segue a regra normal.
    const triggers = [fromAd && 'ad_click', campaignId ? 'campaign_reply' : newConversation ? 'new_conversation' : null].filter(Boolean);
    for (const trigger of triggers) {
      for (const { id } of all('select id from flows where active = 1 and trigger = ? and brand_id = ? order by id', trigger, conv.brand_id)) {
        const flow = loadFlow(id);
        if (trigger === 'campaign_reply' && flow.trigger_config.campaign_id && Number(flow.trigger_config.campaign_id) !== campaignId) continue;
        if (trigger === 'campaign_reply' && notARealReply(text)) break; // espera a pessoa escrever de verdade
        if (flow.trigger_config.channel && flow.trigger_config.channel !== conv.channel_kind) continue;
        return startRun(flow, conv, { last_reply: text, campaign_id: campaignId });
      }
    }
  });
}

// Lead mudou de etapa (por uma pessoa): inicia fluxos "quando entrar na etapa X".
export function flowOnStage(leadId, stageId) {
  const conv = one("select c.* from conversations c where c.lead_id = ? and c.status = 'open' order by c.last_message_at desc limit 1", leadId);
  if (!conv) return;
  return serial(conv.id, async () => {
    if (activeRun(conv.id)) return;
    const brand = one('select p.brand_id from leads l join pipelines p on p.id = l.pipeline_id where l.id = ?', leadId)?.brand_id ?? 1;
    for (const { id } of all("select id from flows where active = 1 and trigger = 'stage_changed' and brand_id = ? order by id", brand)) {
      const flow = loadFlow(id);
      if (Number(flow.trigger_config.stage_id) !== Number(stageId)) continue;
      return startRun(flow, conv, {});
    }
  });
}

// Uma pessoa respondeu pela caixa de entrada: o robô sai de cena.
export function flowOnHuman(conversationId) {
  run(`update flow_runs set state = 'stopped', error = 'atendente assumiu a conversa', wake_at = null, updated_at = ? where conversation_id = ? and state in ${ACTIVE}`, now(), conversationId);
  emit('flow', {});
}

let ticking = false;
export async function tickFlows(t = now()) {
  if (ticking) return;
  ticking = true;
  try {
    for (const r of all("select * from flow_runs where state in ('waiting_reply','waiting_time') and wake_at <= ? order by wake_at limit 50", t)) {
      await serial(r.conversation_id, async () => {
        const cur = one('select * from flow_runs where id = ?', r.id);
        if (cur.state !== r.state || cur.wake_at > t) return;
        return resume(cur, { outcome: { port: cur.state === 'waiting_time' ? 'next' : 'sem resposta' } });
      });
    }
  } finally { ticking = false; }
}

// ---------- simulador (o editor testa o fluxo sem mandar nada de verdade)
export async function simulate(graph, sim, action, brandId = 1) {
  graph = validateGraph(structuredClone(graph));
  const out = [];
  sim = sim ? structuredClone(sim) : { node_id: null, state: 'idle', vars: {}, history: [] };
  const name = 'João';
  const io = {
    vars: sim.vars, firstName: name, brandId,
    history: () => sim.history,
    async send(text, buttons = [], fileId = null) {
      text = String(text || '').replace(/\{\{\s*primeiro_nome\s*\}\}/gi, name).replace(/\{\{\s*nome\s*\}\}/gi, `${name} da Silva`).trim();
      if (!text && !fileId) return;
      buttons = (buttons || []).map((b) => String(b).trim()).filter(Boolean);
      sim.history.push({ direction: 'out', body: text || '[imagem]' });
      out.push(fileId ? { type: 'bot', text, buttons, image: fileId } : { type: 'bot', text, buttons });
    },
    setStage(id) { out.push({ type: 'info', text: `Lead vai para a etapa "${one('select name from stages where id = ?', id)?.name || '?'}"` }); },
    addTag(t) { if (t) out.push({ type: 'info', text: `Contato ganha a etiqueta "${t}"` }); },
    handoff(note) { out.push({ type: 'info', text: `Passa para um atendente (tarefa criada): ${note}` }); },
  };
  const save = (patch) => { sim.state = patch.state; sim.error = patch.error || null; if (patch.state === 'failed') out.push({ type: 'info', text: `Erro: ${patch.error}` }); };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (action.type === 'start') {
    sim = { node_id: graph.nodes.find((n) => n.type === 'start').id, state: 'running', vars: { last_reply: action.text || '' }, history: action.text ? [{ direction: 'in', body: action.text }] : [] };
    io.vars = sim.vars; io.history = () => sim.history;
    await drive(graph, sim, io, null, save);
  } else if (action.type === 'reply') {
    sim.history.push({ direction: 'in', body: action.text });
    sim.vars.last_reply = action.text;
    const node = byId.get(sim.node_id);
    if (sim.state === 'waiting_reply' && node) await drive(graph, sim, io, replyPort(node, action.text), save);
    else if (sim.state === 'waiting_time') { io.handoff('o cliente respondeu durante a espera do follow-up'); save({ state: 'handoff' }); }
    else out.push({ type: 'info', text: 'O fluxo já terminou; esta mensagem fica para o atendente.' });
  } else if (action.type === 'timeout') {
    if (sim.state === 'waiting_reply' || sim.state === 'waiting_time') {
      out.push({ type: 'info', text: sim.state === 'waiting_time' ? 'Tempo de espera passou' : 'Cliente não respondeu no prazo' });
      await drive(graph, sim, io, { port: sim.state === 'waiting_time' ? 'next' : 'sem resposta' }, save);
    }
  }
  return { sim, out };
}

// ---------- fluxo padrão e base de conhecimento iniciais
// Tabelas de preço (imagens em server/seed/precos) e os modelos que o cliente pode escrever para cada uma.
const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed', 'precos');
const PRICE_TABLES = [
  { name: 'Trimble 372 / AG-25', file: 'trimble-372-ag25.png', keywords: ['372', 'AG-25', 'AG25'] },
  { name: 'Trimble NAV 900 / 392', file: 'trimble-nav900.png', keywords: ['392', 'AG-392', 'AG392', 'NAV 900', 'NAV900', 'NAV-900'] },
  { name: 'Antena StarFire 7000 / 7500', file: 'starfire-7000-7500.png', keywords: ['7000', '7500'] },
  { name: 'Monitores GS4', file: 'monitores-gs4.png', keywords: ['4200', '4240', '4600', '4640', 'GS4', 'Gen 4', 'Gen4'] },
  { name: 'Antena StarFire 6000', file: 'starfire-6000.png', keywords: ['6000'] },
  { name: 'Antena StarFire 3000', file: 'starfire-3000.png', keywords: ['3000'] },
];
function seedPriceTables() {
  return PRICE_TABLES.map((t) => {
    const buf = fs.readFileSync(path.join(SEED_DIR, t.file));
    return { name: t.name, keywords: t.keywords, file_id: saveFile(buf, t.file, 'image/png') };
  });
}

export function defaultGraph(items) {
  return {
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 160, data: {} },
      { id: 'tag', type: 'tag', x: 300, y: 160, data: { tag: 'Respondeu campanha GPS' } },
      { id: 'q1', type: 'question', x: 560, y: 140, data: { text: 'Oii tudo bem? Qual modelo da sua antena e do seu monitor?', buttons: [], timeout_hours: 20 } },
      { id: 'cat', type: 'catalog', x: 860, y: 60, data: { text: 'Tenho esses planos, qual seria ideal para o senhor?', items } },
      { id: 'q2', type: 'question', x: 860, y: 330, data: { text: 'Se preferir, me manda uma foto do monitor que eu identifico o sinal certo pra você 📷', buttons: [], timeout_hours: 20 } },
      { id: 'hand', type: 'handoff', x: 1160, y: 20, data: { note: '' } },
      { id: 'hand2', type: 'handoff', x: 1160, y: 190, data: { note: 'respondeu, mas o robô não reconheceu o modelo: veja a mensagem' } },
      { id: 'end', type: 'end', x: 1160, y: 380, data: {} },
    ],
    edges: [
      { from: 'start', port: 'next', to: 'tag' },
      { from: 'tag', port: 'next', to: 'q1' },
      { from: 'q1', port: 'respondeu', to: 'cat' },
      { from: 'q1', port: 'sem resposta', to: 'q2' },
      { from: 'q2', port: 'respondeu', to: 'cat' },
      { from: 'q2', port: 'sem resposta', to: 'end' },
      { from: 'cat', port: 'enviou', to: 'hand' },
      { from: 'cat', port: 'nenhum', to: 'hand2' },
    ],
  };
}

// Resposta por e-mail: a campanha já pediu o modelo, então o robô procura o modelo direto na resposta.
export function emailGraph(items) {
  return {
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 160, data: {} },
      { id: 'tag', type: 'tag', x: 300, y: 160, data: { tag: 'Respondeu e-mail GPS' } },
      { id: 'cat', type: 'catalog', x: 560, y: 120, data: { text: 'Tenho esses planos, qual seria ideal para o senhor?', items } },
      { id: 'hand', type: 'handoff', x: 860, y: 40, data: { note: '' } },
      { id: 'hand2', type: 'handoff', x: 860, y: 230, data: { note: 'respondeu o e-mail, mas o robô não reconheceu o modelo: veja a mensagem' } },
    ],
    edges: [
      { from: 'start', port: 'next', to: 'tag' }, { from: 'tag', port: 'next', to: 'cat' },
      { from: 'cat', port: 'enviou', to: 'hand' }, { from: 'cat', port: 'nenhum', to: 'hand2' },
    ],
  };
}

const OLD_NAME = 'Resposta à campanha: sinais GPS';
export function initFlows() {
  run("update flow_runs set state = 'failed', error = 'servidor reiniciado no meio do passo' where state = 'running'");
  if (!getSetting('ai')) setSetting('ai', { model: 'claude-haiku-5-5', persona: '', knowledge: DEFAULT_KNOWLEDGE });
  if (getSetting('flows_seed', 0) < 2) seedV2();
  seedEmailFlow();
  seedAdFlow();
}
function seedV2() {
  const graph = JSON.stringify(defaultGraph(seedPriceTables()));
  const old = one('select * from flows where name = ?', OLD_NAME);
  if (old && !old.active && old.updated_at === old.created_at) {
    run('update flows set graph = ? where id = ?', graph, old.id); // versão 1 nunca mexida: troca a IA pela tabela de preços
  } else {
    run("insert into flows(name, trigger, trigger_config, active, graph, created_at, updated_at) values(?, 'campaign_reply', '{}', 0, ?, ?, ?)",
      old ? 'Resposta à campanha: tabela de preços' : OLD_NAME, graph, now(), now());
  }
  setSetting('flows_seed', 2);
}

// v3: o fluxo do WhatsApp fica só para WhatsApp e nasce o de e-mail (mesmas tabelas, sem a pergunta).
function seedEmailFlow() {
  if (getSetting('flows_seed_email', 0) >= 1) return;
  run("update flows set trigger_config = json_set(trigger_config, '$.channel', 'whatsapp') where name like 'Resposta à campanha%' and json_extract(trigger_config, '$.channel') is null");
  const wa = one("select graph from flows where name like 'Resposta à campanha%' and brand_id = 1 order by id limit 1");
  const items = wa && JSON.parse(wa.graph).nodes.find((n) => n.type === 'catalog')?.data.items;
  run("insert into flows(name, trigger, trigger_config, active, graph, created_at, updated_at, brand_id) values(?, 'campaign_reply', ?, 0, ?, ?, ?, 1)",
    'Resposta ao e-mail: tabela de preços', JSON.stringify({ channel: 'email' }), JSON.stringify(emailGraph(items || seedPriceTables())), now(), now());
  setSetting('flows_seed_email', 1);
}

// v4: fluxo para quem chega pelo anúncio do Facebook/Instagram (mesma tabela de preços do WhatsApp), nasce desligado.
export const AD_FLOW = 'Veio do anúncio: tabela de preços';
function seedAdFlow() {
  if (getSetting('flows_seed_ad', 0) >= 1) return;
  const wa = one("select graph from flows where name like 'Resposta à campanha%' and brand_id = 1 order by id limit 1");
  const graph = wa ? JSON.parse(wa.graph) : defaultGraph(seedPriceTables());
  for (const n of graph.nodes) if (n.type === 'tag') n.data.tag = 'Veio do anúncio';
  run("insert into flows(name, trigger, trigger_config, active, graph, created_at, updated_at, brand_id) values(?, 'ad_click', ?, 0, ?, ?, ?, 1)",
    AD_FLOW, JSON.stringify({ channel: 'whatsapp' }), JSON.stringify(graph), now(), now());
  setSetting('flows_seed_ad', 1);
}

const DEFAULT_KNOWLEDGE = `Empresa: AgroVox (site www.agro-vox.com, Instagram @agrovoxtech).
O que vendemos: sinal de correção para piloto automático / GPS agrícola, com ativação via código (sem precisar levar o equipamento).
Sinais John Deere: SF2, SF3, SF-RTK e ativação SF3 Ready.
Sinais Trimble: CenterPoint RTX e RangePoint RTX.
Desconto: até 50% (o desconto varia por sinal).
Precisão: até 2,5 cm (depende do sinal).
Pagamento: cartão, com prazo.
Suporte de quem é do campo.
Para passar o valor certo precisamos do modelo da antena (ex.: StarFire 6000, 7000) e do monitor (ex.: 4600, 4640, G5) — ou uma foto do monitor.

PREÇOS: (preencha aqui a tabela de valores por sinal e prazo. Enquanto estiver vazio, a IA passa para um atendente quando o cliente pedir valor.)`;
