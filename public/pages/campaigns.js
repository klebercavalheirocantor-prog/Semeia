import { html, useState, useEffect, api, post, patch, del, fail, toast, B, go, ago, fmtDateTime, useData, useDebounced, Confirm, Skeleton, ErrorBox, Empty } from '../lib.js';

const STATUS = { draft: ['Rascunho', ''], running: ['Enviando', 'ok'], paused: ['Pausada', 'warn'], done: ['Concluída', 'done'] };
const RSTATUS = { sent: 'Enviada', failed: 'Falhou', skipped: 'Pulada', replied: 'Respondeu', optout: 'Pediu para sair' };
const num = (n) => (n || 0).toLocaleString('pt-BR');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const Status = ({ s }) => html`<span class=${`pill st-${STATUS[s][1]}`}>${STATUS[s][0]}</span>`;
const fill = (t, name) => String(t || '').replace(/\{\{\s*primeiro_nome\s*\}\}/gi, name).replace(/\{\{\s*nome\s*\}\}/gi, `${name} da Silva`);

function Progress({ st }) {
  const done = st.total - st.queued;
  return html`<div class="progress" title=${`${num(done)} de ${num(st.total)}`}><span style=${`width:${st.total ? (done / st.total) * 100 : 0}%`}></span></div>`;
}

