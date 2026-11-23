import { html, useState, useEffect, useRef, api, post, patch, del, fail, B, userName, money, fmtTime, fmtDay, dayKey, dueLabel, toLocalInput, endOfDay, Channel, UserSelect, Confirm, Modal } from '../lib.js';

const STATUS = { pending: ['🕓', 'Enviando'], sent: ['✓', 'Enviada'], delivered: ['✓✓', 'Entregue'], read: ['✓✓', 'Lida'], failed: ['⚠', 'Falhou'] };

// Foto aberta por cima da conversa, com "Fechar". No app instalado no celular não há botão de voltar do navegador:
// abrir a foto numa página nova deixava a pessoa presa nela. O gesto/botão "voltar" do celular também fecha.
function PhotoView({ src, alt, onClose }) {
  useEffect(() => {
    history.pushState({ foto: 1 }, '');
    let closed = false;
    const onPop = () => { closed = true; onClose(); };
    const onKey = (e) => e.key === 'Escape' && history.back();
    addEventListener('popstate', onPop);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('popstate', onPop); removeEventListener('keydown', onKey); if (!closed && history.state?.foto) history.back(); };
  }, []);
  return html`<div class="lightbox" role="dialog" aria-modal="true" aria-label="Foto" onClick=${() => history.back()}>
    <button class="btn lightbox-close" onClick=${(e) => { e.stopPropagation(); history.back(); }}>✕ Fechar</button>
    <img src=${src} alt=${alt} onClick=${(e) => e.stopPropagation()} />
    <a class="btn sm lightbox-dl" href=${src} download onClick=${(e) => e.stopPropagation()}>Baixar</a>
  </div>`;
}

export function Bubble({ m }) {
  const [zoom, setZoom] = useState(false);
  const f = m.file_id && `/api/files/${m.file_id}`;
  const mime = m.file_mime || '';
  let media = null;
  if (f && mime.startsWith('image/')) media = html`<button type="button" class="bubble-img" onClick=${() => setZoom(true)} aria-label="Abrir foto"><img src=${f} alt=${m.file_name || 'imagem'} loading="lazy" /></button>
    ${zoom && html`<${PhotoView} src=${f} alt=${m.file_name || 'imagem'} onClose=${() => setZoom(false)} />`}`;
  else if (f && mime.startsWith('audio/')) media = html`<audio controls src=${f} preload="none"></audio>`;
  else if (f && mime.startsWith('video/')) media = html`<video controls src=${f} preload="none"></video>`;
  else if (f) media = html`<a href=${f} target="_blank" rel="noopener">📎 ${m.file_name || 'arquivo'}</a>`;
  else if (m.kind !== 'text' && m.kind !== 'other' && !m.body) media = html`<span class="muted small">${m.error ? 'Mídia indisponível' : 'Baixando mídia…'}</span>`;
  const st = STATUS[m.status];
  return html`<div class="bubble ${m.direction} ${m.status === 'failed' ? 'failed' : ''}">
    ${media}${media && m.body ? html`<br />` : ''}${m.body}
    <div class="meta">
      ${m.channel && html`<${Channel} kind=${m.channel} />`}
      ${m.kind === 'template' && html`<span>modelo ·</span>`}
      ${m.direction === 'out' && (m.user_name || userName(m.user_id)) && html`<span>${m.user_name || userName(m.user_id)} ·</span>`}
      ${m.bot ? html`<span title="Enviada pelo fluxo automático">🤖 robô ·</span>` : ''}
      <span>${fmtTime(m.created_at)}</span>
      ${m.direction === 'out' && st && html`<span class="tick ${m.status}" title=${st[1]}>${st[0]}<span class="sr-only">${st[1]}</span></span>`}
    </div>
    ${m.status === 'failed' && m.error && html`<div class="error-text">${m.error}</div>`}
  </div>`;
}

const fmtVal = (v) => (v === null || v === undefined || v === '' ? 'vazio' : Array.isArray(v) ? v.join(', ') : v === true ? 'sim' : v === false ? 'não' : String(v));

