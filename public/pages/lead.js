import { html, useState, useEffect, api, post, patch, del, fail, toast, B, go, money, parseMoney, useData, useDebounced, Modal, Confirm, UserSelect, StageSelect, TagEditor, Fields, Skeleton, ErrorBox, stageById } from '../lib.js';
import { Feed, Composer, TemplateSend } from './feed.js';
import { LossModal } from './leads.js';

export function ContactPicker({ onPick, onClose, title = 'Adicionar contato' }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [nw, setNw] = useState({ name: '', phone: '', email: '' });
  const { data } = useData(() => (dq.length >= 2 ? api(`/contacts?q=${encodeURIComponent(dq)}`) : Promise.resolve([])), [dq]);
  return html`<${Modal} title=${title} onClose=${onClose}>
    <div class="col">
      <label class="field">Buscar contato existente<input autofocus type="search" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Nome, telefone ou email" /></label>
      ${(data || []).map((c) => html`<button class="btn" style="justify-content:flex-start" onClick=${() => onPick({ contact_id: c.id })}>${c.name} <span class="muted small">${c.phones[0] || c.emails[0] || ''}</span></button>`)}
      ${dq.length >= 2 && data && !data.length && html`<p class="small muted">Nenhum contato com "${dq}".</p>`}
      <div class="section-title">Ou crie um novo</div>
      <form class="form" onSubmit=${(e) => { e.preventDefault(); onPick({ name: nw.name, phones: nw.phone ? [nw.phone] : [], emails: nw.email ? [nw.email] : [] }); }}>
        <label class="field">Nome<input value=${nw.name} onInput=${(e) => setNw({ ...nw, name: e.target.value })} /></label>
        <div class="row wrap"><label class="field grow">Telefone<input type="tel" value=${nw.phone} onInput=${(e) => setNw({ ...nw, phone: e.target.value })} /></label>
          <label class="field grow">Email<input type="email" value=${nw.email} onInput=${(e) => setNw({ ...nw, email: e.target.value })} /></label></div>
        <button class="btn primary" disabled=${!nw.name.trim()}>Criar e vincular</button>
      </form>
    </div>
  <//>`;
}

export function CompanyPicker({ value, onChange, disabled }) {
  const [q, setQ] = useState(value?.name || '');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q);
  useEffect(() => setQ(value?.name || ''), [value?.id]);
  const { data } = useData(() => (open ? api(`/companies?q=${encodeURIComponent(dq)}`) : Promise.resolve([])), [dq, open]);
  const pick = async (c) => { setOpen(false); onChange(c); };
  return html`<div style="position:relative">
    <input aria-label="Empresa" disabled=${disabled} value=${q} placeholder="Sem empresa" onFocus=${() => setOpen(true)} onBlur=${() => setTimeout(() => setOpen(false), 200)}
      onInput=${(e) => setQ(e.target.value)} style="width:100%" />
    ${open && html`<div class="card" style="position:absolute;z-index:5;left:0;right:0;max-height:220px;overflow:auto">
      ${(data || []).map((c) => html`<button class="btn ghost" style="width:100%;justify-content:flex-start" onMouseDown=${() => pick(c)}>${c.name}</button>`)}
      ${q.trim() && !(data || []).some((c) => c.name.toLowerCase() === q.trim().toLowerCase()) && html`<button class="btn ghost" style="width:100%;justify-content:flex-start"
        onMouseDown=${async () => { try { const r = await post('/companies', { name: q.trim() }); pick({ id: r.id, name: q.trim() }); } catch (e) { fail(e); } }}>+ Criar empresa "${q.trim()}"</button>`}
      ${value && html`<button class="btn ghost" style="width:100%;justify-content:flex-start" onMouseDown=${() => pick(null)}>Tirar empresa</button>`}
    </div>`}
  </div>`;
}

