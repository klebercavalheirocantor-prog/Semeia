import { html, useState, api, post, patch, fail, B, useData, Modal, UserSelect, Skeleton, ErrorBox, Empty, userName, dueLabel, fmtDateTime, toLocalInput, endOfDay, dayKey } from '../lib.js';

const LINK = { lead: 'lead', contact: 'contact', company: 'company' };

function NewTask({ onClose }) {
  const [t, setT] = useState({ text: '', type_id: B().task_types[0]?.id, due_at: endOfDay(0), responsible_id: B().user.id });
  const save = (e) => { e.preventDefault(); post('/tasks', t).then(onClose).catch(fail); };
  return html`<${Modal} title="Nova tarefa" onClose=${onClose}><form class="form" onSubmit=${save}>
    <label class="field">O que fazer<input autofocus value=${t.text} onInput=${(e) => setT({ ...t, text: e.target.value })} /></label>
    <div class="row wrap"><label class="field">Tipo<select value=${t.type_id} onChange=${(e) => setT({ ...t, type_id: Number(e.target.value) })}>${B().task_types.map((x) => html`<option value=${x.id}>${x.name}</option>`)}</select></label>
      <label class="field">Prazo<input type="datetime-local" value=${toLocalInput(t.due_at)} onInput=${(e) => e.target.value && setT({ ...t, due_at: new Date(e.target.value).getTime() })} /></label></div>
    <label class="field">Responsável<${UserSelect} none=${false} value=${t.responsible_id} onChange=${(v) => setT({ ...t, responsible_id: v })} /></label>
    <p class="small muted">Para ligar a tarefa a um cliente, crie pelo cartão do lead.</p>
    <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancelar</button><button class="btn primary" disabled=${!t.text.trim()}>Criar</button></div>
  </form><//>`;
}

function Row({ k }) {
  const [res, setRes] = useState(null);
  const type = B().task_types.find((t) => t.id === k.type_id);
  const done = () => patch(`/tasks/${k.id}`, { done: true, result: res }).catch(fail);
  return html`<div class="task-item ${!k.done_at && k.due_at < Date.now() ? 'overdue' : ''}" style=${type ? `--type-color:${type.color}` : ''}>
    <div class="row wrap">
      <strong class="small">${type?.name || 'Tarefa'}</strong>
      <span class="small muted">${k.done_at ? `concluída ${fmtDateTime(k.done_at)}` : dueLabel(k.due_at)}</span>
      ${k.entity && html`<a class="small" href=${`#/${LINK[k.entity]}/${k.entity_id}`}>${k.entity_name}</a>`}
      <span class="spacer"></span><span class="small muted">${userName(k.responsible_id)}</span>
      ${!k.done_at && res === null && html`<button class="btn sm" onClick=${() => setRes('')}>Concluir</button>`}
      ${k.done_at && html`<button class="btn ghost sm" onClick=${() => patch(`/tasks/${k.id}`, { done: false }).catch(fail)}>Reabrir</button>`}
    </div>
    <div>${k.text}</div>
    ${k.result && html`<div class="small muted">Resultado: ${k.result}</div>`}
    ${res !== null && html`<div class="row" style="margin-top:6px"><input class="grow" autofocus aria-label="Resultado" placeholder="Resultado (opcional)" value=${res}
      onInput=${(e) => setRes(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && done()} /><button class="btn primary sm" onClick=${done}>Salvar</button><button class="btn sm" onClick=${() => setRes(null)}>Cancelar</button></div>`}
  </div>`;
}

export function TasksPage() {
  const me = B().user;
  const seeAll = me.is_admin || me.rights?.leads?.view === 'all';
  const [resp, setResp] = useState(me.id);
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useData(() => api(`/tasks?status=${status}${resp ? `&responsible_id=${resp}` : ''}`), [resp, status], ['task', 'lead']);
  const now = Date.now();
  const groups = status === 'done' ? [['Concluídas', data || []]] : [
    ['Atrasadas', (data || []).filter((k) => k.due_at < now)],
    ['Hoje', (data || []).filter((k) => k.due_at >= now && dayKey(k.due_at) === dayKey(now))],
    ['Amanhã', (data || []).filter((k) => dayKey(k.due_at) === dayKey(now + 864e5))],
    ['Depois', (data || []).filter((k) => k.due_at >= now && dayKey(k.due_at) !== dayKey(now) && dayKey(k.due_at) !== dayKey(now + 864e5))],
  ];
  const [nw, setNw] = useState(false);
  return html`<div class="main">
    <div class="topbar"><h1 class="grow">Tarefas</h1>
      ${seeAll && html`<${UserSelect} label="Responsável" none="Todos" value=${resp} onChange=${setResp} />`}
      <select aria-label="Situação" value=${status} onChange=${(e) => setStatus(e.target.value)}><option value="open">Abertas</option><option value="done">Concluídas</option></select>
      <button class="btn primary" onClick=${() => setNw(true)}>+ Tarefa</button></div>
    <div class="page"><div class="col" style="max-width:900px">
      ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
      ${!data && !error && html`<${Skeleton} />`}
      ${data && !data.length && html`<${Empty} title=${status === 'open' ? 'Nenhuma tarefa aberta 👏' : 'Nenhuma tarefa concluída'} />`}
      ${data?.length > 0 && groups.filter(([, l]) => l.length).map(([title, l]) => html`<div class="section-title">${title} · ${l.length}</div>${l.map((k) => html`<${Row} key=${k.id} k=${k} />`)}`)}
    </div></div>
    ${nw && html`<${NewTask} onClose=${() => setNw(false)} />`}
  </div>`;
}
