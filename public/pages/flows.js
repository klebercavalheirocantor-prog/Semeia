// Fluxos automáticos: editor de arrastar (nós + ligações), simulador e fila de execuções.
import { html, useState, useEffect, useRef, api, post, patch, del, fail, toast, B, go, ago, fmtDateTime, useData, Confirm, Skeleton, ErrorBox, Empty } from '../lib.js';

const TYPES = {
  start: { label: 'Início', icon: '▶', tone: 'green' },
  message: { label: 'Mensagem', icon: '💬', tone: 'blue', hint: 'Envia um texto (com botões, se quiser) e segue' },
  question: { label: 'Pergunta', icon: '❓', tone: 'blue', hint: 'Envia e espera a resposta do cliente' },
  catalog: { label: 'Tabela por modelo', icon: '📋', tone: 'blue', hint: 'Acha o modelo na resposta e manda a tabela de preço dele' },
  wait: { label: 'Esperar', icon: '⏱', tone: 'gray', hint: 'Dá um tempo antes do próximo passo' },
  ai_agent: { label: 'Atendente IA com tabelas', icon: '🤖', tone: 'purple', hint: 'Entende a resposta, conversa e manda a tabela certa quando descobre o modelo (nunca digita preço)' },
  ai_reply: { label: 'IA responde', icon: '✨', tone: 'purple', hint: 'Responde dúvidas com a base de conhecimento' },
  ai_classify: { label: 'IA entende a intenção', icon: '🧭', tone: 'purple', hint: 'Escolhe um caminho pelo que o cliente quer' },
  stage: { label: 'Mover etapa', icon: '➜', tone: 'orange', hint: 'Move o lead no funil' },
  tag: { label: 'Etiqueta', icon: '🏷', tone: 'orange', hint: 'Marca o contato' },
  handoff: { label: 'Passar para humano', icon: '🙋', tone: 'red', hint: 'Cria tarefa e o robô para' },
  end: { label: 'Fim', icon: '■', tone: 'gray', hint: 'Encerra sem avisar ninguém' },
};
const TRIGGERS = { campaign_reply: 'Quando responder uma campanha', new_conversation: 'Quando alguém escrever pela primeira vez', stage_changed: 'Quando o lead entrar numa etapa', ad_click: 'Quando chegar pelo anúncio (Facebook/Instagram)' };
const STATES = { running: ['Rodando', 'ok'], waiting_reply: ['Esperando resposta', 'ok'], waiting_time: ['Esperando tempo', 'ok'], done: ['Concluído', 'done'], handoff: ['Com atendente', 'warn'], failed: ['Falhou', 'bad'], stopped: ['Parado', ''] };
const W = 230, HEAD = 34, BODY = 48, PORT = 26;

// Mesmas regras de server/flows.js
function portsOf(n) {
  const d = n.data || {};
  switch (n.type) {
    case 'start': case 'message': case 'wait': case 'stage': case 'tag': return ['next'];
    case 'question': return [...new Set((d.buttons || []).map((b) => String(b).trim()).filter(Boolean)), 'respondeu', 'sem resposta'];
    case 'ai_classify': return [...new Set((d.classes || []).map((c) => String(c.name || '').trim()).filter(Boolean)), 'outro'];
    case 'ai_reply': return ['humano', 'sem resposta'];
    case 'catalog': return ['enviou', 'nenhum'];
    case 'ai_agent': return ['enviou', 'humano', 'encerrou', 'sem resposta'];
    default: return [];
  }
}
const portLabel = (n, p) => (p === 'next' ? 'depois' : p === 'enviou' ? 'mandou a tabela' : p === 'nenhum' ? 'não achou o modelo' : p === 'respondeu' && (n.data?.buttons || []).some(Boolean) ? 'outra resposta' : p === 'humano' ? 'passar p/ humano' : p === 'encerrou' ? 'sem interesse' : p);
const height = (n) => HEAD + BODY + portsOf(n).length * PORT + 6;
const portY = (n, i) => n.y + HEAD + BODY + i * PORT + PORT / 2;
const stageName = (id) => { for (const p of B().pipelines) { const s = p.stages.find((x) => x.id === Number(id)); if (s) return `${p.name} › ${s.name}`; } return null; };
const unitLabel = { min: 'minuto(s)', h: 'hora(s)', d: 'dia(s)' };

function summary(n) {
  const d = n.data || {};
  switch (n.type) {
    case 'start': return 'O fluxo começa aqui';
    case 'message': case 'question': return d.text || 'Escreva a mensagem…';
    case 'wait': return `Espera ${d.amount || 1} ${unitLabel[d.unit || 'h']}`;
    case 'ai_reply': return `Responde até ${d.max_turns || 5} vezes com a base de conhecimento`;
    case 'ai_agent': return `${(d.items || []).length} tabela(s) · até ${d.max_turns || 6} respostas`;
    case 'ai_classify': return (d.classes || []).map((c) => c.name).filter(Boolean).join(' · ') || 'Defina as intenções';
    case 'catalog': return (d.items || []).map((i) => i.name).filter(Boolean).join(' · ') || 'Cadastre os modelos e as tabelas';
    case 'stage': return stageName(d.stage_id) || 'Escolha a etapa';
    case 'tag': return d.tag ? `Etiqueta "${d.tag}"` : 'Escolha a etiqueta';
    case 'handoff': return d.note || 'Cria tarefa para o responsável e o robô para';
    default: return 'Encerra o fluxo';
  }
}