function eventText(e) {
  const d = e.data || {};
  const who = e.user_id ? userName(e.user_id) : d.by === 'robô' ? 'O robô' : 'Sistema';
  switch (e.type) {
    case 'lead_added': return `Lead criado${d.source === 'anuncio' ? ' pelo anúncio' : d.source && d.source !== 'manual' ? ` por mensagem (${d.source})` : ''} em "${d.stage}"`;
    case 'ad_click': return `Chegou pelo anúncio do ${d.where}${d.title ? `: ${d.title}` : ''}`;
    case 'stage_changed': return `${who} moveu de "${d.from}" para "${d.to}"${d.reason ? ` · motivo: ${d.reason}` : ''}`;
    case 'responsible_changed': return `${who} trocou o responsável: ${userName(d.from) || 'ninguém'} → ${userName(d.to) || 'ninguém'}`;
    case 'price_changed': return `${who} mudou o valor: ${money(d.from)} → ${money(d.to)}`;
    case 'name_changed': return `${who} renomeou: "${d.from}" → "${d.to}"`;
    case 'contact_linked': return `${who} vinculou o contato ${d.name}`;
    case 'contact_unlinked': return `${who} desvinculou o contato ${d.name || ''}`;
    case 'field_changed': return `${who} mudou ${d.name}: ${fmtVal(d.from)} → ${fmtVal(d.to)}`;
    case 'bot_handoff': return `O robô passou para um atendente: ${d.note}`;
    case 'conversation_linked': return `${who} juntou uma conversa a este lead`;
    default: return e.type;
  }
}

function TaskItem({ k }) {
  const [res, setRes] = useState(null);
  const type = B().task_types.find((t) => t.id === k.type_id);
  const overdue = !k.done_at && k.due_at < Date.now();
  const done = async () => { try { await patch(`/tasks/${k.id}`, { done: true, result: res }); setRes(null); } catch (e) { fail(e); } };
  return html`<div class="task-item ${overdue ? 'overdue' : ''} ${k.done_at ? 'done' : ''}" style=${type ? `--type-color:${type.color}` : ''}>
    <div class="row wrap small">
      <strong>${type?.name || 'Tarefa'}</strong>
      <span class=${overdue ? 'pill danger' : 'muted'}>${overdue ? 'Atrasada · ' : ''}${dueLabel(k.due_at)}</span>
      <span class="muted">para ${userName(k.responsible_id) || '—'}</span>
      <span class="spacer"></span>
      ${!k.done_at && res === null && html`<button class="btn sm" onClick=${() => setRes('')}>Concluir</button>`}
      ${k.done_at && html`<span class="pill ok">Concluída</span>`}
    </div>
    <div>${k.text}</div>
    ${k.result && html`<div class="small muted">Resultado: ${k.result}</div>`}
    ${res !== null && html`<div class="row" style="margin-top:6px"><input class="grow" autofocus placeholder="O que aconteceu? (opcional)" aria-label="Resultado da tarefa" value=${res}
      onInput=${(e) => setRes(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && done()} /><button class="btn primary sm" onClick=${done}>Salvar</button><button class="btn sm" onClick=${() => setRes(null)}>Cancelar</button></div>`}
  </div>`;
}

function NoteItem({ n }) {
  const [ask, setAsk] = useState(false);
  const me = B().user;
  return html`<div class="note ${n.is_pinned ? 'pinned' : ''}">
    <div class="row small muted"><strong>${userName(n.created_by) || 'Nota'}</strong><span>${fmtTime(n.created_at)}</span><span class="spacer"></span>
      <button class="btn ghost sm" onClick=${() => patch(`/notes/${n.id}`, { is_pinned: !n.is_pinned }).catch(fail)}>${n.is_pinned ? 'Desafixar' : 'Fixar'}</button>
      ${(n.created_by === me.id || me.is_admin) && html`<button class="btn ghost sm" onClick=${() => setAsk(true)}>Apagar</button>`}</div>
    ${n.body}
    ${ask && html`<${Confirm} title="Apagar nota?" text="Isso não pode ser desfeito." danger okLabel="Apagar" onOk=${() => del(`/notes/${n.id}`)} onClose=${() => setAsk(false)} />`}
  </div>`;
}

export function Feed({ items }) {
  const ref = useRef();
  const last = items[items.length - 1];
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [items.length, last?.id, last?.status]);
  const pinned = items.filter((i) => i.t === 'note' && i.is_pinned);
  let prevDay = null;
  return html`<div class="feed" ref=${ref} aria-live="polite">
    ${pinned.length > 0 && html`<div class="col">${pinned.map((n) => html`<${NoteItem} key=${'p' + n.id} n=${n} />`)}</div>`}
    ${!items.length && html`<div class="empty"><h3>Nada por aqui ainda</h3><p>Escreva uma nota, crie uma tarefa ou responda o cliente.</p></div>`}
    ${items.map((i) => {
      const d = dayKey(i.created_at);
      const sep = d !== prevDay ? html`<div class="day">${fmtDay(i.created_at)}</div>` : null;
      prevDay = d;
      const body = i.t === 'message' ? html`<${Bubble} m=${i} />` : i.t === 'note' ? html`<${NoteItem} n=${i} />` : i.t === 'task' ? html`<${TaskItem} k=${i} />`
        : html`<div class="event">${fmtTime(i.created_at)} · ${eventText(i)}</div>`;
      return html`${sep}<div key=${i.t + i.id} style=${i.t === 'message' ? 'display:flex;flex-direction:column' : ''}>${body}</div>`;
    })}
  </div>`;
}