export function ContactBox({ c, onUnlink, main, leadId }) {
  const [tpl, setTpl] = useState(false);
  const wa = B().channels.some((ch) => ch.kind === 'whatsapp' && ch.status !== 'disabled');
  return html`<div class="contact-box">
    <div class="row"><a href=${`#/contact/${c.id}`} class="grow"><strong>${c.name}</strong></a>${main && html`<span class="pill xs">principal</span>`}
      ${onUnlink && html`<button class="btn ghost sm" aria-label=${`Desvincular ${c.name}`} onClick=${onUnlink}>✕</button>`}</div>
    ${c.phones.map((p) => html`<a class="small" href=${`tel:${p}`}>📞 ${p}</a>`)}
    ${c.emails.map((m) => html`<a class="small" href=${`mailto:${m}`}>✉ ${m}</a>`)}
    ${wa && c.phones.length > 0 && html`<button class="btn sm" style="align-self:flex-start" onClick=${() => setTpl(true)}>Chamar no WhatsApp</button>`}
    ${tpl && html`<${TemplateSend} contactId=${c.id} leadId=${leadId} contactName=${c.name} onClose=${() => setTpl(false)} />`}
  </div>`;
}

export function LeadPage({ id }) {
  const { data: l, error, reload } = useData(() => api(`/leads/${id}`), [id], ['lead', 'message', 'task', 'contact', 'config']);
  const [loss, setLoss] = useState(false);
  const [pick, setPick] = useState(false);
  const [askDel, setAskDel] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  useEffect(() => { if (l) { setName(l.name); setPrice(l.price_cents ? money(l.price_cents) : ''); } }, [l?.name, l?.price_cents]);
  useEffect(() => { l?.conversations.filter((c) => c.unread > 0).forEach((c) => patch(`/conversations/${c.id}`, { read: true }).catch(() => {})); }, [l?.feed.length]);

  if (error) return html`<div class="main"><${ErrorBox} error=${error} retry=${reload} /></div>`;
  if (!l) return html`<div class="main"><div class="page"><${Skeleton} rows=${6} /></div></div>`;
  const save = (b) => patch(`/leads/${l.id}`, b).then(reload).catch((e) => { fail(e); reload(); });
  const stage = stageById(l.stage_id);
  const ro = !l.can_edit;
  const setStage = (sid) => { const s = stageById(sid); if (s.kind === 'lost') setLoss(sid); else save({ stage_id: sid }).then(() => s.kind === 'won' && toast('Venda fechada! 🎉')); };
  const reason = B().loss_reasons.find((r) => r.id === l.loss_reason_id);

  return html`<div class="main"><div class="detail">
    <aside class="detail-side col" aria-label="Dados do lead">
      <div class="row"><a href=${`#/leads?pipeline=${l.pipeline_id}`} class="small">← ${stage?.pipeline.name}</a><span class="spacer"></span><span class="xs muted">#${l.id}</span></div>
      <label class="sr-only" for="lead-name">Nome do lead</label>
      <input id="lead-name" class="title-input plain" disabled=${ro} value=${name} onInput=${(e) => setName(e.target.value)} onBlur=${() => name.trim() && name !== l.name && save({ name })} />
      <div class="kv">
        <label for="st" class="small muted">Etapa</label><${StageSelect} id="st" disabled=${ro} value=${l.stage_id} onChange=${setStage} />
        ${stage?.kind === 'lost' && html`<span>Motivo</span><span class="pill danger">${reason?.name || '—'}</span>`}
        <label for="price" class="small muted">Valor</label><input id="price" disabled=${ro} inputmode="decimal" placeholder="R$ 0" value=${price} onInput=${(e) => setPrice(e.target.value)}
          onBlur=${() => parseMoney(price) !== l.price_cents && save({ price_cents: parseMoney(price) })} />
        <label for="resp" class="small muted">Responsável</label><${UserSelect} id="resp" disabled=${ro} value=${l.responsible_id} onChange=${(v) => save({ responsible_id: v })} />
        <span>Empresa</span><${CompanyPicker} disabled=${ro} value=${l.company} onChange=${(c) => save({ company_id: c?.id || null })} />
      </div>
      <div class="section-title">Tags</div>
      <${TagEditor} disabled=${ro} tags=${l.tags} onChange=${(tags) => save({ tags })} />
      <${Fields} entity="lead" values=${l.fields} disabled=${ro} onSave=${(fields) => save({ fields })} />
      <div class="section-title row"><span class="grow">Contatos</span>${!ro && html`<button class="btn sm" onClick=${() => setPick(true)}>+ Contato</button>`}</div>
      ${l.contacts.map((c) => html`<${ContactBox} c=${c} leadId=${l.id} main=${c.is_main} onUnlink=${ro ? null : () => del(`/leads/${l.id}/contacts/${c.id}`).then(reload).catch(fail)} />`)}
      ${!l.contacts.length && html`<p class="small muted">Nenhum contato vinculado.</p>`}
      ${l.can_delete && html`<div style="margin-top:auto;padding-top:24px"><button class="btn danger sm" onClick=${() => setAskDel(true)}>Apagar lead</button></div>`}
    </aside>
    <section class="detail-main" aria-label="Histórico">
      <${Feed} items=${l.feed} />
      <${Composer} entity="lead" entityId=${l.id} conversations=${l.conversations} disabled=${ro} onSent=${reload}
        leadId=${l.id} contactId=${l.contacts[0]?.id} contactName=${l.contacts[0]?.name} />
    </section>
  </div>
  ${loss && html`<${LossModal} onClose=${() => setLoss(false)} onOk=${(r) => save({ stage_id: loss, loss_reason_id: r })} />`}
  ${pick && html`<${ContactPicker} onClose=${() => setPick(false)} onPick=${(b) => post(`/leads/${l.id}/contacts`, b).then(() => { setPick(false); reload(); }).catch(fail)} />`}
  ${askDel && html`<${Confirm} title="Apagar este lead?" text="O lead some do funil. Contatos e conversas continuam." danger okLabel="Apagar"
    onOk=${() => del(`/leads/${l.id}`).then(() => go(`#/leads?pipeline=${l.pipeline_id}`))} onClose=${() => setAskDel(false)} />`}
  </div>`;
}