const DEFAULTS = {
  message: { text: '', buttons: [] },
  question: { text: '', buttons: [], timeout_hours: 20 },
  wait: { amount: 1, unit: 'h' },
  ai_reply: { max_turns: 4, timeout_hours: 20 },
  ai_agent: { max_turns: 6, timeout_hours: 1, items: [] },
  ai_classify: { classes: [{ name: 'quer_comprar', description: 'quer preço, orçamento ou fechar negócio' }, { name: 'duvida', description: 'tem uma pergunta sobre o produto' }, { name: 'sem_interesse', description: 'não quer, já tem ou pediu para não mandar' }] },
  catalog: { text: 'Tenho esses planos, qual seria ideal para o senhor?', items: [] },
  stage: { stage_id: '' }, tag: { tag: '' }, handoff: { note: '' }, end: {},
};

// ---------- lista
export function FlowsPage() {
  const { data, error, reload } = useData(() => api('/flows'), [], ['flow']);
  if (!B().user.is_admin) return html`<div class="main"><${Empty} title="Só administradores editam fluxos" /></div>`;
  const create = () => post('/flows', { name: 'Novo fluxo' }).then((r) => go(`#/flow/${r.id}`)).catch(fail);
  const n = (r, ...k) => k.reduce((a, x) => a + (r[x] || 0), 0);
  return html`<div class="main">
    <div class="topbar"><div class="grow"><h1>Fluxos</h1><div class="xs muted">O que o robô faz quando o cliente responde: pergunta, botões, IA, follow-up e a passagem para um atendente</div></div>
      <button class="btn primary" onClick=${create}>+ Novo fluxo</button></div>
    <div class="page" style="padding:0">
      ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
      ${!data && !error && html`<div class="page"><${Skeleton} /></div>`}
      ${data && !data.length && html`<${Empty} title="Nenhum fluxo ainda"><button class="btn primary" onClick=${create}>Criar o primeiro</button><//>`}
      ${data?.length > 0 && html`<table class="t"><thead><tr><th>Fluxo</th><th>Gatilho</th><th>Situação</th><th>Em andamento</th><th>Com atendente</th><th class="hide-sm">Concluídos</th></tr></thead>
        <tbody>${data.map((f) => html`<tr><td><a href=${`#/flow/${f.id}`}>${f.name}</a><div class="xs muted">${ago(f.updated_at)}</div></td>
          <td class="small">${TRIGGERS[f.trigger]}</td>
          <td>${f.active ? html`<span class="pill st-ok">Ligado</span>` : html`<span class="pill">Desligado</span>`}</td>
          <td>${n(f.runs, 'running', 'waiting_reply', 'waiting_time')}</td><td>${n(f.runs, 'handoff', 'failed')}</td><td class="hide-sm">${n(f.runs, 'done')}</td></tr>`)}</tbody></table>`}
    </div></div>`;
}

// ---------- editor
export function FlowPage({ id }) {
  const { data: f0, error, reload } = useData(() => api(`/flows/${id}`), [id], ['flow']);
  const [f, setF] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('draw');
  const [sel, setSel] = useState(null); // { node } | { edge: index }
  const [sim, setSim] = useState(null); // estado do simulador aberto
  const [ask, setAsk] = useState(null);
  const [camps, setCamps] = useState([]);
  useEffect(() => { if (f0 && (!f || !dirty)) setF({ name: f0.name, trigger: f0.trigger, trigger_config: f0.trigger_config || {}, active: f0.active, graph: f0.graph }); }, [f0]);
  useEffect(() => { api('/campaigns').then(setCamps).catch(() => {}); }, []);
  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);
  if (error) return html`<div class="main"><${ErrorBox} error=${error} retry=${reload} /></div>`;
  if (!f) return html`<div class="main"><div class="page"><${Skeleton} rows=${5} /></div></div>`;

  const up = (patch_) => { setF((x) => ({ ...x, ...patch_ })); setDirty(true); };
  const setGraph = (fn) => { setF((x) => ({ ...x, graph: fn(x.graph) })); setDirty(true); };
  const clean = (g) => ({ ...g, edges: g.edges.filter((e) => { const n = g.nodes.find((x) => x.id === e.from); return n && g.nodes.some((x) => x.id === e.to) && portsOf(n).includes(e.port); }) });
  const save = async (extra = {}) => {
    try {
      const body = { ...f, ...extra, graph: clean(f.graph) };
      await patch(`/flows/${id}`, body);
      setF(body); setDirty(false);
      toast(extra.active === true ? 'Fluxo ligado' : extra.active === false ? 'Fluxo desligado' : 'Fluxo salvo');
      reload();
    } catch (e) { fail(e); }
  };
  const node = sel?.node && f.graph.nodes.find((n) => n.id === sel.node);
  const stages = B().pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, name: `${p.name} › ${s.name}` })));
  return html`<div class="main">
    <div class="topbar fl-top"><a href="#/flows" class="small">← Fluxos</a>
      <input class="fl-name" aria-label="Nome do fluxo" value=${f.name} onInput=${(e) => up({ name: e.target.value })} />
      <select aria-label="Gatilho" value=${f.trigger} onChange=${(e) => up({ trigger: e.target.value, trigger_config: {} })}>${Object.entries(TRIGGERS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select>
      ${f.trigger === 'campaign_reply' && html`<select aria-label="Qual campanha" value=${String(f.trigger_config.campaign_id || '')} onChange=${(e) => up({ trigger_config: { campaign_id: e.target.value ? Number(e.target.value) : null } })}>
        <option value="">Qualquer campanha</option>${camps.map((c) => html`<option value=${String(c.id)}>${c.name}</option>`)}</select>`}
      ${f.trigger === 'stage_changed' && html`<select aria-label="Qual etapa" value=${String(f.trigger_config.stage_id || '')} onChange=${(e) => up({ trigger_config: { stage_id: Number(e.target.value) || null } })}>
        <option value="">— etapa —</option>${stages.map((s) => html`<option value=${String(s.id)}>${s.name}</option>`)}</select>`}
      <span class="grow"></span>
      <label class=${`switch ${f.active ? 'on' : ''}`} title="Ligado: roda com clientes de verdade"><input type="checkbox" checked=${f.active} onChange=${(e) => save({ active: e.target.checked })} />${f.active ? 'Ligado' : 'Desligado'}</label>
      <button class="btn" onClick=${() => { setSim({ state: null, out: [] }); setSel(null); }}>Simular</button>
      <button class="btn primary" disabled=${!dirty} onClick=${() => save()}>${dirty ? 'Salvar' : 'Salvo'}</button>
      ${!f.active && html`<button class="btn danger" title="Apagar fluxo" onClick=${() => setAsk('del')}>Apagar</button>`}
    </div>
    <div class="tabs fl-tabs" role="tablist">
      <button role="tab" aria-selected=${tab === 'draw'} class=${tab === 'draw' ? 'on' : ''} onClick=${() => setTab('draw')}>Desenho</button>
      <button role="tab" aria-selected=${tab === 'runs'} class=${tab === 'runs' ? 'on' : ''} onClick=${() => setTab('runs')}>Execuções (${f0.recent.length})</button>
    </div>
    ${tab === 'draw' ? html`<div class="fl-wrap">
      <${Palette} onAdd=${(type, at) => {
        const nid = `${type}_${Math.random().toString(36).slice(2, 7)}`;
        setGraph((g) => ({ ...g, nodes: [...g.nodes, { id: nid, type, x: at.x, y: at.y, data: structuredClone(DEFAULTS[type] || {}) }] }));
        setSel({ node: nid });
      }} />
      <${Canvas} graph=${f.graph} setGraph=${setGraph} sel=${sel} setSel=${setSel} current=${sim?.state?.node_id} />
      <aside class="fl-side">
        ${sim ? html`<${Simulator} graph=${clean(f.graph)} sim=${sim} setSim=${setSim} />`
          : node ? html`<${NodeEditor} key=${node.id} node=${node} stages=${stages}
              onChange=${(data) => setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === node.id ? { ...n, data } : n)) }))}
              onDelete=${() => { setGraph((g) => ({ nodes: g.nodes.filter((n) => n.id !== node.id), edges: g.edges.filter((e) => e.from !== node.id && e.to !== node.id) })); setSel(null); }} />`
          : sel?.edge !== undefined ? html`<div class="pad col"><h3>Ligação</h3><button class="btn danger" onClick=${() => { setGraph((g) => ({ ...g, edges: g.edges.filter((_, i) => i !== sel.edge) })); setSel(null); }}>Remover ligação</button></div>`
          : html`<${Help} />`}
      </aside>
    </div>` : html`<${Runs} flow=${f0} reload=${reload} />`}
    ${ask === 'del' && html`<${Confirm} title="Apagar fluxo?" text="As execuções deste fluxo também somem. Não dá para desfazer." danger okLabel="Apagar"
      onOk=${() => del(`/flows/${id}`).then(() => go('#/flows')).catch(fail)} onClose=${() => setAsk(null)} />`}
  </div>`;
}

function Help() {
  return html`<div class="pad col small" style="gap:10px"><h3>Como montar</h3>
    <p>Arraste os blocos pelo título. Para ligar, puxe a bolinha da direita de uma saída até o bloco seguinte.</p>
    <p>Para mover a tela, arraste o fundo. Zoom: dois dedos no celular, Ctrl + rodinha no computador, ou os botões − + e "Ajustar".</p>
    <p>Clique num bloco para editar o texto, os botões ou o tempo. Clique numa linha para removê-la. A tecla Delete apaga o que estiver selecionado.</p>
    <p><strong>Pergunta</strong> espera o cliente: cada botão vira uma saída, e há saída para "outra resposta" e "sem resposta" (prazo).</p>
    <p><strong>IA responde</strong> usa a base de Ajustes › Assistente de IA e passa para humano quando o cliente quer fechar ou pergunta algo que não está lá.</p>
    <p>Se um atendente responder pela caixa de entrada, o robô para naquela conversa.</p>
    <p class="muted xs">Use "Simular" para testar sem mandar nada. Depois de salvar, ligue o fluxo no botão Ligado/Desligado.</p></div>`;
}

function Palette({ onAdd }) {
  const add = (type) => {
    const c = document.querySelector('.fl-canvas');
    const z = Number(c?.dataset.zoom) || 1;
    onAdd(type, { x: Math.max(0, Math.round((((c?.scrollLeft || 0) + (c?.clientWidth || 600) / 2) / z - W / 2) / 10) * 10), y: Math.round(((c?.scrollTop || 0) / z + 80 + Math.random() * 120) / 10) * 10 });
  };
  return html`<nav class="fl-palette" aria-label="Blocos"><div class="xs muted">Adicionar bloco</div>
    ${Object.entries(TYPES).filter(([t]) => t !== 'start').map(([t, v]) => html`<button class=${`fl-pal tone-${v.tone}`} title=${v.hint} onClick=${() => add(t)}><span aria-hidden="true">${v.icon}</span>${v.label}</button>`)}</nav>`;
}

const ZMIN = 0.3, ZMAX = 2;
const clampZ = (z) => Math.min(ZMAX, Math.max(ZMIN, Math.round(z * 100) / 100));

// Tela do fluxo. Funciona com mouse e com o dedo:
// arrastar o fundo = mover a tela; dois dedos (ou Ctrl + rodinha) = zoom;
// arrastar o título do bloco = mover o bloco; puxar a bolinha = ligar.
function Canvas({ graph, setGraph, sel, setSel, current }) {
  const box = useRef(null), sizer = useRef(null), world = useRef(null);
  const [zoom, setZoom] = useState(1);
  const zr = useRef(1);            // zoom atual (para os eventos)
  const touches = useRef(new Map()); // dedos/ponteiros na tela
  const pinch = useRef(null);
  const cancel = useRef(null);     // cancela arrasto/ligação em andamento
  const [link, setLink] = useState(null); // ligação sendo puxada
  const pt = (e) => { const r = world.current.getBoundingClientRect(); return { x: (e.clientX - r.left) / zr.current, y: (e.clientY - r.top) / zr.current }; };
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const maxX = Math.max(1400, ...graph.nodes.map((n) => n.x + W + 300));
  const maxY = Math.max(800, ...graph.nodes.map((n) => n.y + height(n) + 300));
  const size = useRef({ maxX, maxY }); size.current = { maxX, maxY };

  // Troca o zoom mantendo parado o ponto (mx, my) da tela.
  // `at` (opcional) = ponto do desenho que deve ficar embaixo de (mx, my).
  const applyZoom = (z, mx, my, at) => {
    const b = box.current; if (!b) return;
    const z0 = zr.current; z = clampZ(z);
    if (mx === undefined) { mx = b.clientWidth / 2; my = b.clientHeight / 2; }
    const cx = at ? at.x : (b.scrollLeft + mx) / z0, cy = at ? at.y : (b.scrollTop + my) / z0;
    zr.current = z;
    sizer.current.style.width = `${size.current.maxX * z}px`; sizer.current.style.height = `${size.current.maxY * z}px`;
    world.current.style.transform = `scale(${z})`;
    b.scrollLeft = cx * z - mx; b.scrollTop = cy * z - my;
    setZoom(z);
  };
  const fit = () => {
    const b = box.current; if (!b || !graph.nodes.length) return;
    const x0 = Math.min(...graph.nodes.map((n) => n.x)) - 30, y0 = Math.min(...graph.nodes.map((n) => n.y)) - 30;
    const x1 = Math.max(...graph.nodes.map((n) => n.x + W)) + 40, y1 = Math.max(...graph.nodes.map((n) => n.y + height(n))) + 30;
    applyZoom(Math.min(1, b.clientWidth / (x1 - x0), b.clientHeight / (y1 - y0)), 0, 0);
    b.scrollLeft = x0 * zr.current; b.scrollTop = y0 * zr.current;
  };
  useEffect(() => { if (innerWidth < 900) fit(); }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (!['Delete', 'Backspace'].includes(e.key) || /input|textarea|select/i.test(document.activeElement?.tagName)) return;
      if (sel?.node && byId[sel.node]?.type !== 'start') { setGraph((g) => ({ nodes: g.nodes.filter((n) => n.id !== sel.node), edges: g.edges.filter((x) => x.from !== sel.node && x.to !== sel.node) })); setSel(null); }
      else if (sel?.edge !== undefined) { setGraph((g) => ({ ...g, edges: g.edges.filter((_, i) => i !== sel.edge) })); setSel(null); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [sel, graph]);

  // Dois dedos: zoom de pinça.
  useEffect(() => {
    const dist = () => { const [a, b] = [...touches.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
    const mid = () => { const [a, b] = [...touches.current.values()]; const r = box.current.getBoundingClientRect(); return { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }; };
    const move = (e) => {
      if (!touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = pinch.current;
      if (!p || touches.current.size < 2) return;
      const m = mid(); // o ponto do desenho que estava entre os dedos acompanha os dedos (zoom + arrastar)
      applyZoom(p.z0 * dist() / p.d0, m.x, m.y, p.at);
    };
    const up = (e) => { touches.current.delete(e.pointerId); if (touches.current.size < 2) pinch.current = null; };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    box.current._startPinch = () => {
      cancel.current?.();
      const m = mid(), b = box.current, z0 = zr.current;
      pinch.current = { d0: dist(), z0, at: { x: (b.scrollLeft + m.x) / z0, y: (b.scrollTop + m.y) / z0 } };
    };
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  }, []);

  // Acompanha um ponteiro até soltar (só aquele dedo; para se virar pinça).
  const follow = (e, onMove, onUp) => {
    const id = e.pointerId;
    const move = (ev) => { if (ev.pointerId === id && !pinch.current) onMove(ev); };
    const stop = (ev, cancelled) => { if (ev && ev.pointerId !== id) return; removeEventListener('pointermove', move); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop); cancel.current = null; onUp?.(ev, cancelled || ev?.type === 'pointercancel'); };
    addEventListener('pointermove', move); addEventListener('pointerup', stop); addEventListener('pointercancel', stop);
    cancel.current = () => stop(null, true);
  };
  const onDownCapture = (e) => {
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2) { e.stopPropagation(); box.current._startPinch(); }
  };
  const isBg = (t) => t === box.current || t === sizer.current || t === world.current || t.tagName === 'svg';
  const startPan = (e) => {
    if (!isBg(e.target) || e.button !== 0 || pinch.current) return;
    setSel(null);
    const b = box.current, x0 = e.clientX, y0 = e.clientY, sl = b.scrollLeft, st = b.scrollTop;
    follow(e, (ev) => { b.scrollLeft = sl - (ev.clientX - x0); b.scrollTop = st - (ev.clientY - y0); });
  };
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = box.current.getBoundingClientRect();
    applyZoom(zr.current * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  };

  const startDrag = (e, n) => {
    if (e.button !== 0 || pinch.current) return;
    e.preventDefault();
    setSel({ node: n.id });
    const p0 = pt(e), ox = p0.x - n.x, oy = p0.y - n.y;
    follow(e, (ev) => { const p = pt(ev); const x = Math.max(0, Math.round((p.x - ox) / 10) * 10), y = Math.max(0, Math.round((p.y - oy) / 10) * 10);
      setGraph((g) => ({ ...g, nodes: g.nodes.map((m) => (m.id === n.id ? { ...m, x, y } : m)) })); });
  };
  const startLink = (e, n, port, i) => {
    if (pinch.current) return;
    e.preventDefault(); e.stopPropagation();
    const from = { x: n.x + W, y: portY(n, i) };
    setLink({ from, to: from });
    follow(e, (ev) => setLink({ from, to: pt(ev) }), (ev, cancelled) => {
      setLink(null);
      if (cancelled || !ev) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-node]')?.dataset.node;
      if (!target || target === n.id || byId[target]?.type === 'start') return;
      setGraph((g) => ({ ...g, edges: [...g.edges.filter((x) => !(x.from === n.id && x.port === port)), { from: n.id, port, to: target }] }));
    });
  };
  const curve = (a, b) => { const dx = Math.max(50, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };

  return html`<div class="fl-stage">
    <div class="fl-canvas" ref=${box} data-zoom=${zoom} onPointerDownCapture=${onDownCapture} onPointerDown=${startPan} onWheel=${onWheel}>
    <div class="fl-sizer" ref=${sizer} style=${`width:${maxX * zoom}px;height:${maxY * zoom}px`}>
    <div class="fl-world" ref=${world} style=${`width:${maxX}px;height:${maxY}px;transform:scale(${zoom})`}>
      <svg width=${maxX} height=${maxY} class="fl-edges">
        ${graph.edges.map((ed, i) => {
          const a = byId[ed.from], b = byId[ed.to];
          if (!a || !b) return null;
          const pi = portsOf(a).indexOf(ed.port);
          if (pi < 0) return null;
          const d = curve({ x: a.x + W, y: portY(a, pi) }, { x: b.x, y: b.y + HEAD / 2 });
          const on = sel?.edge === i;
          return html`<g class=${`fl-edge ${on ? 'on' : ''}`} onPointerDown=${(e) => { if (pinch.current) return; e.stopPropagation(); setSel({ edge: i }); }}>
            <path d=${d} class="hit" /><path d=${d} class="line" marker-end="url(#fl-arrow)" /></g>`;
        })}
        ${link && html`<path d=${curve(link.from, link.to)} class="fl-temp" />`}
        <defs><marker id="fl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="fl-arrowhead" /></marker></defs>
      </svg>
      ${graph.nodes.map((n) => {
        const t = TYPES[n.type] || TYPES.end;
        const ports = portsOf(n);
        return html`<div data-node=${n.id} class=${`fl-node tone-${t.tone} ${sel?.node === n.id ? 'sel' : ''} ${current === n.id ? 'cur' : ''}`}
            style=${`left:${n.x}px;top:${n.y}px;width:${W}px;height:${height(n)}px`} onPointerDown=${(e) => { if (!e.target.closest('.fl-port')) setSel({ node: n.id }); }}>
          ${n.type !== 'start' && html`<span class="fl-in" aria-hidden="true"></span>`}
          <div class="fl-head" onPointerDown=${(e) => startDrag(e, n)}><span aria-hidden="true">${t.icon}</span>${t.label}</div>
          <div class="fl-body">${summary(n)}</div>
          ${ports.map((p, i) => html`<div class="fl-port-row"><span>${portLabel(n, p)}</span>
            <span class="fl-port" title="Puxe até o próximo bloco" onPointerDown=${(e) => startLink(e, n, p, i)}></span></div>`)}
        </div>`;
      })}
    </div></div></div>
    <div class="fl-zoom" role="group" aria-label="Zoom">
      <button class="btn" title="Diminuir" aria-label="Diminuir" onClick=${() => applyZoom(zr.current / 1.25)}>−</button>
      <button class="btn" title="Tamanho normal" onClick=${() => applyZoom(1)}>${Math.round(zoom * 100)}%</button>
      <button class="btn" title="Aumentar" aria-label="Aumentar" onClick=${() => applyZoom(zr.current * 1.25)}>+</button>
      <button class="btn" title="Mostrar o fluxo inteiro" onClick=${fit}>Ajustar</button>
    </div>
  </div>`;
}

function NodeEditor({ node, stages, onChange, onDelete }) {
  const d = node.data || {};
  const t = TYPES[node.type];
  const set = (k, v) => onChange({ ...d, [k]: v });
  const btns = d.buttons || [];
  const msgFields = html`
    <label class="field">Texto<textarea rows="6" value=${d.text || ''} onInput=${(e) => set('text', e.target.value)}></textarea></label>
    <p class="xs muted">Use <code>{{primeiro_nome}}</code> para chamar pelo nome (fica em branco se o contato for empresa).</p>
    <div class="field">Botões (opcional, até 3)
      ${[0, 1, 2].map((i) => (i <= btns.length ? html`<input maxlength="20" placeholder=${['Ex.: Quero o preço', 'Ex.: Tirar uma dúvida', 'Ex.: Falar com vendedor'][i]} value=${btns[i] || ''}
        onInput=${(e) => { const b = [...btns]; b[i] = e.target.value; while (b.length && !b.at(-1)) b.pop(); set('buttons', b.slice(0, 3)); }} />` : null))}
      <span class="xs muted">Até 20 letras cada. O cliente toca no botão em vez de digitar. ${node.type === 'question' ? 'Cada botão vira uma saída do bloco.' : ''}</span></div>`;
  return html`<div class="pad col fl-editor"><div class="row"><h3 class="grow"><span aria-hidden="true">${t.icon}</span> ${t.label}</h3></div>
    ${t.hint && html`<p class="xs muted">${t.hint}</p>`}
    ${node.type === 'message' && msgFields}
    ${node.type === 'question' && html`${msgFields}
      <label class="field">Se não responder em (horas)<input type="number" min="1" max="23" value=${d.timeout_hours ?? 20} onInput=${(e) => set('timeout_hours', Number(e.target.value))} /></label>
      <p class="xs muted">Depois de 24 h sem o cliente escrever, o WhatsApp só aceita mensagem modelo. Por isso o prazo vai até 23 h.</p>`}
    ${node.type === 'wait' && html`<div class="grid-2"><label class="field">Quanto<input type="number" min="1" value=${d.amount ?? 1} onInput=${(e) => set('amount', Number(e.target.value))} /></label>
      <label class="field">Unidade<select value=${d.unit || 'h'} onChange=${(e) => set('unit', e.target.value)}><option value="min">minutos</option><option value="h">horas</option><option value="d">dias</option></select></label></div>
      ${(d.unit === 'd' || (d.unit !== 'min' && (d.amount || 1) >= 24)) && html`<div class="banner warn small">Mais de 24 h depois da última mensagem do cliente o WhatsApp recusa texto livre: a mensagem seguinte falha e a conversa passa para um atendente.</div>`}
      <p class="xs muted">Se o cliente escrever durante a espera, o robô para e a conversa vai para um atendente.</p>`}
    ${node.type === 'ai_reply' && html`
      <label class="field">Máximo de respostas da IA<input type="number" min="1" max="20" value=${d.max_turns ?? 4} onInput=${(e) => set('max_turns', Number(e.target.value))} /></label>
      <label class="field">Se o cliente sumir, passar para humano em (horas)<input type="number" min="1" max="23" value=${d.timeout_hours ?? 20} onInput=${(e) => set('timeout_hours', Number(e.target.value))} /></label>
      <p class="xs muted">A IA responde só com o que está em <a href="#/settings/ai">Ajustes › Assistente de IA</a>. Quando o cliente quer fechar, pede uma pessoa, reclama ou pergunta algo fora da base, ela avisa que um especialista vai continuar e sai pela saída "passar p/ humano".</p>`}
    ${node.type === 'ai_classify' && html`<div class="field">Intenções (cada uma vira uma saída)
      ${(d.classes || []).map((c, i) => html`<div class="fl-class"><input placeholder="nome curto" value=${c.name} onInput=${(e) => set('classes', d.classes.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/\s+/g, '_') } : x)))} />
        <input placeholder="o que significa" value=${c.description} onInput=${(e) => set('classes', d.classes.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
        <button class="btn sm" aria-label="Remover" onClick=${() => set('classes', d.classes.filter((_, j) => j !== i))}>×</button></div>`)}
      <button class="btn sm" onClick=${() => set('classes', [...(d.classes || []), { name: '', description: '' }])}>+ Intenção</button>
      <span class="xs muted">Se nenhuma servir, sai por "outro".</span></div>`}
    ${node.type === 'catalog' && html`<${CatalogEditor} d=${d} set=${set} />`}
    ${node.type === 'ai_agent' && html`
      <label class="field">Máximo de respostas da IA<input type="number" min="1" max="20" value=${d.max_turns ?? 6} onInput=${(e) => set('max_turns', Number(e.target.value))} /></label>
      <label class="field">Se o cliente parar de responder, seguir por "sem resposta" em (horas)<input type="number" min="1" max="23" value=${d.timeout_hours ?? 1} onInput=${(e) => set('timeout_hours', Number(e.target.value))} /></label>
      <p class="xs muted">A IA lê cada resposta: pede o modelo, pede o contato de quem vai cuidar, agradece quem não tem interesse e, quando descobre o modelo, manda a tabela dele (a frase dela vai de legenda). Preço ela nunca digita. O que ela sabe da empresa fica em <a href="#/settings/ai">Ajustes › Assistente de IA</a>.</p>
      <${CatalogEditor} d=${d} set=${set} />`}
    ${node.type === 'stage' && html`<label class="field">Mover o lead para<select value=${String(d.stage_id || '')} onChange=${(e) => set('stage_id', Number(e.target.value))}>
      <option value="">— etapa —</option>${stages.map((s) => html`<option value=${String(s.id)}>${s.name}</option>`)}</select></label>`}
    ${node.type === 'tag' && html`<label class="field">Etiqueta<input list="fl-tags" value=${d.tag || ''} onInput=${(e) => set('tag', e.target.value)} /></label>
      <datalist id="fl-tags">${B().tags.map((t) => html`<option value=${t.name} />`)}</datalist>`}
    ${node.type === 'handoff' && html`<label class="field">Recado na tarefa (opcional)<input placeholder="Ex.: cliente quer orçamento" value=${d.note || ''} onInput=${(e) => set('note', e.target.value)} /></label>
      <p class="xs muted">Cria uma tarefa "Responder fulano" para o responsável do lead (ou sem responsável), deixa a conversa como não lida e o robô para.</p>`}
    ${node.type === 'start' && html`<p class="small">Liga este bloco ao primeiro passo. O que dispara o fluxo é escolhido lá em cima.</p>`}
    ${node.type !== 'start' && html`<button class="btn danger sm" style="align-self:flex-start" onClick=${onDelete}>Apagar bloco</button>`}
  </div>`;
}

// Cada linha: nome, modelos que o cliente pode escrever e a imagem da tabela.
function CatalogEditor({ d, set }) {
  const items = d.items || [];
  const setItem = (i, patch_) => set('items', items.map((x, j) => (j === i ? { ...x, ...patch_ } : x)));
  const [busy, setBusy] = useState(null);
  const upload = async (i, file) => {
    if (!file) return;
    setBusy(i);
    try {
      const r = await api('/files', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) } });
      setItem(i, { file_id: r.id });
    } catch (e) { fail(e); }
    setBusy(null);
  };
  return html`
    <label class="field">Frase que vai junto da tabela<textarea rows="2" value=${d.text || ''} onInput=${(e) => set('text', e.target.value)}></textarea></label>
    <p class="xs muted">O robô procura os modelos na resposta do cliente (sem ligar para espaço, hífen ou maiúscula: "AG 25" = "ag-25"). Se ele citar mais de um, manda todas as tabelas e a frase vai na última.</p>
    ${items.map((it, i) => html`<div class="fl-cat">
      ${it.file_id ? html`<img src=${`/api/files/${it.file_id}`} alt=${`Tabela ${it.name}`} />` : html`<div class="fl-cat-empty">sem imagem</div>`}
      <div class="col" style="gap:4px;min-width:0">
        <input aria-label="Nome" placeholder="Ex.: Antena StarFire 6000" value=${it.name || ''} onInput=${(e) => setItem(i, { name: e.target.value })} />
        <input aria-label="Modelos" placeholder="Modelos, separados por vírgula: 6000, SF6000" value=${(it.keywords || []).join(', ')}
          onInput=${(e) => setItem(i, { keywords: e.target.value.split(',').map((k) => k.trim()) })} />
        <div class="row"><label class="btn sm">${busy === i ? 'Enviando…' : it.file_id ? 'Trocar imagem' : 'Escolher imagem'}<input type="file" accept="image/jpeg,image/png" class="sr-only" onChange=${(e) => upload(i, e.target.files[0])} /></label>
          <button class="btn sm" onClick=${() => set('items', items.filter((_, j) => j !== i))}>Remover</button></div>
      </div></div>`)}
    <button class="btn sm" style="align-self:flex-start" onClick=${() => set('items', [...items, { name: '', keywords: [], file_id: null }])}>+ Tabela</button>`;
}

function Simulator({ graph, sim, setSim }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [sim.out.length]);
  const act = async (action) => {
    setBusy(true);
    const mine = action.text ? [{ type: 'me', text: action.text }] : [];
    try {
      const r = await post('/flows/simulate', { graph, sim: sim.state, action });
      setSim({ state: r.sim, out: [...(action.type === 'start' ? [] : sim.out), ...mine, ...r.out] });
    } catch (e) { fail(e); }
    setBusy(false);
    setText('');
  };
  const st = sim.state?.state;
  const waiting = st === 'waiting_reply' || st === 'waiting_time';
  const send = (e) => { e.preventDefault(); if (!text.trim()) return; act(sim.state ? { type: 'reply', text: text.trim() } : { type: 'start', text: text.trim() }); };
  return html`<div class="fl-sim">
    <div class="row pad" style="padding-bottom:0"><h3 class="grow">Simulador</h3><button class="btn sm" onClick=${() => setSim(null)}>Fechar</button></div>
    <p class="xs muted pad" style="padding-top:4px">Nada é enviado de verdade. Você faz o papel do cliente "João". Os blocos de IA chamam a IA de verdade.</p>
    <div class="fl-chat" ref=${box}>
      ${!sim.state && html`<p class="small muted">Escreva a primeira mensagem do cliente (ex.: a resposta à campanha) para começar.</p>`}
      ${sim.out.map((m) => (m.type === 'info' ? html`<div class="fl-info">${m.text}</div>`
        : html`<div class=${`bubble ${m.type === 'me' ? 'in' : 'out'}`}>${m.image && html`<img class="wa-img" src=${`/api/files/${m.image}`} alt="Tabela de preços" />`}${m.text}
          ${m.buttons?.length > 0 && html`<div class="fl-btns">${m.buttons.map((b) => html`<button class="btn sm" disabled=${busy || st !== 'waiting_reply'} onClick=${() => act({ type: 'reply', text: b })}>${b}</button>`)}</div>`}</div>`))}
      ${busy && html`<div class="fl-info">…</div>`}
      ${st && !waiting && !busy && html`<div class="fl-info">Fluxo terminou (${STATES[st]?.[0] || st}).</div>`}
    </div>
    <form class="row pad" onSubmit=${send}><input class="grow" placeholder=${sim.state ? 'Resposta do cliente…' : 'Quero saber o preço'} value=${text} onInput=${(e) => setText(e.target.value)} disabled=${busy} />
      <button class="btn primary" disabled=${busy}>${sim.state ? 'Enviar' : 'Começar'}</button></form>
    <div class="row pad" style="padding-top:0">
      ${waiting && html`<button class="btn sm" disabled=${busy} onClick=${() => act({ type: 'timeout' })}>${st === 'waiting_time' ? 'Pular a espera' : 'Cliente não respondeu'}</button>`}
      ${sim.state && html`<button class="btn sm" disabled=${busy} onClick=${() => setSim({ state: null, out: [] })}>Recomeçar</button>`}
    </div></div>`;
}

function Runs({ flow, reload }) {
  const nodeLabel = (id) => { const n = flow.graph.nodes.find((x) => x.id === id); return n ? TYPES[n.type]?.label + (n.data?.text ? `: ${n.data.text.slice(0, 40)}` : '') : '—'; };
  if (!flow.recent.length) return html`<${Empty} title="Ninguém passou por este fluxo ainda"><p>Quando o fluxo estiver ligado e um cliente disparar o gatilho, ele aparece aqui.</p><//>`;
  return html`<div class="page" style="padding:0"><table class="t"><thead><tr><th>Contato</th><th>Situação</th><th class="hide-sm">Onde está</th><th>Atualizado</th><th></th></tr></thead>
    <tbody>${flow.recent.map((r) => html`<tr><td><a href=${`#/contact/${r.contact_id}`}>${r.contact_name}</a></td>
      <td><span class=${`pill st-${STATES[r.state]?.[1] || ''}`}>${STATES[r.state]?.[0] || r.state}</span>
        ${r.wake_at && html`<div class="xs muted">até ${fmtDateTime(r.wake_at)}</div>`}${r.error && html`<div class="xs muted">${r.error}</div>`}</td>
      <td class="hide-sm small">${nodeLabel(r.node_id)}</td><td class="small">${ago(r.updated_at)}</td>
      <td>${['running', 'waiting_reply', 'waiting_time'].includes(r.state) && html`<button class="btn sm" onClick=${() => post(`/flow-runs/${r.id}/stop`).then(() => { toast('Robô parado nesta conversa'); reload(); }).catch(fail)}>Parar</button>`}</td></tr>`)}</tbody></table></div>`;
}
