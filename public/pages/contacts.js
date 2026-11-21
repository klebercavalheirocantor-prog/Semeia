import { html, useState, useEffect, api, post, patch, del, fail, B, go, money, ago, useData, useDebounced, Modal, Confirm, UserSelect, TagEditor, Fields, Skeleton, ErrorBox, Empty, stageById, userName, Channel } from '../lib.js';
import { Feed, Composer, TemplateSend } from './feed.js';
import { CompanyPicker, ContactBox } from './lead.js';
import { NewLeadModal } from './leads.js';

function ListEditor({ label, values, onSave, type, disabled }) {
  const [list, setList] = useState(values.length ? values : ['']);
  useEffect(() => setList(values.length ? values : ['']), [values.join()]);
  const commit = (l) => { const clean = l.map((x) => x.trim()).filter(Boolean); if (clean.join() !== values.join()) onSave(clean); };
  return html`<div class="col" style="gap:4px">
    ${list.map((v, i) => html`<div class="row"><input class="grow" type=${type} disabled=${disabled} aria-label=${label} value=${v}
      onInput=${(e) => { const n = [...list]; n[i] = e.target.value; setList(n); }} onBlur=${() => commit(list)} />
      ${list.length > 1 && !disabled && html`<button class="btn ghost sm" aria-label="Remover" onClick=${() => { const n = list.filter((_, j) => j !== i); setList(n); commit(n); }}>✕</button>`}</div>`)}
    ${!disabled && html`<button class="btn ghost sm" style="align-self:flex-start" onClick=${() => setList([...list, ''])}>+ ${label}</button>`}
  </div>`;
}

function LeadsList({ leads }) {
  if (!leads.length) return html`<p class="small muted">Nenhum lead.</p>`;
  return leads.map((l) => { const s = stageById(l.stage_id); return html`<a href=${`#/lead/${l.id}`} class="contact-box" style="color:inherit">
    <strong>${l.name}</strong><span class="row small"><span class="pill" style=${`border-color:${s?.color}`}>${s?.name}</span>${money(l.price_cents)}</span></a>`; });
}

function NewContactModal({ onClose }) {
  const [f, setF] = useState({ name: '', phone: '', email: '' });
  const [company, setCompany] = useState(null);
  const save = (e) => { e.preventDefault(); post('/contacts', { name: f.name, phones: f.phone ? [f.phone] : [], emails: f.email ? [f.email] : [], company_id: company?.id })
    .then((r) => { onClose(); go(`#/contact/${r.id}`); }).catch(fail); };
  return html`<${Modal} title="Novo contato" onClose=${onClose}><form class="form" onSubmit=${save}>
    <label class="field">Nome<input autofocus value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></label>
    <label class="field">Telefone<input type="tel" value=${f.phone} onInput=${(e) => setF({ ...f, phone: e.target.value })} /></label>
    <label class="field">Email<input type="email" value=${f.email} onInput=${(e) => setF({ ...f, email: e.target.value })} /></label>
    <div class="field small muted">Empresa<${CompanyPicker} value=${company} onChange=${setCompany} /></div>
    <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancelar</button><button class="btn primary" disabled=${!f.name.trim()}>Criar</button></div>
  </form><//>`;
}


function ImportModal({ onClose }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const send = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      setRes(await api('/import/contacts', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) } }));
    } catch (e) { fail(e); }
    setBusy(false);
  };
  return html`<${Modal} title="Importar contatos" onClose=${onClose} wide>
    ${res ? html`<div class="col">
      <p><strong>${res.created}</strong> contatos novos · <strong>${res.updated}</strong> já existiam e ganharam telefone/email · ${res.skipped} ignorados (repetidos ou vazios)</p>
      <button class="btn primary" style="align-self:flex-start" onClick=${onClose}>Ver contatos</button></div>`
    : html`<div class="col">
      <p class="small">Quem já existe (mesmo telefone ou email) não é duplicado. Nenhuma mensagem é enviada.</p>
      <div class="small"><strong>Etiquetas:</strong> uma coluna <code>tags</code> (ex.: <code>Agro; Produtor MT</code>) coloca as etiquetas nos contatos, inclusive nos que já existem.</div>
      <div class="small"><strong>Android:</strong> app Contatos > Corrigir e gerenciar (ou Configurações) > Exportar para arquivo. Gera um <code>.vcf</code>.</div>
      <div class="small"><strong>iPhone:</strong> em icloud.com/contacts, selecione tudo (Ctrl+A) > ⚙ > Exportar vCard.</div>
      <div class="small"><strong>Google Contatos:</strong> contacts.google.com > Exportar > CSV do Google.</div>
      <div class="small"><strong>Excel:</strong> salve como CSV com colunas <code>nome</code>, <code>telefone</code>, <code>email</code>, <code>empresa</code>.</div>
      <label class="btn primary" style="align-self:flex-start" tabindex="0">${busy ? 'Importando…' : 'Escolher arquivo'}
        <input type="file" class="sr-only" accept=".vcf,.csv,.txt" disabled=${busy} onChange=${(e) => send(e.target.files[0])} /></label>
    </div>`}
  <//>`;
}