export function CampaignsPage() {
  const { data, error, reload } = useData(() => api('/campaigns'), [], ['campaign']);
  if (!B().user.is_admin) return html`<div class="main"><${Empty} title="Só administradores criam campanhas" /></div>`;
  return html`<div class="main">
    <div class="topbar"><div class="grow"><h1>Campanhas</h1><div class="xs muted">Disparo por WhatsApp (modelo aprovado) e e-mail, um por um, no ritmo que você escolher</div></div>
      <a class="btn primary" href="#/campaign/new">+ Nova campanha</a></div>
    <div class="page" style="padding:0">
      ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
      ${!data && !error && html`<div class="page"><${Skeleton} /></div>`}
      ${data && !data.length && html`<${Empty} title="Nenhuma campanha ainda"><p>Escolha as etiquetas do público, a mensagem e o ritmo. Quem responde vira lead no funil; quem responde SAIR não recebe mais.</p>
        <a class="btn primary" href="#/campaign/new">Criar a primeira</a><//>`}
      ${data?.length > 0 && html`<table class="t"><thead><tr><th>Campanha</th><th>Canal</th><th>Status</th><th class="hide-sm">Público</th><th>Progresso</th><th>Respostas</th><th class="hide-sm">Saíram</th></tr></thead>
        <tbody>${data.map((c) => html`<tr><td><a href=${`#/campaign/${c.id}`}>${c.name}</a><div class="xs muted">${ago(c.updated_at)}</div></td>
          <td>${c.channel === 'email' ? 'E-mail' : 'WhatsApp'}</td><td><${Status} s=${c.status} /></td>
          <td class="hide-sm small">${c.tags.length ? c.tags.join(', ') : 'Todos os contatos'}</td>
          <td style="min-width:140px"><${Progress} st=${c.stats} /><div class="xs muted">${num(c.stats.sent)} de ${num(c.stats.total || 0)}</div></td>
          <td>${num(c.stats.replied)} <span class="xs muted">${pct(c.stats.replied, c.stats.sent)}</span></td><td class="hide-sm">${num(c.stats.optout)}</td></tr>`)}</tbody></table>`}
    </div></div>`;
}

// WhatsApp: mesmo ritmo do WA Web Plus que já funciona (15–30 s, 6h–22h de Brasília, lotes de 310–332 com 2 h de pausa).
const WA_RHYTHM = { interval_seconds: 15, interval_max_seconds: 30, batch_min: 310, batch_max: 332, batch_pause_minutes: 120, mini_every: 50, mini_pause_min: 20, mini_pause_max: 23, window_start: 6, window_end: 22, daily_cap: 1300 };
const EMAIL_RHYTHM = { interval_seconds: 5, interval_max_seconds: '', batch_min: 0, batch_max: 0, batch_pause_minutes: 0, mini_every: 0, mini_pause_min: 0, mini_pause_max: 0, window_start: 8, window_end: 20, daily_cap: 300 };
const EMPTY = { name: '', channel: 'whatsapp', tags: [], template_id: '', params: [], subject: '', body: 'Olá {{primeiro_nome}}, tudo bem?\n\n', ...WA_RHYTHM, skip_recent_days: 7 };
// Quantas mensagens saem num dia com esse ritmo (média do intervalo e do lote, respeitando o limite diário).
function perDay(f) {
  const lo = Number(f.interval_seconds) || 1, hi = Number(f.interval_max_seconds) || lo;
  const avg = (lo + hi) / 2, win = Math.max(0, Number(f.window_end) - Number(f.window_start)) * 3600;
  const batch = Number(f.batch_max) > 0 ? (Number(f.batch_min) + Number(f.batch_max)) / 2 : Infinity, pause = (Number(f.batch_pause_minutes) || 0) * 60;
  const every = Number(f.mini_every) || 0, mini = ((Number(f.mini_pause_min) + (Number(f.mini_pause_max) || Number(f.mini_pause_min))) / 2 || 0) * 60;
  let t = 0, n = 0, k = 0;
  while (t < win && n < Number(f.daily_cap)) {
    n++; k++;
    if (n % Math.round(batch) === 0) { t += pause; k = 0; } else if (every && k >= every) { t += mini; k = 0; } else t += avg;
  }
  return n;
}

function Editor({ camp, onSaved }) {
  const b = B();
  const webChans = (b.channels || []).filter((c) => c.kind === 'whatsapp' && c.mode === 'web' && c.status !== 'disabled');
  const [f, setF] = useState(camp ? { ...camp, template_id: camp.template_id || '', wa_channel_id: camp.wa_channel_id || '' } : { ...EMPTY, wa_channel_id: webChans[0]?.id || '' });
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: tpls } = useData(() => api('/templates'), [], ['config']);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const frozen = camp && camp.status !== 'draft'; // público já congelado
  const dq = useDebounced(JSON.stringify({ channel: f.channel, tags: f.tags, skip_recent_days: Number(f.skip_recent_days) }), 400);
  useEffect(() => { if (!frozen) post('/campaigns/audience', JSON.parse(dq)).then((r) => setCount(r.count)).catch(() => setCount(null)); }, [dq]);
  const approved = (tpls || []).filter((t) => t.status === 'APPROVED' && (t.supported || t.header_media === 'IMAGE'));
  const tpl = approved.find((t) => t.id === Number(f.template_id));
  useEffect(() => { if (tpl && f.params.length !== tpl.vars.length) set('params', tpl.vars.map((_, i) => f.params[i] ?? (i === 0 ? '{{primeiro_nome}}' : ''))); }, [tpl?.id]);
  const hasWa = b.channels?.some((c) => c.kind === 'whatsapp' && c.mode !== 'web');
  const viaWeb = f.channel === 'whatsapp' && webChans.some((c) => c.id === Number(f.wa_channel_id));
  const toggleTag = (n) => set('tags', f.tags.includes(n) ? f.tags.filter((x) => x !== n) : [...f.tags, n]);
  const [uploading, setUploading] = useState(false);
  const pickImage = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const r = await api('/files', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) } });
      set('header_file_id', r.id);
    } catch (e) { fail(e); }
    setUploading(false);
  };
  const payload = () => ({ ...f, wa_channel_id: viaWeb ? Number(f.wa_channel_id) : null, header_file_id: tpl?.header_media || viaWeb || f.channel === 'email' ? f.header_file_id || null : null, template_id: f.template_id ? Number(f.template_id) : null, interval_seconds: Number(f.interval_seconds), window_start: Number(f.window_start),
    interval_max_seconds: Number(f.interval_max_seconds) || null, batch_min: Number(f.batch_min) || 0, batch_max: Number(f.batch_max) || 0, batch_pause_minutes: Number(f.batch_pause_minutes) || 0,
    mini_every: Number(f.mini_every) || 0, mini_pause_min: Number(f.mini_pause_min) || 0, mini_pause_max: Number(f.mini_pause_max) || 0,
    window_end: Number(f.window_end), daily_cap: Number(f.daily_cap), skip_recent_days: Number(f.skip_recent_days) });
  const day = perDay(f);
  const save = async () => {
    setBusy(true);
    try {
      let id = camp?.id;
      if (id) await patch(`/campaigns/${id}`, payload());
      else id = (await post('/campaigns', payload())).id;
      toast('Campanha salva');
      onSaved(id);
    } catch (e) { fail(e); }
    setBusy(false);
  };
  const preview = viaWeb ? fill(f.body, 'João') : f.channel === 'whatsapp'
    ? (tpl ? tpl.preview.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => fill(f.params[tpl.vars.indexOf(v)] ?? '', 'João')) : '')
    : `${fill(f.subject, 'João')}\n\n${fill(f.body, 'João')}`;
  return html`<div class="camp-edit">
    <div class="col" style="gap:var(--s-4)">
      <div class="card pad form"><h2>1. Nome e canal</h2>
        <label class="field">Nome da campanha<input value=${f.name} placeholder="Ex.: Promoção de novembro" onInput=${(e) => set('name', e.target.value)} /></label>
        <div class="row">${['whatsapp', 'email'].map((c) => html`<label class=${`choice ${f.channel === c ? 'on' : ''}`}><input type="radio" name="ch" disabled=${frozen} checked=${f.channel === c}
          onChange=${() => setF((x) => ({ ...x, channel: c, ...(c === 'email' ? EMAIL_RHYTHM : WA_RHYTHM) }))} />${c === 'email' ? 'E-mail' : 'WhatsApp'}</label>`)}</div>
      </div>
      <div class="card pad form"><h2>2. Público</h2>
        <p class="small muted">Contatos com <strong>qualquer uma</strong> das etiquetas marcadas. Nenhuma marcada = todos os contatos.</p>
        <div class="row wrap">${(b.tags || []).map((t) => html`<label class=${`chip-check ${f.tags.includes(t.name) ? 'on' : ''}`}><input type="checkbox" disabled=${frozen} checked=${f.tags.includes(t.name)} onChange=${() => toggleTag(t.name)} />${t.name}</label>`)}</div>
        <label class="field">Não enviar para quem recebeu campanha nos últimos (dias)<input type="number" min="0" disabled=${frozen} value=${f.skip_recent_days} onInput=${(e) => set('skip_recent_days', e.target.value)} /></label>
        ${!frozen && html`<div class="audience">${count == null ? 'Calculando…' : html`<strong>${num(count)}</strong> contatos vão receber`}
          <span class="xs muted"> · ficam de fora quem pediu para sair e quem não tem ${f.channel === 'email' ? 'e-mail' : 'celular'}</span></div>`}
        ${frozen && html`<p class="small muted">O público foi definido quando a campanha começou e não muda mais.</p>`}
      </div>
      <div class="card pad form"><h2>3. Mensagem</h2>
        ${f.channel === 'whatsapp' && html`<label class="field">Enviar por<select value=${String(f.wa_channel_id || '')} disabled=${frozen} onChange=${(e) => set('wa_channel_id', e.target.value)}>
          ${webChans.map((c) => html`<option value=${String(c.id)}>WhatsApp Web${c.me ? ` (${c.me})` : ''}: texto livre, sem modelo</option>`)}
          <option value="">API oficial da Meta: modelo aprovado</option></select></label>`}
        ${viaWeb ? html`
          <label class="field">Mensagem<textarea rows="7" value=${f.body} onInput=${(e) => set('body', e.target.value)}></textarea></label>
          <p class="xs muted">Use <code>{{primeiro_nome}}</code> para chamar pelo nome (fica em branco se o contato for empresa). Com imagem, o texto vai como legenda.</p>
          <div class="field">Imagem (a arte, opcional)
            <div class="row">${f.header_file_id ? html`<img class="camp-img" src=${`/api/files/${f.header_file_id}`} alt="Imagem escolhida para a campanha" />` : html`<span class="small muted">Sem imagem</span>`}
              <label class="btn">${uploading ? 'Enviando…' : f.header_file_id ? 'Trocar imagem' : 'Escolher imagem'}<input type="file" accept="image/jpeg,image/png" class="sr-only" disabled=${uploading} onChange=${(e) => pickImage(e.target.files[0])} /></label>
              ${f.header_file_id && html`<button class="btn sm" onClick=${() => set('header_file_id', null)}>Tirar imagem</button>`}</div></div>`
        : f.channel === 'whatsapp' ? html`
          ${!hasWa && html`<div class="banner warn small">Conecte o WhatsApp em Ajustes › Canais: pelo QR code (WhatsApp Web) ou pela API oficial.</div>`}
          <p class="small muted">Para quem nunca te escreveu, o WhatsApp só aceita <strong>mensagem modelo aprovada pela Meta</strong>. Crie em Ajustes > Modelos do WhatsApp (categoria Marketing).</p>
          <label class="field">Modelo aprovado<select value=${String(f.template_id)} onChange=${(e) => set('template_id', e.target.value)}>
            <option value="">— escolha —</option>${approved.map((t) => html`<option value=${String(t.id)}>${t.name} (${t.language})</option>`)}</select></label>
          ${tpl?.header_media === 'IMAGE' && html`<div class="field">Imagem do topo (a arte)
            <div class="row">${f.header_file_id ? html`<img class="camp-img" src=${`/api/files/${f.header_file_id}`} alt="Imagem escolhida para a campanha" />` : html`<span class="small muted">Nenhuma imagem escolhida</span>`}
              <label class="btn">${uploading ? 'Enviando…' : f.header_file_id ? 'Trocar imagem' : 'Escolher imagem'}<input type="file" accept="image/jpeg,image/png" class="sr-only" disabled=${uploading} onChange=${(e) => pickImage(e.target.files[0])} /></label></div>
            <span class="xs muted">JPG ou PNG até 5 MB. A mesma imagem vai para todos.</span></div>`}
          ${tpl && tpl.vars.map((v, i) => html`<label class="field">Variável {{${v}}}<input value=${f.params[i] || ''} onInput=${(e) => { const p = [...f.params]; p[i] = e.target.value; set('params', p); }} /></label>`)}
          ${tpl?.vars.length > 0 && html`<p class="xs muted">Use <code>{{primeiro_nome}}</code> ou <code>{{nome}}</code> para personalizar. Se o contato for empresa, o primeiro nome fica em branco.</p>`}`
        : html`
          ${!b.email?.has_key && html`<div class="banner warn small">Configure o envio em Ajustes > E-mail antes de iniciar.</div>`}
          <label class="field">Assunto<input value=${f.subject} onInput=${(e) => set('subject', e.target.value)} /></label>
          <label class="field">Texto<textarea rows="8" value=${f.body} onInput=${(e) => set('body', e.target.value)}></textarea></label>
          <div class="field">Imagem no topo do e-mail (a arte, opcional)
            <div class="row">${f.header_file_id ? html`<img class="camp-img" src=${`/api/files/${f.header_file_id}`} alt="Imagem escolhida para o e-mail" />` : html`<span class="small muted">Sem imagem</span>`}
              <label class="btn">${uploading ? 'Enviando…' : f.header_file_id ? 'Trocar imagem' : 'Escolher imagem'}<input type="file" accept="image/jpeg,image/png" class="sr-only" disabled=${uploading} onChange=${(e) => pickImage(e.target.files[0])} /></label>
              ${f.header_file_id && html`<button class="btn sm" onClick=${() => set('header_file_id', null)}>Tirar imagem</button>`}</div></div>
          <p class="xs muted">Use <code>{{primeiro_nome}}</code> e <code>{{nome}}</code>. O link "sair da lista" entra sozinho no fim.</p>`}
      </div>
      <div class="card pad form"><h2>4. Ritmo e horário</h2>
        <p class="small muted">Intervalo sorteado entre cada mensagem</p>
        <div class="grid-2">
          <label class="field">De (segundos)<input type="number" min="1" value=${f.interval_seconds} onInput=${(e) => set('interval_seconds', e.target.value)} /></label>
          <label class="field">Até (segundos)<input type="number" min="1" placeholder="igual ao mínimo" value=${f.interval_max_seconds ?? ''} onInput=${(e) => set('interval_max_seconds', e.target.value)} /></label>
        </div>
        <label class=${`chip-check ${Number(f.batch_max) > 0 ? 'on' : ''}`} style="align-self:flex-start"><input type="checkbox" checked=${Number(f.batch_max) > 0}
          onChange=${(e) => setF((x) => ({ ...x, ...(e.target.checked ? { batch_min: 310, batch_max: 332, batch_pause_minutes: 120 } : { batch_min: 0, batch_max: 0, batch_pause_minutes: 0 }) }))} />Enviar em lotes com pausa</label>
        ${Number(f.batch_max) > 0 && html`<div class="grid-3">
          <label class="field">Lote de (mensagens)<input type="number" min="1" value=${f.batch_min} onInput=${(e) => set('batch_min', e.target.value)} /></label>
          <label class="field">até<input type="number" min="1" value=${f.batch_max} onInput=${(e) => set('batch_max', e.target.value)} /></label>
          <label class="field">Pausa depois do lote (minutos)<input type="number" min="1" value=${f.batch_pause_minutes} onInput=${(e) => set('batch_pause_minutes', e.target.value)} /></label>
        </div>
        <p class="xs muted">Cada lote tem um tamanho sorteado nessa faixa, para não ficar sempre igual.</p>`}
        <label class=${`chip-check ${Number(f.mini_every) > 0 ? 'on' : ''}`} style="align-self:flex-start"><input type="checkbox" checked=${Number(f.mini_every) > 0}
          onChange=${(e) => setF((x) => ({ ...x, ...(e.target.checked ? { mini_every: 50, mini_pause_min: 20, mini_pause_max: 23 } : { mini_every: 0, mini_pause_min: 0, mini_pause_max: 0 }) }))} />Pausa curta no meio do lote</label>
        ${Number(f.mini_every) > 0 && html`<div class="grid-3">
          <label class="field">A cada (mensagens)<input type="number" min="1" value=${f.mini_every} onInput=${(e) => set('mini_every', e.target.value)} /></label>
          <label class="field">Pausa de (minutos)<input type="number" min="1" value=${f.mini_pause_min} onInput=${(e) => set('mini_pause_min', e.target.value)} /></label>
          <label class="field">até (minutos)<input type="number" min="1" value=${f.mini_pause_max} onInput=${(e) => set('mini_pause_max', e.target.value)} /></label>
        </div>`}
        <div class="grid-3">
          <label class="field">Começa às (hora)<input type="number" min="0" max="23" value=${f.window_start} onInput=${(e) => set('window_start', e.target.value)} /></label>
          <label class="field">Para às (hora)<input type="number" min="1" max="24" value=${f.window_end} onInput=${(e) => set('window_end', e.target.value)} /></label>
          <label class="field">Limite por dia<input type="number" min="1" value=${f.daily_cap} onInput=${(e) => set('daily_cap', e.target.value)} /></label>
        </div>
        <div class="audience">Cerca de <strong>${num(day)}</strong> mensagens por dia${count ? html` · ${num(count)} contatos levam uns <strong>${num(Math.ceil(count / Math.max(day, 1)))}</strong> dia(s)` : ''}</div>
        <p class="xs muted">${f.channel === 'whatsapp' ? 'Pela API oficial, a Meta também limita quantas pessoas novas o número pode chamar por dia (começa em 250 e sobe com o uso e a qualidade). Se passar do limite, os envios falham e a campanha pausa sozinha.' : 'Provedores de e-mail limitam envios por dia conforme o seu plano.'}</p>
      </div>
      <div class="row"><button class="btn primary" disabled=${busy} onClick=${save}>${camp ? 'Salvar' : 'Salvar rascunho'}</button>
        ${camp && html`<a class="btn" href=${`#/campaign/${camp.id}`}>Cancelar</a>`}</div>
    </div>
    <aside class="card pad camp-preview"><h2>Prévia</h2><p class="xs muted">Como chega para um contato chamado João da Silva</p>
      ${preview || (viaWeb && f.header_file_id) ? html`<div class=${f.channel === 'email' ? 'mail-preview' : 'bubble out wa-preview'}>${(tpl?.header_media === 'IMAGE' || viaWeb || f.channel === 'email') && f.header_file_id && html`<img class="wa-img" src=${`/api/files/${f.header_file_id}`} alt="" />`}${preview}</div>` : html`<p class="small muted">Escolha a mensagem para ver a prévia.</p>`}</aside>
  </div>`;
}

export function CampaignPage({ id }) {
  const isNew = id === 'new';
  const [edit, setEdit] = useState(false);
  const [ask, setAsk] = useState(null);
  const { data: c, error, reload } = useData(() => (isNew ? Promise.resolve(null) : api(`/campaigns/${id}`)), [id], ['campaign']);
  if (isNew) return html`<div class="main"><div class="topbar"><a href="#/campaigns" class="small">← Campanhas</a><h1 class="grow">Nova campanha</h1></div>
    <div class="page"><${Editor} onSaved=${(nid) => go(`#/campaign/${nid}`)} /></div></div>`;
  if (error) return html`<div class="main"><${ErrorBox} error=${error} retry=${reload} /></div>`;
  if (!c) return html`<div class="main"><div class="page"><${Skeleton} rows=${5} /></div></div>`;
  if (edit) return html`<div class="main"><div class="topbar"><a href=${`#/campaign/${c.id}`} class="small" onClick=${(e) => { e.preventDefault(); setEdit(false); }}>← Voltar</a><h1 class="grow">Editar campanha</h1></div>
    <div class="page"><${Editor} camp=${c} onSaved=${() => { setEdit(false); reload(); }} /></div></div>`;
  const st = c.stats;
  const act = (p, msg) => post(p).then(() => { toast(msg); reload(); }).catch(fail);
  const startText = c.status === 'draft'
    ? `${num(c.audience)} contatos vão receber, ${c.channel === 'email' ? 'por e-mail' : 'pelo WhatsApp'}, das ${c.window_start}h às ${c.window_end}h, até ${num(c.daily_cap)} por dia. Quem responder vira lead no funil; quem responder SAIR não recebe mais. Iniciar agora?`
    : 'Retomar o envio de onde parou?';
  return html`<div class="main">
    <div class="topbar"><a href="#/campaigns" class="small">← Campanhas</a><h1 class="grow">${c.name}</h1><${Status} s=${c.status} />
      ${(c.status === 'draft' || c.status === 'paused') && html`<button class="btn" onClick=${() => setEdit(true)}>Editar</button>`}
      ${(c.status === 'draft' || c.status === 'paused') && html`<button class="btn primary" onClick=${() => setAsk('start')}>${c.status === 'draft' ? 'Iniciar envio' : 'Retomar'}</button>`}
      ${c.status === 'running' && html`<button class="btn" onClick=${() => act(`/campaigns/${c.id}/pause`, 'Campanha pausada')}>Pausar</button>`}
      ${c.channel === 'email' && html`<button class="btn" onClick=${() => post('/email/test', { campaign_id: c.id }).then((r) => toast(`Teste enviado para ${r.to}`)).catch(fail)}>Enviar teste para mim</button>`}
      <button class="btn" onClick=${() => post(`/campaigns/${c.id}/duplicate`).then((r) => go(`#/campaign/${r.id}`)).catch(fail)}>Duplicar</button>
      ${c.status !== 'running' && html`<button class="btn danger" onClick=${() => setAsk('del')}>Apagar</button>`}</div>
    <div class="page dash">
      ${c.pause_reason && c.status === 'paused' && html`<div class="banner warn">${c.pause_reason}</div>`}
      <div class="kpis">
        ${c.status === 'draft'
          ? html`<div class="card pad kpi"><span class="small muted">Público agora</span><div class="kpi-v">${num(c.audience)}</div><div class="xs muted">${c.tags.length ? c.tags.join(', ') : 'Todos os contatos'}</div></div>`
          : html`<div class="card pad kpi"><span class="small muted">Público</span><div class="kpi-v">${num(st.total)}</div><div class="xs muted">${num(st.queued)} na fila</div></div>`}
        <div class="card pad kpi"><span class="small muted">Enviadas</span><div class="kpi-v">${num(st.sent)}</div><${Progress} st=${st} /></div>
        <div class="card pad kpi"><span class="small muted">Respostas</span><div class="kpi-v">${num(st.replied)}</div><div class="xs muted">${pct(st.replied, st.sent)} de quem recebeu · viram leads</div></div>
        <div class="card pad kpi"><span class="small muted">Pediram para sair</span><div class="kpi-v">${num(st.optout)}</div><div class="xs muted">${pct(st.optout, st.sent)}</div></div>
        <div class="card pad kpi"><span class="small muted">Falharam / puladas</span><div class="kpi-v">${num(st.failed)} / ${num(st.skipped)}</div></div>
      </div>
      ${c.status === 'running' && (c.batch_max > 0 || c.mini_every > 0) && c.next_at - Date.now() > 5 * 60e3 && html`<div class="banner info">Em pausa: volta a enviar às ${fmtDateTime(c.next_at)}.</div>`}
      <div class="card pad small"><strong>${c.channel === 'email' ? 'E-mail' : 'WhatsApp'}</strong> · um a cada ${c.interval_max_seconds ? `${c.interval_seconds}–${c.interval_max_seconds}` : `~${c.interval_seconds}`}s
        ${c.batch_max > 0 && html` · lotes de ${c.batch_min}–${c.batch_max} com ${c.batch_pause_minutes >= 60 && c.batch_pause_minutes % 60 === 0 ? `${c.batch_pause_minutes / 60} h` : `${c.batch_pause_minutes} min`} de pausa${c.batch_target ? ` (lote atual: ${c.batch_sent} de ${c.batch_target})` : ''}`}
        ${c.mini_every > 0 && html` · a cada ${c.mini_every} mensagens, pausa de ${c.mini_pause_min}–${c.mini_pause_max} min`}
        · das ${c.window_start}h às ${c.window_end}h · até ${num(c.daily_cap)}/dia
        ${c.started_at && html` · começou ${fmtDateTime(c.started_at)}`}${c.finished_at && html` · terminou ${fmtDateTime(c.finished_at)}`}</div>
      <div class="card"><div class="pad"><h2>Últimos envios</h2></div>
        ${c.recent.length ? html`<table class="t"><thead><tr><th>Contato</th><th>Para</th><th>Situação</th><th>Quando</th></tr></thead><tbody>
          ${c.recent.map((r) => html`<tr><td><a href=${`#/contact/${r.contact_id}`}>${r.name}</a></td><td class="small">${r.address}</td>
            <td><span class=${`pill r-${r.status}`}>${RSTATUS[r.status]}</span>${r.error && html`<div class="xs muted">${r.error}</div>`}</td><td class="small">${ago(r.replied_at || r.sent_at)}</td></tr>`)}</tbody></table>`
        : html`<p class="pad small muted">Nada enviado ainda.</p>`}</div>
    </div>
    ${ask === 'start' && html`<${Confirm} title=${c.status === 'draft' ? 'Iniciar campanha' : 'Retomar campanha'} text=${startText} okLabel=${c.status === 'draft' ? 'Iniciar envio' : 'Retomar'}
      onOk=${() => post(`/campaigns/${c.id}/start`).then(() => { toast('Envio iniciado'); reload(); })} onClose=${() => setAsk(null)} />`}
    ${ask === 'del' && html`<${Confirm} title="Apagar campanha" danger okLabel="Apagar" text="Apaga a campanha e o histórico de envios dela. As conversas e leads criados continuam."
      onOk=${() => del(`/campaigns/${c.id}`).then(() => go('#/campaigns'))} onClose=${() => setAsk(null)} />`}
  </div>`;
}
