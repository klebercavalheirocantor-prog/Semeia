import { html, useState, useEffect, api, post, patch, fail, toast, B, go, money, parseMoney, ago, dueLabel, userName, useData, useDebounced, Modal, Channel, Tag, UserSelect, StageSelect, Skeleton, ErrorBox, Empty } from '../lib.js';

const PKEY = 'crm.pipeline';
const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export function LossModal({ onOk, onClose }) {
  const [reason, setReason] = useState(B().loss_reasons[0]?.id);
  return html`<${Modal} title="Por que o lead foi perdido?" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancelar</button>
    <button class="btn primary" disabled=${!reason} onClick=${() => { onOk(reason); onClose(); }}>Marcar como perdido</button>`}>
    <div class="col">${B().loss_reasons.map((r) => html`<label class="row"><input type="radio" name="loss" checked=${reason === r.id} onChange=${() => setReason(r.id)} />${r.name}</label>`)}
    ${!B().loss_reasons.length && html`<p class="muted">Cadastre motivos em Configurações > Listas.</p>`}</div>
  <//>`;
}

export function NewLeadModal({ pipelineId, stageId, contact, onClose }) {
  const pipe = B().pipelines.find((p) => p.id === pipelineId) || B().pipelines[0];
  const first = pipe.stages.find((s) => s.kind === 'normal');
  const [f, setF] = useState({ name: '', price: '', stage_id: stageId || first?.id, cname: '', phone: '', email: '', responsible_id: B().user.id });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post('/leads', { name: f.name || f.cname, price_cents: parseMoney(f.price), stage_id: f.stage_id, responsible_id: f.responsible_id,
        ...(contact ? { contact_id: contact.id } : { contact: { name: f.cname, phone: f.phone, email: f.email } }) });
      onClose();
      go(`#/lead/${r.id}`);
    } catch (err) { fail(err); setBusy(false); }
  };
  return html`<${Modal} title="Novo lead" onClose=${onClose}>
    <form class="form" onSubmit=${save}>
      <label class="field">Nome do negócio<input autofocus value=${f.name} onInput=${set('name')} placeholder="Ex.: Orçamento de cozinha" /></label>
      <div class="row wrap">
        <label class="field grow">Valor<input inputmode="decimal" value=${f.price} onInput=${set('price')} placeholder="R$ 0" /></label>
        <label class="field grow">Etapa<${StageSelect} value=${f.stage_id} onChange=${(v) => setF({ ...f, stage_id: v })} /></label>
      </div>
      <label class="field">Responsável<${UserSelect} value=${f.responsible_id} onChange=${(v) => setF({ ...f, responsible_id: v })} /></label>
      ${contact ? html`<p class="small">Contato: <strong>${contact.name}</strong></p>` : html`
        <div class="section-title" style="margin:0">Contato</div>
        <label class="field">Nome<input value=${f.cname} onInput=${set('cname')} /></label>
        <div class="row wrap">
          <label class="field grow">Telefone / WhatsApp<input type="tel" value=${f.phone} onInput=${set('phone')} placeholder="(11) 98765-4321" /></label>
          <label class="field grow">Email<input type="email" value=${f.email} onInput=${set('email')} /></label>
        </div>`}
      <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancelar</button>
        <button class="btn primary" disabled=${busy || !(f.name || f.cname || contact)}>Criar lead</button></div>
    </form>
  <//>`;
}

function QuickAdd({ stage, onDone }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const save = async () => {
    if (!name.trim()) return;
    try { await post('/leads', { name, price_cents: parseMoney(price), stage_id: stage.id }); setName(''); setPrice(''); onDone(); } catch (e) { fail(e); }
  };
  return html`<div class="quick-add">
    <input autofocus aria-label="Nome do lead" placeholder="Nome" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(); }} />
    <input aria-label="Valor" placeholder="Valor" inputmode="decimal" value=${price} onInput=${(e) => setPrice(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} />
    <div class="row"><button class="btn primary sm" onClick=${save}>Adicionar</button><button class="btn sm" onClick=${onDone}>Cancelar</button></div>
  </div>`;
}

function TaskFlag({ l, closed }) {
  if (closed) return null;
  if (!l.next_task_at) return html`<span class="pill warn">Sem tarefa</span>`;
  if (l.next_task_at < Date.now()) return html`<span class="pill danger">Tarefa atrasada</span>`;
  return html`<span class="pill">⏰ ${dueLabel(l.next_task_at)}</span>`;
}