// Caixa de envio. conversations: [{id, channel, status, last_inbound_at}] (vazio = sem aba de mensagem)

// Envia mensagem modelo (template) do WhatsApp para um contato.
export function TemplateSend({ contactId, leadId, contactName, onClose, onSent }) {
  const [list, setList] = useState(null);
  const [tid, setTid] = useState(null);
  const [params, setParams] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/templates').then((l) => { const ok = l.filter((t) => t.status === 'APPROVED' && t.supported); setList(ok); if (ok[0]) setTid(ok[0].id); }).catch(fail); }, []);
  const tpl = list?.find((t) => t.id === tid);
  useEffect(() => { if (tpl) setParams(tpl.vars.map((v, i) => (i === 0 ? String(contactName || '').split(' ')[0] : ''))); }, [tid]);
  const body = tpl ? (tpl.components.find((c) => c.type === 'BODY')?.text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => params[tpl.vars.indexOf(v)] || `{{${v}}}`) : '';
  const send = async () => {
    setBusy(true);
    try {
      const r = await post('/whatsapp/template', { template_id: tid, contact_id: contactId, lead_id: leadId, params });
      if (r.status === 'failed') fail(new Error(r.error || 'A Meta recusou'));
      onSent?.(r);
      onClose();
    } catch (e) { fail(e); setBusy(false); }
  };
  return html`<${Modal} title="Mensagem modelo do WhatsApp" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancelar</button>
    <button class="btn primary" disabled=${busy || !tpl || params.some((p) => !p.trim())} onClick=${send}>${busy ? 'Enviando…' : 'Enviar'}</button>`}>
    ${!list && html`<p class="muted">Carregando modelos…</p>`}
    ${list && !list.length && html`<div class="col"><p>Nenhum modelo aprovado ainda.</p>
      <p class="small muted">Crie em Configurações > Modelos do WhatsApp. A Meta costuma aprovar em minutos.</p>
      ${B().user.is_admin && html`<a class="btn" href="#/settings/templates" onClick=${onClose}>Ir para modelos</a>`}</div>`}
    ${list?.length > 0 && html`<div class="form">
      <label class="field">Modelo<select value=${tid} onChange=${(e) => setTid(Number(e.target.value))}>${list.map((t) => html`<option value=${t.id}>${t.name} (${t.language})</option>`)}</select></label>
      ${tpl?.vars.map((v, i) => html`<label class="field">Variável {{${v}}}<input value=${params[i] || ''} onInput=${(e) => { const n = [...params]; n[i] = e.target.value; setParams(n); }} /></label>`)}
      <div class="field">Como o cliente vai ver<div class="bubble out" style="max-width:100%">${body}</div></div>
    </div>`}
  <//>`;
}