const PAGE = 200;
export function ContactsPage() {
  const [imp, setImp] = useState(false);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const dq = useDebounced(q);
  const [nw, setNw] = useState(false);
  useEffect(() => setLimit(PAGE), [dq, tag]);
  const qs = new URLSearchParams({ with_total: '1', limit: String(Math.min(limit, 500)), ...(dq && { q: dq }), ...(tag && tag !== '__optout' && { tag }), ...(tag === '__optout' && { optout: '1' }) });
  const { data, error, reload } = useData(() => (limit <= 500 ? api(`/contacts?${qs}`)
    : Promise.all(Array.from({ length: Math.ceil(limit / 500) }, (_, i) => api(`/contacts?${new URLSearchParams({ ...Object.fromEntries(qs), limit: '500', offset: String(i * 500) })}`)))
      .then((pages) => ({ total: pages[0].total, rows: pages.flatMap((p) => p.rows) }))), [dq, tag, limit], ['contact', 'lead']);
  const rows = data?.rows;
  return html`<div class="main">
    <div class="topbar"><div class="grow"><h1>Contatos</h1>${data && html`<div class="xs muted">${data.total.toLocaleString('pt-BR')} ${tag || dq ? 'encontrados' : 'contatos'}</div>`}</div>
      <select aria-label="Filtrar por etiqueta" value=${tag} onChange=${(e) => setTag(e.target.value)}>
        <option value="">Todas as etiquetas</option>${(B().tags || []).map((t) => html`<option value=${t.name}>${t.name}</option>`)}<option value="__optout">Pediram para sair</option></select>
      <input type="search" aria-label="Buscar contatos" placeholder="Nome, telefone ou email" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <a class="btn" href="#/companies">Empresas</a><button class="btn" onClick=${() => setImp(true)}>Importar</button><button class="btn primary" onClick=${() => setNw(true)}>+ Contato</button></div>
    <div class="page" style="padding:0">
      ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
      ${!data && !error && html`<div class="page"><${Skeleton} /></div>`}
      ${rows && !rows.length && html`<${Empty} title=${dq || tag ? 'Nenhum contato encontrado' : 'Nenhum contato ainda'}><p>Contatos são criados sozinhos quando um cliente escreve, ou aqui.</p><//>`}
      ${rows?.length > 0 && html`<table class="t"><thead><tr><th>Nome</th><th>Telefone</th><th class="hide-sm">Email</th><th class="hide-sm">Etiquetas</th><th class="hide-sm">Leads</th><th class="hide-sm">Responsável</th></tr></thead>
        <tbody>${rows.map((c) => html`<tr><td><a href=${`#/contact/${c.id}`}>${c.name}</a>${c.opt_out_at && html` <span class="pill r-optout" title="Pediu para sair das campanhas">saiu</span>`}</td><td>${c.phones[0] || ''}</td><td class="hide-sm">${c.emails[0] || ''}</td>
          <td class="hide-sm">${c.tags.map((n) => html`<span class="tag">${n}</span> `)}</td><td class="hide-sm">${c.leads_count}</td><td class="hide-sm">${userName(c.responsible_id)}</td></tr>`)}</tbody></table>
        ${rows.length < data.total && html`<div class="row" style="justify-content:center;padding:16px"><button class="btn" onClick=${() => setLimit(limit + PAGE)}>Carregar mais (${rows.length.toLocaleString('pt-BR')} de ${data.total.toLocaleString('pt-BR')})</button></div>`}`}
    </div>
    ${nw && html`<${NewContactModal} onClose=${() => setNw(false)} />`}
    ${imp && html`<${ImportModal} onClose=${() => { setImp(false); reload(); }} />`}
  </div>`;
}

export function ContactPage({ id }) {
  const { data: c, error, reload } = useData(() => api(`/contacts/${id}`), [id], ['contact', 'lead', 'task', 'message', 'config']);
  const [name, setName] = useState('');
  const [newLead, setNewLead] = useState(false);
  const [askDel, setAskDel] = useState(false);
  const [tpl, setTpl] = useState(false);
  useEffect(() => c && setName(c.name), [c?.name]);
  if (error) return html`<div class="main"><${ErrorBox} error=${error} retry=${reload} /></div>`;
  if (!c) return html`<div class="main"><div class="page"><${Skeleton} rows=${6} /></div></div>`;
  const ro = !c.can_edit;
  const save = (b) => patch(`/contacts/${c.id}`, b).then(reload).catch((e) => { fail(e); reload(); });
  return html`<div class="main"><div class="detail">
    <aside class="detail-side col" aria-label="Dados do contato">
      <a href="#/contacts" class="small">← Contatos</a>
      <input class="title-input plain" aria-label="Nome" disabled=${ro} value=${name} onInput=${(e) => setName(e.target.value)} onBlur=${() => name.trim() && name !== c.name && save({ name })} />
      <div class="kv">
        <span>Telefones</span><${ListEditor} label="telefone" type="tel" disabled=${ro} values=${c.phones} onSave=${(phones) => save({ phones })} />
        <span>Emails</span><${ListEditor} label="email" type="email" disabled=${ro} values=${c.emails} onSave=${(emails) => save({ emails })} />
        <span>Empresa</span><${CompanyPicker} disabled=${ro} value=${c.company} onChange=${(co) => save({ company_id: co?.id || null })} />
        <label class="small muted" for="cresp">Responsável</label><${UserSelect} id="cresp" disabled=${ro} value=${c.responsible_id} onChange=${(v) => save({ responsible_id: v })} />
      </div>
      <div class="section-title">Tags</div><${TagEditor} disabled=${ro} tags=${c.tags} onChange=${(tags) => save({ tags })} />
      <label class="row small" style="margin-top:8px"><input type="checkbox" disabled=${ro} checked=${!c.opt_out_at} onChange=${(e) => save({ opt_out: !e.target.checked })} />Recebe campanhas${c.opt_out_at && html` <span class="xs muted">(pediu para sair em ${new Date(c.opt_out_at).toLocaleDateString('pt-BR')})</span>`}</label>
      <${Fields} entity="contact" values=${c.fields} disabled=${ro} onSave=${(fields) => save({ fields })} />
      ${B().channels.some((ch) => ch.kind === 'whatsapp' && ch.status !== 'disabled') && c.phones.length > 0 && html`<button class="btn" style="margin-top:8px" onClick=${() => setTpl(true)}>Chamar no WhatsApp</button>`}
      <div class="section-title row"><span class="grow">Leads</span><button class="btn sm" onClick=${() => setNewLead(true)}>+ Lead</button></div>
      <${LeadsList} leads=${c.leads} />
      ${c.conversations.length > 0 && html`<div class="section-title">Conversas</div>${c.conversations.map((cv) => html`<a href=${`#/chats/${cv.id}`} class="row small"><${Channel} kind=${cv.channel} /> Conversa ${cv.status === 'open' ? 'aberta' : 'fechada'}</a>`)}`}
      ${c.can_delete && html`<div style="padding-top:24px"><button class="btn danger sm" onClick=${() => setAskDel(true)}>Apagar contato</button></div>`}
    </aside>
    <section class="detail-main" aria-label="Histórico"><${Feed} items=${c.feed} /><${Composer} entity="contact" entityId=${c.id} disabled=${ro} onSent=${reload} /></section>
  </div>
  ${newLead && html`<${NewLeadModal} contact=${c} onClose=${() => setNewLead(false)} />`}
  ${tpl && html`<${TemplateSend} contactId=${c.id} contactName=${c.name} onClose=${() => setTpl(false)} onSent=${reload} />`}
  ${askDel && html`<${Confirm} title="Apagar contato?" text="O telefone e o email ficam livres para outro contato. Os leads continuam." danger okLabel="Apagar"
    onOk=${() => del(`/contacts/${c.id}`).then(() => go('#/contacts'))} onClose=${() => setAskDel(false)} />`}
  </div>`;
}

export function CompaniesPage() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [nw, setNw] = useState('');
  const { data, error, reload } = useData(() => api(`/companies${dq ? `?q=${encodeURIComponent(dq)}` : ''}`), [dq], ['company', 'contact', 'lead']);
  const create = (e) => { e.preventDefault(); post('/companies', { name: nw }).then((r) => go(`#/company/${r.id}`)).catch(fail); };
  return html`<div class="main">
    <div class="topbar"><h1 class="grow">Empresas</h1><input type="search" aria-label="Buscar empresas" placeholder="Buscar" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <a class="btn" href="#/contacts">Contatos</a>
      <form class="row" onSubmit=${create}><input aria-label="Nome da nova empresa" placeholder="Nova empresa" value=${nw} onInput=${(e) => setNw(e.target.value)} /><button class="btn primary" disabled=${!nw.trim()}>Criar</button></form></div>
    <div class="page" style="padding:0">
      ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
      ${!data && !error && html`<div class="page"><${Skeleton} /></div>`}
      ${data && !data.length && html`<${Empty} title="Nenhuma empresa" />`}
      ${data?.length > 0 && html`<table class="t"><thead><tr><th>Empresa</th><th>Contatos</th><th>Leads</th><th class="hide-sm">Responsável</th></tr></thead>
        <tbody>${data.map((c) => html`<tr><td><a href=${`#/company/${c.id}`}>${c.name}</a></td><td>${c.contacts_count}</td><td>${c.leads_count}</td><td class="hide-sm">${userName(c.responsible_id)}</td></tr>`)}</tbody></table>`}
    </div></div>`;
}

export function CompanyPage({ id }) {
  const { data: c, error, reload } = useData(() => api(`/companies/${id}`), [id], ['company', 'contact', 'lead', 'task', 'config']);
  const [name, setName] = useState('');
  const [askDel, setAskDel] = useState(false);
  useEffect(() => c && setName(c.name), [c?.name]);
  if (error) return html`<div class="main"><${ErrorBox} error=${error} retry=${reload} /></div>`;
  if (!c) return html`<div class="main"><div class="page"><${Skeleton} rows=${6} /></div></div>`;
  const ro = !c.can_edit;
  const save = (b) => patch(`/companies/${c.id}`, b).then(reload).catch((e) => { fail(e); reload(); });
  return html`<div class="main"><div class="detail">
    <aside class="detail-side col" aria-label="Dados da empresa">
      <a href="#/companies" class="small">← Empresas</a>
      <input class="title-input plain" aria-label="Nome" disabled=${ro} value=${name} onInput=${(e) => setName(e.target.value)} onBlur=${() => name.trim() && name !== c.name && save({ name })} />
      <div class="kv"><label class="small muted" for="coresp">Responsável</label><${UserSelect} id="coresp" disabled=${ro} value=${c.responsible_id} onChange=${(v) => save({ responsible_id: v })} /></div>
      <div class="section-title">Tags</div><${TagEditor} disabled=${ro} tags=${c.tags} onChange=${(tags) => save({ tags })} />
      <${Fields} entity="company" values=${c.fields} disabled=${ro} onSave=${(fields) => save({ fields })} />
      <div class="section-title">Contatos</div>${c.contacts.map((ct) => html`<${ContactBox} c=${ct} />`)}${!c.contacts.length && html`<p class="small muted">Nenhum contato.</p>`}
      <div class="section-title">Leads</div><${LeadsList} leads=${c.leads} />
      ${c.can_delete && html`<div style="padding-top:24px"><button class="btn danger sm" onClick=${() => setAskDel(true)}>Apagar empresa</button></div>`}
    </aside>
    <section class="detail-main" aria-label="Histórico"><${Feed} items=${c.feed} /><${Composer} entity="company" entityId=${c.id} disabled=${ro} onSent=${reload} /></section>
  </div>
  ${askDel && html`<${Confirm} title="Apagar empresa?" text="Contatos e leads continuam, só perdem o vínculo." danger okLabel="Apagar"
    onOk=${() => del(`/companies/${c.id}`).then(() => go('#/companies'))} onClose=${() => setAskDel(false)} />`}
  </div>`;
}