function LeadCard({ l, stage, onDrag }) {
  const closed = stage.kind === 'won' || stage.kind === 'lost';
  return html`<a class="lead-card" href=${`#/lead/${l.id}`} draggable="true" onDragStart=${(e) => { e.dataTransfer.setData('text/plain', String(l.id)); onDrag(l.id); e.currentTarget.classList.add('dragging'); }}
    onDragEnd=${(e) => { e.currentTarget.classList.remove('dragging'); onDrag(null); }}>
    <div class="row"><span class="title grow">${l.name}</span>${l.unread > 0 && html`<span class="badge" title="Mensagens não lidas">${l.unread}</span>`}</div>
    ${l.contact_name && l.contact_name !== l.name && html`<div class="small muted ellipsis">${l.contact_name}</div>`}
    ${l.last_msg && html`<div class="row preview"><${Channel} kind=${l.channel} /><span class="ellipsis grow">${l.last_msg.dir === 'out' ? 'Você: ' : ''}${l.last_msg.body || '[mídia]'}</span><span class="xs">${ago(l.last_msg.at)}</span></div>`}
    <div class="row wrap" style="margin-top:4px">
      ${l.price_cents > 0 && html`<strong class="small">${money(l.price_cents)}</strong>`}
      ${l.tags.map((t) => html`<${Tag} t=${t} />`)}
      <${TaskFlag} l=${l} closed=${closed} />
      <span class="spacer"></span><span class="xs muted">${userName(l.responsible_id)}</span>
    </div>
  </a>`;
}

export function LeadsPage({ query }) {
  const boot = B();
  const [pid, setPid] = useState(() => Number(query.pipeline || read(PKEY, 0)) || boot.pipelines[0].id);
  const pipe = boot.pipelines.find((p) => p.id === pid) || boot.pipelines[0];
  const [view, setView] = useState(() => read('crm.view', 'board'));
  const [q, setQ] = useState('');
  const [flt, setFlt] = useState({ responsible_id: '', tag_id: '', task: '' });
  const dq = useDebounced(q);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const [adding, setAdding] = useState(null);
  const [loss, setLoss] = useState(null);
  const [newLead, setNewLead] = useState(false);
  useEffect(() => write(PKEY, pipe.id), [pipe.id]);
  useEffect(() => write('crm.view', view), [view]);

  const params = new URLSearchParams({ pipeline_id: pipe.id, ...(dq && { q: dq }), ...Object.fromEntries(Object.entries(flt).filter(([, v]) => v)), ...(view === 'list' && { closed: 'all' }) });
  const { data, loading, error, reload, setData } = useData(() => api(`/leads?${params}`), [params.toString()], ['lead', 'message', 'task', 'config']);

  const move = async (leadId, stage, lossReason) => {
    const l = data.find((x) => x.id === leadId);
    if (!l || l.stage_id === stage.id) return;
    if (stage.kind === 'lost' && !lossReason) return setLoss({ leadId, stage });
    setData((d) => d.map((x) => (x.id === leadId ? { ...x, stage_id: stage.id } : x)));
    try { await patch(`/leads/${leadId}`, { stage_id: stage.id, loss_reason_id: lossReason }); if (stage.kind === 'won') toast('Venda fechada! 🎉'); } catch (e) { fail(e); reload(); }
  };

  const filtersBar = html`<div class="topbar">
    <label class="sr-only" for="pipe">Funil</label>
    <select id="pipe" value=${pipe.id} onChange=${(e) => setPid(Number(e.target.value))}>${boot.pipelines.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>
    <input type="search" aria-label="Buscar" placeholder="Buscar nome, telefone, email" value=${q} onInput=${(e) => setQ(e.target.value)} style="width:240px" />
    <${UserSelect} label="Filtrar por responsável" none="Todos os responsáveis" value=${Number(flt.responsible_id) || ''} onChange=${(v) => setFlt({ ...flt, responsible_id: v || '' })} />
    <select aria-label="Filtrar por tag" value=${flt.tag_id} onChange=${(e) => setFlt({ ...flt, tag_id: e.target.value })}><option value="">Todas as tags</option>${boot.tags.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select>
    <select aria-label="Filtrar por tarefa" value=${flt.task} onChange=${(e) => setFlt({ ...flt, task: e.target.value })}><option value="">Qualquer tarefa</option><option value="none">Sem tarefa</option><option value="overdue">Tarefa atrasada</option></select>
    <span class="spacer"></span>
    <div class="row" role="group" aria-label="Visualização">
      <button class="btn sm" aria-pressed=${view === 'board'} style=${view === 'board' ? 'font-weight:700' : ''} onClick=${() => setView('board')}>Quadro</button>
      <button class="btn sm" aria-pressed=${view === 'list'} style=${view === 'list' ? 'font-weight:700' : ''} onClick=${() => setView('list')}>Lista</button>
    </div>
    <button class="btn primary" onClick=${() => setNewLead(true)}>+ Novo lead</button>
  </div>`;

  let body;
  if (error) body = html`<${ErrorBox} error=${error} retry=${reload} />`;
  else if (!data) body = html`<div class="board">${pipe.stages.map(() => html`<div class="column"><div class="column-body"><${Skeleton} rows=${3} h=${70} /></div></div>`)}</div>`;
  else if (view === 'list') {
    body = data.length ? html`<div class="page" style="padding:0"><table class="t">
      <thead><tr><th>Lead</th><th class="hide-sm">Contato</th><th>Etapa</th><th>Valor</th><th class="hide-sm">Responsável</th><th class="hide-sm">Próxima tarefa</th><th class="hide-sm">Atualizado</th></tr></thead>
      <tbody>${data.map((l) => { const s = pipe.stages.find((x) => x.id === l.stage_id); return html`<tr>
        <td><a href=${`#/lead/${l.id}`}>${l.name}</a> ${l.unread > 0 && html`<span class="badge">${l.unread}</span>`}</td><td class="hide-sm">${l.contact_name}</td>
        <td><span class="pill" style=${`border-color:${s?.color}`}>${s?.name}</span></td><td>${money(l.price_cents)}</td><td class="hide-sm">${userName(l.responsible_id)}</td>
        <td class="hide-sm"><${TaskFlag} l=${l} closed=${s?.kind === 'won' || s?.kind === 'lost'} /></td><td class="hide-sm small muted">${ago(l.updated_at)}</td></tr>`; })}</tbody></table></div>`
      : html`<${Empty} title="Nenhum lead encontrado"><p>Mude os filtros ou crie um lead.</p><//>`;
  } else {
    body = html`<div class="board">${pipe.stages.map((s) => {
      const items = data.filter((l) => l.stage_id === s.id);
      const sum = items.reduce((a, l) => a + l.price_cents, 0);
      return html`<section class="column ${over === s.id && drag ? 'drop' : ''}" style=${`--stage-color:${s.color}`} aria-label=${s.name}
        onDragOver=${(e) => { e.preventDefault(); setOver(s.id); }} onDragLeave=${() => setOver(null)}
        onDrop=${(e) => { e.preventDefault(); setOver(null); move(Number(e.dataTransfer.getData('text/plain')), s); }}>
        <div class="column-head">
          <div class="row"><span class="name grow ellipsis" title=${s.name}>${s.name}</span>
            ${(s.kind === 'normal' || s.kind === 'incoming') && html`<button class="btn ghost sm" aria-label=${`Adicionar lead em ${s.name}`} onClick=${() => setAdding(s.id)}>+</button>`}</div>
          <div class="small muted">${items.length} ${items.length === 1 ? 'lead' : 'leads'} · ${money(sum)}${s.kind === 'won' || s.kind === 'lost' ? ' · 30 dias' : ''}</div>
        </div>
        <div class="column-body">
          ${adding === s.id && html`<${QuickAdd} stage=${s} onDone=${() => { setAdding(null); reload(); }} />`}
          ${items.map((l) => html`<${LeadCard} key=${l.id} l=${l} stage=${s} onDrag=${setDrag} />`)}
          ${!items.length && adding !== s.id && html`<p class="small muted" style="text-align:center">${s.kind === 'incoming' ? 'Conversas novas chegam aqui' : 'Arraste leads para cá'}</p>`}
        </div>
      </section>`;
    })}</div>`;
  }

  return html`<div class="main">${filtersBar}<div style="flex:1;overflow:hidden">${body}</div>
    ${loss && html`<${LossModal} onClose=${() => setLoss(null)} onOk=${(r) => move(loss.leadId, loss.stage, r)} />`}
    ${newLead && html`<${NewLeadModal} pipelineId=${pipe.id} onClose=${() => setNewLead(false)} />`}
  </div>`;
}