export function Composer({ entity, entityId, conversations = [], disabled, onSent, contactId, contactName, leadId }) {
  const [tplOpen, setTplOpen] = useState(false);
  const open = conversations.filter((c) => c.status === 'open');
  const [tab, setTab] = useState(open.length ? 'msg' : 'note');
  const [convId, setConvId] = useState(open[0]?.id || conversations[0]?.id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState({ type_id: B().task_types[0]?.id, due_at: endOfDay(0), responsible_id: B().user.id });
  const fileRef = useRef();
  useEffect(() => { if (!conversations.find((c) => c.id === convId)) setConvId(open[0]?.id || conversations[0]?.id); }, [conversations.map((c) => c.id + c.status).join()]);
  const conv = conversations.find((c) => c.id === convId);
  const windowClosed = conv?.channel === 'whatsapp' && (!conv.last_inbound_at || Date.now() - conv.last_inbound_at > 24 * 3600e3);

  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      if (tab === 'msg') await post(`/conversations/${convId}/messages`, { text });
      else if (tab === 'note') await post('/notes', { entity, entity_id: entityId, body: text });
      else await post('/tasks', { entity, entity_id: entityId, text, ...task });
      setText('');
      onSent?.();
    } catch (e) { fail(e); }
    setBusy(false);
  };
  const sendFile = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      await api(`/conversations/${convId}/messages`, { method: 'POST', raw: true, body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-caption': encodeURIComponent(text) } });
      setText('');
      onSent?.();
    } catch (e) { fail(e); }
    setBusy(false);
    fileRef.current.value = '';
  };
  const reopen = () => patch(`/conversations/${convId}`, { status: 'open' }).catch(fail);

  if (disabled) return html`<div class="composer muted small">Você pode ver, mas não editar este registro.</div>`;
  return html`<div class="composer" onDragOver=${(e) => tab === 'msg' && e.preventDefault()} onDrop=${(e) => { if (tab !== 'msg') return; e.preventDefault(); sendFile(e.dataTransfer.files[0]); }}>
    <div class="tabs" role="tablist">
      ${conversations.length > 0 && html`<button role="tab" aria-selected=${tab === 'msg'} onClick=${() => setTab('msg')}>Mensagem</button>`}
      <button role="tab" aria-selected=${tab === 'note'} onClick=${() => setTab('note')}>Nota</button>
      <button role="tab" aria-selected=${tab === 'task'} onClick=${() => setTab('task')}>Tarefa</button>
      ${tab === 'msg' && conversations.length > 1 && html`<select class="sm" aria-label="Conversa" style="margin-left:auto" value=${convId} onChange=${(e) => setConvId(Number(e.target.value))}>
        ${conversations.map((c) => html`<option value=${c.id}>${c.channel_name || c.channel} ${c.status === 'closed' ? '(fechada)' : ''}</option>`)}</select>`}
    </div>
    ${tab === 'msg' && conv?.status === 'closed' && html`<div class="banner info row">Conversa fechada.<span class="spacer"></span><button class="btn sm" onClick=${reopen}>Reabrir</button></div>`}
    ${tab === 'msg' && conv?.status !== 'closed' && windowClosed && html`<div class="banner warn row wrap">O cliente não escreve há mais de 24 h. O WhatsApp só entrega mensagem modelo aprovada até ele responder.
      ${contactId && html`<span class="spacer"></span><button class="btn sm" onClick=${() => setTplOpen(true)}>Enviar mensagem modelo</button>`}</div>`}
    ${tplOpen && html`<${TemplateSend} contactId=${contactId} leadId=${leadId} contactName=${contactName} onClose=${() => setTplOpen(false)} onSent=${onSent} />`}
    ${tab === 'task' && html`<div class="row wrap">
      <select aria-label="Tipo" value=${task.type_id} onChange=${(e) => setTask({ ...task, type_id: Number(e.target.value) })}>${B().task_types.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select>
      <input type="datetime-local" aria-label="Prazo" value=${toLocalInput(task.due_at)} onInput=${(e) => e.target.value && setTask({ ...task, due_at: new Date(e.target.value).getTime() })} />
      <button class="btn sm" onClick=${() => setTask({ ...task, due_at: endOfDay(0) })}>Hoje</button>
      <button class="btn sm" onClick=${() => setTask({ ...task, due_at: endOfDay(1) })}>Amanhã</button>
      <button class="btn sm" onClick=${() => setTask({ ...task, due_at: endOfDay(3) })}>Em 3 dias</button>
      <${UserSelect} label="Responsável pela tarefa" none=${false} value=${task.responsible_id} onChange=${(v) => setTask({ ...task, responsible_id: v })} />
    </div>`}
    <textarea aria-label=${tab === 'msg' ? 'Mensagem' : tab === 'note' ? 'Nota' : 'Descrição da tarefa'} disabled=${tab === 'msg' && conv?.status === 'closed'}
      placeholder=${tab === 'msg' ? 'Escreva para o cliente… (Ctrl+Enter envia)' : tab === 'note' ? 'Nota interna, o cliente não vê' : 'O que precisa ser feito?'}
      value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}></textarea>
    <div class="row">
      ${tab === 'msg' && html`<input type="file" ref=${fileRef} class="sr-only" id="file-${entityId}" onChange=${(e) => sendFile(e.target.files[0])} />
        <label for="file-${entityId}" class="btn" title="Anexar arquivo" tabindex="0" onKeyDown=${(e) => e.key === 'Enter' && fileRef.current.click()}>📎 Arquivo</label>`}
      <span class="spacer"></span>
      <button class="btn primary" disabled=${busy || !text.trim() || (tab === 'msg' && conv?.status === 'closed')} onClick=${send}>
        ${busy ? 'Enviando…' : tab === 'msg' ? 'Enviar' : tab === 'note' ? 'Salvar nota' : 'Criar tarefa'}</button>
    </div>
  </div>`;
}

