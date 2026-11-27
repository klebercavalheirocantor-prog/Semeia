import { html, useState, useEffect, api, post, patch, del, fail, toast, B, loadBoot, Modal, Confirm, UserSelect, Empty } from '../lib.js';

const SECTIONS = [['plano', 'Plano'], ['general', 'Geral'], ['channels', 'Canais'], ['templates', 'Modelos do WhatsApp'], ['email', 'E-mail'], ['ai', 'Assistente de IA'], ['resumo', 'Resumo do dia'], ['quick', 'Respostas prontas'], ['pipelines', 'Funis e etapas'], ['users', 'Equipe'], ['roles', 'Permissões'], ['fields', 'Campos'], ['lists', 'Tags e listas'], ['account', 'Minha conta']];

// Plano e pagamento: teste grátis, plano atual e assinatura pelo Mercado Pago.
export function Plano() {
  const bi = B().billing || {};
  const [busy, setBusy] = useState('');
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const cancelar = () => {
    if (!confirm('Cancelar a assinatura? A cobrança para e você continua usando até o fim do mês já pago.')) return;
    setBusy('cancel'); post('/billing/cancel').then(async () => { toast('Assinatura cancelada'); await loadBoot(); setBusy(''); }).catch((e) => { setBusy(''); fail(e); });
  };
  const pay = (plan) => { setBusy(plan); post('/billing/checkout', { plan }).then((r) => { location.href = r.url; }).catch((e) => { setBusy(''); fail(e); }); };
  if (bi.plan === 'interno') return html`<section class="card pad form"><h2>Plano</h2><p>Esta empresa usa o Fechaê sem cobrança e sem limites.</p></section>`;
  const status = bi.blocked ? html`<p class="banner danger" role="alert">Seu acesso está pausado. Escolha um plano para voltar a usar; nada foi apagado.</p>`
    : bi.status === 'teste' ? html`<p class="banner info">Teste grátis: ${bi.trial_days_left} ${bi.trial_days_left === 1 ? 'dia restante' : 'dias restantes'} (plano ${bi.plan_name}).</p>`
    : bi.status === 'ativo' ? html`<p class="banner info">Assinatura ativa: plano ${bi.plan_name}. A cobrança é mensal, no cartão, pelo Mercado Pago.</p>`
    : bi.status === 'cancelado' && !bi.blocked ? html`<p class="banner warn">Assinatura cancelada. Você usa até ${new Date(bi.paid_until).toLocaleDateString('pt-BR')}; depois o acesso pausa (os dados ficam guardados por 90 dias).</p>`
    : html`<p class="banner warn">Assinatura ${bi.status}. Assine de novo para continuar.</p>`;
  return html`<section class="card pad form"><h2>Plano</h2>${status}
    <div class="plans">${(bi.plans || []).map((p) => html`<div class=${`plan-card${p.key === bi.plan ? ' current' : ''}`}>
      <h3>${p.name}</h3><p class="plan-price">${brl(p.cents)}<span>/mês</span></p>
      <ul><li>${p.users} usuários</li><li>${p.whatsapp} ${p.whatsapp === 1 ? 'número' : 'números'} de WhatsApp</li><li>Funil, conversas e atendente com IA</li>
        ${p.features.includes('campanhas') && html`<li>Campanhas e assistente (também no app do Claude)</li>`}
        ${p.features.includes('traducao') && html`<li>Tradução automática e várias marcas</li>`}</ul>
      <button class=${`btn${p.key === bi.plan ? ' primary' : ''}`} disabled=${!!busy} onClick=${() => pay(p.key)}>
        ${busy === p.key ? 'Abrindo o pagamento…' : bi.status === 'ativo' && p.key === bi.plan ? 'Plano atual' : 'Assinar'}</button></div>`)}</div>
    <p class="xs muted">O pagamento abre no Mercado Pago. Você pode cancelar quando quiser, por aqui mesmo. <a href="/termos.html" target="_blank" rel="noopener">Termos de uso e privacidade</a>.</p>
    ${bi.status === 'ativo' && html`<div class="row"><button class="btn danger" disabled=${!!busy} onClick=${cancelar}>Cancelar assinatura</button></div>`}</section>`;
}

function Account() {
  const me = B().user;
  const [f, setF] = useState({ name: me.name, current_password: '', password: '' });
  const save = (e) => { e.preventDefault(); patch(`/users/${me.id}`, { name: f.name, ...(f.password && { password: f.password, current_password: f.current_password }) })
    .then(() => { toast('Salvo'); setF({ ...f, password: '', current_password: '' }); }).catch(fail); };
  return html`<form class="form card pad" style="max-width:420px" onSubmit=${save}><h2>Minha conta</h2>
    <label class="field">Nome<input value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></label>
    <p class="small muted">${me.email}</p>
    <label class="field">Senha atual<input type="password" autocomplete="current-password" value=${f.current_password} onInput=${(e) => setF({ ...f, current_password: e.target.value })} /></label>
    <label class="field">Nova senha (mín. 8)<input type="password" autocomplete="new-password" value=${f.password} onInput=${(e) => setF({ ...f, password: e.target.value })} /></label>
    <button class="btn primary">Salvar</button></form>
    ${(B().billing?.features || []).includes('assistente') && html`<${ClaudeLink} />`}`;
}

// Conectar o Fechaê ao app do Claude: link secreto da pessoa, para colar em Conectores no Claude.
function ClaudeLink() {
  const [info, setInfo] = useState(null);
  const [url, setUrl] = useState('');
  useEffect(() => { api('/mcp-link').then(setInfo).catch(() => setInfo({})); }, []);
  const gerar = () => post('/mcp-link').then((r) => { setUrl(r.url); setInfo({ created_at: Date.now() }); }).catch(fail);
  const desligar = () => del('/mcp-link').then(() => { setUrl(''); setInfo({}); toast('Link desligado'); }).catch(fail);
  const copiar = () => navigator.clipboard?.writeText(url).then(() => toast('Link copiado')).catch(() => {});
  return html`<section class="card pad form" style="max-width:560px;margin-top:var(--s-4)"><h2>Conectar ao Claude</h2>
    <p class="small">Use o Fechaê de dentro do app do Claude (celular ou computador): peça "quais leads estão sem tarefa?" ou "cria uma tarefa para ligar para a Maria amanhã" e ele faz aqui, com o seu login.</p>
    <ol class="small"><li>Clique em "Gerar link" e copie.</li><li>No Claude: Configurações › Conectores › Adicionar conector personalizado.</li><li>Nome: Fechaê. Cole o link e salve.</li></ol>
    ${url ? html`<label class="field">Seu link (aparece só agora)<input readonly value=${url} onFocus=${(e) => e.target.select()} /></label>
        <div class="row"><button type="button" class="btn primary" onClick=${copiar}>Copiar link</button></div>`
      : info?.created_at ? html`<p class="small">Conectado desde ${new Date(info.created_at).toLocaleDateString('pt-BR')}. Gerar um link novo desliga o anterior.</p>` : null}
    <p class="xs muted">Quem tiver este link usa o CRM como você. Não compartilhe. O Claude não envia mensagens, não liga campanhas e não apaga nada por aqui.</p>
    <div class="row"><button type="button" class="btn" onClick=${gerar}>${info?.created_at ? 'Gerar link novo' : 'Gerar link'}</button>
      ${info?.created_at && html`<button type="button" class="btn danger" onClick=${desligar}>Desligar</button>`}</div>
  </section>`;
}

// Resumo do dia: todo dia de manhã o dono recebe no WhatsApp o que aconteceu (e na segunda, o que funcionou na semana).
function Resumo() {
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/resumo').then(setR).catch(fail);
  useEffect(() => { load(); }, []);
  if (!r) return html`<p class="muted">Carregando…</p>`;
  const set = (k) => (e) => setR({ ...r, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const salvar = () => api('/resumo', { method: 'PUT', body: r }).then(() => { toast(r.ativo ? 'Resumo ligado' : 'Salvo'); load(); }).catch(fail);
  const teste = () => { setBusy(true); api('/resumo', { method: 'PUT', body: r }).then(() => post('/resumo/teste'))
    .then(() => toast('Resumo enviado. Confira o WhatsApp')).catch(fail).finally(() => setBusy(false)); };
  return html`<div class="col" style="max-width:760px"><div class="card pad form"><h2>Resumo do dia no WhatsApp</h2>
    <p class="small">Todo dia, na hora escolhida, chega no seu WhatsApp o que aconteceu: o que a IA respondeu de madrugada, leads novos, vendas, quem está esperando resposta e as tarefas do dia. Na segunda-feira vem junto o que funcionou na semana.</p>
    ${!r.canais.length && html`<p class="small" style="color:var(--danger)">Conecte um número de WhatsApp em Canais para poder mandar o resumo.</p>`}
    <label class="field">Número que manda<select value=${r.canal_id || ''} onChange=${set('canal_id')}><option value="">Escolha…</option>
      ${r.canais.map((c) => html`<option value=${c.id}>${c.name} (${c.marca})</option>`)}</select></label>
    <label class="field">Número que recebe (seu WhatsApp, com DDD)<input inputmode="tel" placeholder="67 99999-9999" value=${r.telefone} onInput=${set('telefone')} /></label>
    <div class="row">
      <label class="field">Hora<select value=${r.hora} onChange=${set('hora')}>${[5, 6, 7, 8, 9, 10].map((h) => html`<option value=${h}>${h}h</option>`)}</select></label>
      <label class="field grow">Fuso<select value=${r.fuso} onChange=${set('fuso')}>${Object.entries(r.fusos).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
    </div>
    <label class="row small"><input type="checkbox" checked=${r.semanal} onChange=${set('semanal')} /> Na segunda, mandar também o que funcionou na semana</label>
    <label class="row small"><input type="checkbox" checked=${r.ativo} onChange=${set('ativo')} /> Ligado: mandar todo dia</label>
    ${r.erro && html`<p class="small" style="color:var(--danger)">Último envio falhou (${r.erro})</p>`}
    <p class="xs muted">Se você responder a mensagem do resumo, a resposta entra no CRM como uma conversa normal desse número.</p>
    <div class="row"><button class="btn primary" onClick=${salvar}>Salvar</button>
      <button class="btn" disabled=${busy || !r.canal_id || String(r.telefone).replace(/\D/g, '').length < 10} onClick=${teste}>${busy ? 'Mandando…' : 'Mandar um teste agora'}</button></div>
  </div>
  <div class="card pad"><h2>Como fica (com os números de agora)</h2><pre class="small" style="white-space:pre-wrap;font-family:inherit;margin:0">${r.previa}</pre></div></div>`;
}

function General() {
  const b = B();
  const [g, setG] = useState(b.general);
  const [m, setM] = useState({ ...b.meta, app_secret: '' });
  const hook = `${(g.public_url || location.origin).replace(/\/$/, '')}/webhooks/meta`;
  const save = () => patch('/settings', { general: g, meta: m }).then(() => toast('Salvo')).catch(fail);
  const regen = () => setM({ ...m, verify_token: [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('') });
  return html`<div class="col" style="max-width:640px">
    <div class="card pad form"><h2>Empresa</h2>
      <label class="field">Nome da empresa<input value=${g.company} onInput=${(e) => setG({ ...g, company: e.target.value })} /></label>
      <label class="field">Moeda<select value=${g.currency} onChange=${(e) => setG({ ...g, currency: e.target.value })}><option value="BRL">BRL</option><option value="USD">USD</option><option value="EUR">EUR</option></select></label>
    </div>
    <div class="card pad form"><h2>App da Meta (WhatsApp, Instagram, Messenger)</h2>
      <p class="small muted">Estes dados vêm do seu app em developers.facebook.com. Um app serve para todos os canais.</p>
      <label class="field">Endereço público deste CRM (HTTPS)<input placeholder="https://seu-tunel.trycloudflare.com" value=${g.public_url} onInput=${(e) => setG({ ...g, public_url: e.target.value })} /></label>
      <div class="field">URL de retorno (cole no app da Meta, em Webhooks)<code class="copy">${hook}</code></div>
      <div class="field">Token de verificação (cole no mesmo lugar)<div class="row"><code class="copy grow">${m.verify_token}</code><button class="btn sm" onClick=${regen}>Gerar outro</button></div></div>
      <label class="field">Chave secreta do app (App Secret)<input type="password" autocomplete="new-password" placeholder=${b.meta.has_app_secret ? '•••••••• salvo (deixe vazio para manter)' : 'Obrigatório para receber mensagens'}
        value=${m.app_secret} onInput=${(e) => setM({ ...m, app_secret: e.target.value })} /></label>
      <label class="field">Versão da Graph API<input value=${m.graph_version} onInput=${(e) => setM({ ...m, graph_version: e.target.value })} /></label>
    </div>
    <button class="btn primary" style="align-self:flex-start" onClick=${save}>Salvar</button>
    <${CapiSettings} />
  </div>`;
}

// Vendas para o Facebook: o CRM avisa cada venda fechada, e o Facebook mostra a compra no anúncio de onde o cliente veio.
function CapiSettings() {
  const [st, setSt] = useState(null);
  const [f, setF] = useState({ dataset_id: '', token: '' });
  const [busy, setBusy] = useState(false);
  const load = () => api('/admin/capi').then((r) => { setSt(r); setF((x) => ({ ...x, dataset_id: r.dataset_id })); }).catch(() => setSt(false));
  useEffect(load, []);
  if (st === false) return null; // só administradores
  const save = () => api('/admin/capi', { method: 'PUT', body: f }).then((r) => { setSt(r); setF({ ...f, token: '' }); toast('Salvo'); }).catch(fail);
  const send = async () => { setBusy(true); try { const r = await post('/admin/capi/send'); toast(r.ok ? `${r.enviadas} ${r.enviadas === 1 ? 'venda enviada' : 'vendas enviadas'} ao Facebook` : `Não foi: ${r.erro || r.motivo}`); load(); } catch (x) { fail(x); } setBusy(false); };
  const u = st?.ultimo;
  return html`<div class="card pad form"><h2>Vendas para o Facebook</h2>
    <p class="small muted">Cada lead em "Venda fechada" com valor é avisado ao Facebook (telefone embaralhado, valor e data). O Facebook mostra a compra no anúncio de onde o cliente veio. Vai sozinho a cada 15 minutos; vendas de até 62 dias atrás também entram.</p>
    <label class="field">ID do conjunto de dados (Gerenciador de Eventos)<input inputmode="numeric" value=${f.dataset_id} onInput=${(e) => setF({ ...f, dataset_id: e.target.value })} /></label>
    <label class="field">Chave de acesso (gerada no conjunto de dados, em Configurações › API de Conversões)<input type="password" autocomplete="new-password"
      placeholder=${st?.has_token ? '•••••••• salva (deixe vazio para manter)' : 'Cole a chave aqui'} value=${f.token} onInput=${(e) => setF({ ...f, token: e.target.value })} /></label>
    ${st && html`<p class="small">${st.enviadas} ${st.enviadas === 1 ? 'venda enviada' : 'vendas enviadas'} · ${st.pendentes} na fila${u ? ` · última tentativa ${new Date(u.at).toLocaleString('pt-BR')}${u.erro ? `: erro — ${u.erro}` : ''}${u.sem_contato ? ` · ${u.sem_contato} sem telefone/e-mail` : ''}` : ''}</p>`}
    <div class="row"><button class="btn primary" onClick=${save}>Salvar</button><button class="btn" disabled=${busy || !st?.has_token} onClick=${send}>${busy ? 'Enviando…' : 'Enviar vendas agora'}</button></div>
  </div>`;
}

function EmailSettings() {
  const e = B().email || {};
  const [f, setF] = useState({ from: e.from || '', reply_to: e.reply_to || '', api_key: '', sig_name: e.sig_name || '', whatsapp: e.whatsapp || '',
    whatsapp_text: e.whatsapp_text || '', instagram: e.instagram || '', site: e.site || '', sig_image_file_id: e.sig_image_file_id || null });
  const [busy, setBusy] = useState(false);
  const set = (k) => (x) => setF({ ...f, [k]: x.target.value });
  const save = () => patch('/settings', { email: f }).then(() => { toast('Salvo'); setF({ ...f, api_key: '' }); }).catch(fail);
  const test = async () => { setBusy(true); try { const r = await post('/email/test'); toast(`E-mail de teste enviado para ${r.to}`); } catch (x) { fail(x); } setBusy(false); };
  const pick = async (file) => {
    if (!file) return;
    try {
      const r = await api('/files', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) } });
      setF({ ...f, sig_image_file_id: r.id });
    } catch (x) { fail(x); }
  };
  const company = B().general.company;
  return html`<div class="col" style="max-width:640px"><div class="card pad form"><h2>E-mail para campanhas · ${company}</h2>
    <p class="small muted">O envio é feito pela <strong>Resend</strong> (resend.com): verifique o domínio da empresa e gere uma chave de API (de preferência só com permissão de envio).
      O plano grátis envia 100 por dia; para listas grandes use um plano pago.</p>
    <label class="field">Remetente<input autocomplete="off" name="email-from" placeholder="Sua Empresa <contato@envio.suaempresa.com.br>" value=${f.from} onInput=${set('from')} /></label>
    <label class="field">Responder para (opcional)<input type="email" autocomplete="off" name="email-reply-to" placeholder="contato@suaempresa.com.br" value=${f.reply_to} onInput=${set('reply_to')} /></label>
    <label class="field">Chave de API da Resend<input type="password" autocomplete="new-password" placeholder=${e.has_key ? '•••••••• salva (deixe vazio para manter)' : 're_...'} value=${f.api_key} onInput=${set('api_key')} /></label>
    <h3 style="margin-top:8px">Assinatura</h3>
    <p class="xs muted">Vai no fim de todo e-mail: "Abraço, ${f.sig_name || `Equipe ${company}`}", o botão do WhatsApp, Instagram e site clicáveis. A arte da campanha também abre o WhatsApp.</p>
    <label class="field">Nome na assinatura<input autocomplete="off" placeholder=${`Equipe ${company}`} value=${f.sig_name} onInput=${set('sig_name')} /></label>
    <div class="grid-2">
      <label class="field">WhatsApp (com DDD)<input autocomplete="off" inputmode="tel" placeholder="(67) 99999-9999" value=${f.whatsapp} onInput=${set('whatsapp')} /></label>
      <label class="field">Instagram<input autocomplete="off" placeholder="@suaempresa" value=${f.instagram} onInput=${set('instagram')} /></label>
    </div>
    <label class="field">Mensagem que já vem escrita no WhatsApp<input autocomplete="off" placeholder="Olá! Vim pelo e-mail e quero saber mais." value=${f.whatsapp_text} onInput=${set('whatsapp_text')} /></label>
    <label class="field">Site<input autocomplete="off" placeholder="www.suaempresa.com.br" value=${f.site} onInput=${set('site')} /></label>
    <div class="field">Imagem acima do "Abraço" (o mascote)
      <div class="row">${f.sig_image_file_id ? html`<img class="camp-img" style="object-fit:contain" src=${`/api/files/${f.sig_image_file_id}`} alt="Imagem da assinatura" />` : html`<span class="small muted">Sem imagem</span>`}
        <label class="btn">${f.sig_image_file_id ? 'Trocar' : 'Escolher imagem'}<input type="file" accept="image/png,image/jpeg" class="sr-only" onChange=${(x) => pick(x.target.files[0])} /></label>
        ${f.sig_image_file_id && html`<button class="btn sm" onClick=${() => setF({ ...f, sig_image_file_id: null })}>Tirar</button>`}</div></div>
    ${!f.whatsapp && html`<div class="banner warn small">Sem WhatsApp, o botão e o link da arte não aparecem (a arte abre o site).</div>`}
    <div class="row"><button class="btn primary" onClick=${save}>Salvar</button><button class="btn" disabled=${busy || !e.has_key} onClick=${test}>Enviar e-mail de teste para mim</button></div>
  </div>
  <${MailboxSettings} /></div>`;
}

// Caixa de entrada lida pelo CRM: as respostas das campanhas entram como conversa.
function MailboxSettings() {
  const ch = B().channels.find((c) => c.kind === 'email');
  const [f, setF] = useState({ address: ch?.external_id || '', imap_host: ch?.imap_host || 'imap.gmail.com', imap_pass: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (x) => setF({ ...f, [k]: x.target.value });
  const save = async () => {
    setBusy(true);
    try {
      const { id } = await post('/mailbox', f);
      setF({ ...f, imap_pass: '' });
      toast('Caixa salva. Testando...');
      await post(`/channels/${id}/test`);
      toast('Conectou na caixa: as respostas novas vão entrar no CRM');
    } catch (x) { fail(x); }
    setBusy(false);
  };
  return html`<div class="card pad form"><h2>Respostas por e-mail</h2>
    <p class="small muted">O CRM confere esta caixa a cada minuto. E-mail de quem é contato entra como conversa: conta como resposta da campanha,
      "SAIR" tira da lista e o fluxo "Resposta ao e-mail" manda a tabela de preço. E-mails de quem não é contato ficam só na caixa.</p>
    <p class="xs muted">No Gmail/Google Workspace: ative a verificação em duas etapas da conta e crie uma <strong>senha de app</strong> em
      myaccount.google.com › Segurança › Senhas de app. Cole aqui essa senha (não a senha normal).</p>
    <label class="field">E-mail da caixa<input type="email" autocomplete="off" name="mailbox-address" placeholder="contato@suaempresa.com.br" value=${f.address} onInput=${set('address')} /></label>
    <label class="field">Servidor IMAP<input autocomplete="off" name="mailbox-host" value=${f.imap_host} onInput=${set('imap_host')} /></label>
    <label class="field">Senha de app<input type="password" autocomplete="new-password" name="mailbox-pass" placeholder=${ch?.has_pass ? '•••••••• salva (deixe vazio para manter)' : 'abcd efgh ijkl mnop'} value=${f.imap_pass} onInput=${set('imap_pass')} /></label>
    ${ch && html`<p class="xs ${ch.mail_error ? 'error-text' : 'muted'}">${ch.mail_error ? `Erro na última conferida: ${ch.mail_error}` : ch.checked_at ? `Conferida às ${new Date(ch.checked_at).toLocaleTimeString('pt-BR')}` : 'Ainda não conferida'}</p>`}
    <div class="row"><button class="btn primary" disabled=${busy} onClick=${save}>Salvar e testar</button></div>
  </div>`;
}

function QuickReplies() {
  const [list, setList] = useState(() => (B().quick_replies || []).map((r) => ({ ...r })));
  const up = (i, k) => (e) => setList(list.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));
  const move = (i, d) => { const l = [...list]; [l[i], l[i + d]] = [l[i + d], l[i]]; setList(l); };
  const save = () => api('/quick-replies', { method: 'PUT', body: list }).then(async (r) => { setList(r); await loadBoot(); toast('Salvo'); }).catch(fail);
  return html`<div class="col" style="max-width:760px"><div class="card pad form"><h2>Respostas prontas</h2>
    <p class="small muted">Mensagens que você usa sempre (site, formas de pagamento...). Na conversa, clique em <strong>⚡ Prontas</strong>: o texto entra na caixa e dá para ajustar antes de enviar.
      No número com tradução para espanhol (Paraguai/Argentina) vai o texto em espanhol; se estiver vazio, vai o em português traduzido.</p>
    ${list.map((r, i) => html`<div class="card pad col" style="gap:8px">
      <div class="row"><input aria-label="Nome" placeholder="Nome (ex.: Pagamento no cartão)" value=${r.title} onInput=${up(i, 'title')} style="flex:1" />
        <button class="btn sm" title="Subir" disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
        <button class="btn sm" title="Descer" disabled=${i === list.length - 1} onClick=${() => move(i, 1)}>↓</button>
        <button class="btn danger sm" onClick=${() => setList(list.filter((_, j) => j !== i))}>Remover</button></div>
      <label class="field">Português<textarea rows="3" value=${r.pt} onInput=${up(i, 'pt')}></textarea></label>
      <label class="field">Espanhol (Paraguai/Argentina)<textarea rows="3" value=${r.es} onInput=${up(i, 'es')}></textarea></label>
    </div>`)}
    <div class="row"><button class="btn" onClick=${() => setList([...list, { title: '', pt: '', es: '' }])}>+ Nova resposta</button>
      <span class="spacer"></span><button class="btn primary" onClick=${save}>Salvar</button></div>
  </div></div>`;
}

function AiSettings() {
  const a = B().ai || {};
  const [f, setF] = useState({ model: a.model || 'claude-haiku-5-5', persona: a.persona || '', knowledge: a.knowledge || '', api_key: '', groq_key: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (x) => setF({ ...f, [k]: x.target.value });
  const save = () => patch('/settings', { ai: f }).then(async () => { toast('Salvo'); setF({ ...f, api_key: '', groq_key: '' }); await loadBoot(); }).catch(fail);
  const test = async () => { setBusy(true); try { await post('/ai/test'); toast('A IA respondeu: chave funcionando'); } catch (x) { fail(x); } setBusy(false); };
  return html`<div class="col" style="max-width:760px"><div class="card pad form"><h2>Assistente de IA</h2>
    <p class="small muted">Usado nos fluxos (nós "IA responde" e "IA entende a intenção"). Ele responde as primeiras perguntas <strong>só com o que está na base abaixo</strong>
      e passa para um atendente quando o cliente quer fechar, pede uma pessoa ou pergunta algo que não está na base. Usa o Claude, da Anthropic:
      crie a chave em console.anthropic.com (é pago por uso; conversas curtas custam centavos).</p>
    <label class="field">Chave da API da Anthropic<input type="password" autocomplete="new-password" placeholder=${a.has_key ? '•••••••• salva (deixe vazio para manter)' : 'sk-ant-...'} value=${f.api_key} onInput=${set('api_key')} /></label>
    <label class="field">Modelo<select value=${f.model} onChange=${set('model')}>
      <option value="claude-haiku-5-5">Claude Haiku (rápido e barato, recomendado)</option>
      <option value="claude-sonnet-5-5">Claude Sonnet (mais caprichado, custa mais)</option></select></label>
    <label class="field">Quem é o atendente (opcional)<input placeholder="Ex.: Você é a Ana, da Sua Empresa, atendendo clientes no WhatsApp." value=${f.persona} onInput=${set('persona')} /></label>
    <label class="field">Base de conhecimento<textarea rows="16" value=${f.knowledge} onInput=${set('knowledge')}></textarea></label>
    <p class="xs muted">Escreva como se explicasse a um vendedor novo: produtos, preços, prazos, formas de pagamento, o que não fazemos. Se um preço não estiver aqui, a IA não inventa: passa para você.</p>
    <h3 style="margin-top:16px">Transcrição de áudio</h3>
    <p class="small muted">O áudio que o cliente manda vira texto na conversa (e, se for em espanhol ou inglês, já vem traduzido para português). Usa a Groq, que tem plano gratuito:
      crie a chave em <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a> e cole aqui.</p>
    <label class="field">Chave da API da Groq<input type="password" autocomplete="new-password" placeholder=${a.has_groq ? '•••••••• salva (deixe vazio para manter)' : 'gsk_...'} value=${f.groq_key} onInput=${set('groq_key')} /></label>
    <div class="row"><button class="btn primary" onClick=${save}>Salvar</button><button class="btn" disabled=${busy || !a.has_key} onClick=${test}>Testar chave</button></div>
  </div></div>`;
}

const KIND = { whatsapp: 'WhatsApp', instagram: 'Instagram Direct', messenger: 'Facebook Messenger' };
const ID_LABEL = { whatsapp: 'ID do número de telefone (Phone number ID)', messenger: 'ID da Página do Facebook', instagram: 'ID da conta do Instagram (Instagram account ID)' };
const TOKEN_LABEL = { whatsapp: 'Token de acesso permanente (usuário do sistema)', messenger: 'Token de acesso da Página', instagram: 'Token de acesso da Página ligada ao Instagram' };

function ChannelModal({ onClose }) {
  const [f, setF] = useState({ kind: 'whatsapp', name: '', external_id: '', waba_id: '', token: '', pipeline_id: B().pipelines[0].id });
  const save = (e) => { e.preventDefault(); post('/channels', f).then(() => { toast('Canal conectado. Use "Testar" para conferir.'); onClose(); }).catch(fail); };
  return html`<${Modal} title="Conectar canal" onClose=${onClose} wide><form class="form" onSubmit=${save}>
    <label class="field">Canal<select value=${f.kind} onChange=${(e) => setF({ ...f, kind: e.target.value })}>${Object.entries(KIND).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></label>
    ${f.kind === 'whatsapp' && html`<ol class="small" style="margin:0;padding-left:18px">
      <li>Em developers.facebook.com, crie um app do tipo Empresa e adicione o produto WhatsApp.</li>
      <li>Em WhatsApp > Configuração da API, adicione e verifique seu número. Copie o <strong>Phone number ID</strong>.</li>
      <li>No Gerenciador de Negócios, crie um usuário do sistema, dê acesso ao app e à conta do WhatsApp e gere um token com as permissões <code>whatsapp_business_messaging</code> e <code>whatsapp_business_management</code>.</li>
      <li>Em WhatsApp > Configuração, cadastre a URL de retorno e o token de verificação que aparecem em Configurações > Geral e assine o campo <code>messages</code>.</li>
    </ol>`}
    ${f.kind !== 'whatsapp' && html`<p class="small">No app da Meta, adicione o produto ${f.kind === 'instagram' ? 'Instagram (mensagens pela Página do Facebook)' : 'Messenger'}, gere o token da Página,
      cadastre a mesma URL de retorno e assine <code>messages</code> e <code>messaging_postbacks</code>. Para clientes reais o app precisa passar pela análise da Meta.</p>`}
    <label class="field">Nome para você reconhecer<input value=${f.name} placeholder=${KIND[f.kind]} onInput=${(e) => setF({ ...f, name: e.target.value })} /></label>
    <label class="field">${ID_LABEL[f.kind]}<input required value=${f.external_id} onInput=${(e) => setF({ ...f, external_id: e.target.value })} /></label>
    ${f.kind === 'whatsapp' && html`<label class="field">ID da conta do WhatsApp (WhatsApp Business Account ID), na mesma tela da API<input value=${f.waba_id} onInput=${(e) => setF({ ...f, waba_id: e.target.value })} /></label>`}
    <label class="field">${TOKEN_LABEL[f.kind]}<input required type="password" autocomplete="new-password" value=${f.token} onInput=${(e) => setF({ ...f, token: e.target.value })} /></label>
    <label class="field">Novos leads entram no funil<select value=${f.pipeline_id} onChange=${(e) => setF({ ...f, pipeline_id: Number(e.target.value) })}>${B().pipelines.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select></label>
    <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancelar</button><button class="btn primary">Conectar</button></div>
  </form><//>`;
}

// Conectar números pelo QR code, como no WhatsApp Web / WA Web Plus. Cada número tem o seu cartão (Brasil, Paraguai, EUA...).
function WebConnect({ ch }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ch) return;
    let on = true;
    const tick = () => api(`/waweb/${ch.id}`).then((r) => on && setSt(r)).catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => { on = false; clearInterval(t); };
  }, [ch?.id]);
  const connect = async () => { setBusy(true); try { setSt(await post('/waweb', ch ? { channel_id: ch.id } : {})); } catch (e) { fail(e); } setBusy(false); };
  const logout = async () => { setBusy(true); try { await post(`/waweb/${ch.id}/logout`); toast('Desconectado'); setSt({ state: 'off' }); } catch (e) { fail(e); } setBusy(false); };
  const setOpt = async (o) => {
    if (o.engine && !confirm('Trocar a conexão desconecta este número e mostra um QR code novo para ler com o celular. Continuar?')) return;
    setBusy(true);
    try { const r = await post(`/waweb/${ch.id}/options`, o); if (o.engine) setSt(r); await loadBoot(); toast('Salvo'); } catch (e) { fail(e); }
    setBusy(false);
  };
  const s = st?.state || 'off';
  return html`<div class="card pad col" style="gap:var(--s-3)">
    <div class="row"><div class="grow"><h3>${ch?.name && ch.name !== 'WhatsApp Web' ? `WhatsApp · ${ch.name}` : 'WhatsApp Web (QR code)'}</h3>
      <div class="small muted">O CRM vira um aparelho conectado do número, como o WA Web Plus. Envia campanhas, recebe as respostas e roda os fluxos.</div></div>
      ${s === 'ready' ? html`<span class="pill ok">Conectado${st.me ? `: ${st.me}` : ''}</span>` : s === 'qr' ? html`<span class="pill warn">Aguardando leitura</span>` : s === 'starting' ? html`<span class="pill">Abrindo…</span>` : html`<span class="pill">Desconectado</span>`}</div>
    ${s === 'qr' && st.qr && html`<div class="row wrap" style="align-items:flex-start;gap:var(--s-4)"><img src=${st.qr} alt="QR code para conectar o WhatsApp" width="260" height="260" style="border-radius:8px;background:#fff;padding:6px" />
      <ol class="small" style="margin:0;padding-left:18px;max-width:320px"><li>No celular ${ch?.name && ch.name !== 'WhatsApp Web' ? `do número ${ch.name}` : 'do número da empresa'}, abra o WhatsApp.</li><li>Toque em ⋮ (ou Configurações) › <strong>Aparelhos conectados</strong> › <strong>Conectar aparelho</strong>.</li><li>Aponte a câmera para este código.</li></ol></div>`}
    ${s === 'starting' && html`<p class="small muted">Abrindo o WhatsApp… leva alguns segundos.</p>`}
    ${st?.error && s !== 'ready' && html`<div class="banner warn small">${st.error}</div>`}
    ${ch && html`<div class="row wrap small" style="gap:var(--s-3)">
      <label class="row" style="gap:6px">Conexão
        <select aria-label="Tipo de conexão" disabled=${busy} value=${ch.engine || 'baileys'} onChange=${(e) => setOpt({ engine: e.target.value })}>
          <option value="baileys">Leve (para anúncios)</option>
          <option value="wwebjs">WhatsApp Web completo (para disparos)</option>
        </select></label>
      <label class="row" style="gap:6px">Traduzir o que eu escrevo para
        <select aria-label="Traduzir o que eu escrevo" disabled=${busy} value=${ch.translate_to || ''} onChange=${(e) => setOpt({ translate_to: e.target.value })}>
          <option value="">Não traduzir</option><option value="es">Espanhol</option><option value="en">Inglês</option>
        </select></label>
    </div>`}
    ${ch?.engine === 'wwebjs' && html`<p class="small muted">WhatsApp Web completo: o WhatsApp aceita melhor para disparos, mas pode pedir o QR de novo depois de cada atualização do Fechaê.</p>`}
    <div class="row">
      ${s === 'ready' ? html`<button class="btn" disabled=${busy} onClick=${logout}>Desconectar este aparelho</button>`
        : !['qr', 'starting'].includes(s) && html`<button class="btn primary" disabled=${busy} onClick=${connect}>${ch ? 'Conectar de novo' : 'Conectar pelo QR code'}</button>`}
    </div>
  </div>`;
}

function WebNumbers() {
  const webs = B().channels.filter((c) => c.kind === 'whatsapp' && c.mode === 'web' && c.status !== 'disabled');
  const [busy, setBusy] = useState(false);
  const addNumber = async () => {
    const name = prompt('Nome deste número (ex.: Paraguai, EUA):');
    if (!name || !name.trim()) return;
    setBusy(true);
    try { await post('/waweb', { novo: true, name: name.trim() }); await loadBoot(); toast('Leia o QR code com o celular desse número'); } catch (e) { fail(e); }
    setBusy(false);
  };
  return html`<div class="col" style="gap:var(--s-3)">
    ${webs.length ? webs.map((ch) => html`<${WebConnect} key=${ch.id} ch=${ch} />`) : html`<${WebConnect} ch=${null} />`}
    ${webs.length > 0 && html`<div class="row"><button class="btn" disabled=${busy} onClick=${addNumber}>+ Conectar outro WhatsApp</button>
      <span class="xs muted">Cada número lê o seu QR. As campanhas escolhem por qual número sair; as respostas caem no mesmo funil e a IA responde no idioma do cliente.</span></div>`}
    <p class="xs muted">Não é a API oficial: o que protege cada número é o ritmo das campanhas (intervalo, lotes e pausas). Não dispare pelo WA Web Plus e pelo CRM ao mesmo tempo no mesmo número.</p>
  </div>`;
}

function Channels() {
  const [add, setAdd] = useState(false);
  const [tokenFor, setTokenFor] = useState(null);
  const test = (c) => post(`/channels/${c.id}/test`).then((r) => toast(`Funcionando: ${r.info.verified_name || r.info.display_phone_number || r.info.name || 'ok'}`)).catch(fail);
  const chs = B().channels;
  return html`<div class="col" style="max-width:760px">
    <div class="row"><h2 class="grow">Canais</h2><button class="btn" onClick=${() => setAdd(true)}>+ API da Meta / Messenger / Instagram</button></div>
    <${WebNumbers} />
    ${!B().meta.has_app_secret && chs.some((c) => c.mode !== 'web' && c.mode !== 'imap') && html`<div class="banner warn">Falta a chave secreta do app em Configurações > Geral. Sem ela o CRM recusa as mensagens que chegam.</div>`}

    ${chs.map((c) => html`<div class="card pad row wrap">
      <div class="grow"><strong>${c.name}</strong><div class="small muted">${c.mode === 'web' ? `WhatsApp Web${c.me ? ` · ${c.me}` : ''}` : c.mode === 'imap' ? `Respostas por e-mail · ${c.external_id}` : `${KIND[c.kind]} · ID ${c.external_id}`}</div></div>
      <span class=${`pill ${c.status === 'active' ? 'ok' : c.status === 'error' ? 'danger' : ''}`}>${{ active: 'Ativo', error: 'Com erro', disabled: 'Desligado' }[c.status]}</span>
      <select aria-label="Funil dos novos leads" value=${c.pipeline_id || ''} onChange=${(e) => patch(`/channels/${c.id}`, { pipeline_id: Number(e.target.value) }).catch(fail)}>
        ${B().pipelines.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>
      <button class="btn sm" onClick=${() => test(c)}>Testar</button>
      ${c.mode !== 'web' && html`<button class="btn sm" onClick=${() => setTokenFor(c)}>Editar</button>`}
      <button class="btn sm" onClick=${() => patch(`/channels/${c.id}`, { status: c.status === 'disabled' ? 'active' : 'disabled' }).catch(fail)}>${c.status === 'disabled' ? 'Religar' : 'Desligar'}</button>
    </div>`)}
    ${add && html`<${ChannelModal} onClose=${() => setAdd(false)} />`}
    ${tokenFor && html`<${TokenModal} c=${tokenFor} onClose=${() => setTokenFor(null)} />`}
  </div>`;
}
function TokenModal({ c, onClose }) {
  const [t, setT] = useState('');
  const [waba, setWaba] = useState(c.waba_id || '');
  return html`<${Modal} title=${`Editar ${c.name}`} onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancelar</button>
    <button class="btn primary" onClick=${() => patch(`/channels/${c.id}`, { ...(t.trim() && { token: t }), ...(c.kind === 'whatsapp' && { waba_id: waba }) }).then(() => { toast('Salvo'); onClose(); }).catch(fail)}>Salvar</button>`}>
    <div class="form">${c.kind === 'whatsapp' && html`<label class="field">ID da conta do WhatsApp (WABA ID)<input value=${waba} onInput=${(e) => setWaba(e.target.value)} /></label>`}
    <label class="field">Novo token (deixe vazio para manter)<input type="password" autocomplete="new-password" value=${t} onInput=${(e) => setT(e.target.value)} /></label></div><//>`;
}


const TSTATUS = { APPROVED: ['Aprovado', 'ok'], PENDING: ['Em análise', 'warn'], REJECTED: ['Rejeitado', 'danger'], PAUSED: ['Pausado', 'warn'], DISABLED: ['Desativado', 'danger'] };
function Templates() {
  const chans = B().channels.filter((c) => c.kind === 'whatsapp');
  const [list, setList] = useState(null);
  const [f, setF] = useState({ channel_id: chans[0]?.id, name: '', category: 'UTILITY', body: 'Olá {{1}}, tudo bem? ', examples: [] });
  const [busy, setBusy] = useState(false);
  const load = () => api('/templates').then(setList).catch(fail);
  useEffect(() => { load(); }, [B()]);
  const vars = [...new Set([...f.body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];
  const sync = () => { setBusy(true); post('/templates/sync').then((r) => { toast(`${r.count} modelos sincronizados`); load(); }).catch(fail).finally(() => setBusy(false)); };
  const create = (e) => { e.preventDefault(); setBusy(true);
    post('/templates', { ...f, language: 'pt_BR' }).then((r) => { toast(`Modelo "${r.name}" enviado para análise da Meta`); setF({ ...f, name: '', body: 'Olá {{1}}, tudo bem? ', examples: [] }); load(); })
      .catch(fail).finally(() => setBusy(false)); };
  if (!chans.length) return html`<${Empty} title="Conecte o WhatsApp primeiro"><a class="btn primary" href="#/settings/channels">Conectar canal</a><//>`;
  const noWaba = chans.some((c) => !c.waba_id);
  return html`<div class="col" style="max-width:760px">
    <div class="row"><h2 class="grow">Modelos do WhatsApp</h2><button class="btn" disabled=${busy || noWaba} onClick=${sync}>Buscar da Meta</button></div>
    <p class="small muted">Para falar com quem não escreveu nas últimas 24 h (ou nunca escreveu), o WhatsApp exige uma mensagem modelo aprovada pela Meta. A Meta cobra por conversa iniciada.</p>
    ${noWaba && html`<div class="banner warn">Falta o ID da conta do WhatsApp (WABA ID) no canal. Preencha em Configurações > Canais > Editar.</div>`}
    <div class="card pad">
      ${list && !list.length && html`<p class="small muted">Nenhum modelo ainda.</p>`}
      ${(list || []).map((t) => { const st = TSTATUS[t.status] || [t.status, '']; return html`<div class="list-row">
        <div class="grow"><strong>${t.name}</strong> <span class="xs muted">${t.language} · ${t.category === 'MARKETING' ? 'marketing' : 'utilidade'}</span>
          <div class="small muted">${t.preview}</div>${!t.supported && html`<div class=${`xs ${t.header_media === 'IMAGE' ? 'muted' : 'error-text'}`}>${t.header_media === 'IMAGE' ? 'Tem imagem no topo: use em Campanhas (a imagem é escolhida lá).' : 'Tem vídeo, documento ou botão variável: ainda não dá para enviar daqui.'}</div>`}</div>
        <span class=${`pill ${st[1]}`}>${st[0]}</span></div>`; })}
    </div>
    <form class="card pad form" onSubmit=${create}><h3>Novo modelo</h3>
      ${chans.length > 1 && html`<label class="field">Número<select value=${f.channel_id} onChange=${(e) => setF({ ...f, channel_id: Number(e.target.value) })}>${chans.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></label>`}
      <div class="row wrap"><label class="field grow">Nome (minúsculas, sem espaço)<input required placeholder="retomar_contato" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></label>
        <label class="field">Tipo<select value=${f.category} onChange=${(e) => setF({ ...f, category: e.target.value })}><option value="UTILITY">Utilidade (aviso, pedido, retorno)</option><option value="MARKETING">Marketing (oferta, promoção)</option></select></label></div>
      <label class="field">Texto. Use {{1}}, {{2}} para partes que mudam (ex.: nome)<textarea rows="4" required value=${f.body} onInput=${(e) => setF({ ...f, body: e.target.value })}></textarea></label>
      ${vars.map((v, i) => html`<label class="field">Exemplo para {{${v}}} (a Meta exige)<input required value=${f.examples[i] || ''} onInput=${(e) => { const n = [...f.examples]; n[i] = e.target.value; setF({ ...f, examples: n }); }} /></label>`)}
      <p class="xs muted">A Meta recusa modelos de "utilidade" com cara de propaganda, e textos que começam ou terminam com variável.</p>
      <button class="btn primary" style="align-self:flex-start" disabled=${busy || noWaba}>Enviar para aprovação</button>
    </form>
  </div>`;
}

function Pipelines() {
  const pipes = B().pipelines;
  const [pid, setPid] = useState(pipes[0].id);
  const p = pipes.find((x) => x.id === pid) || pipes[0];
  const [ask, setAsk] = useState(null);
  const normal = p.stages.filter((s) => s.kind === 'normal');
  const swap = (i, j) => { const ids = normal.map((s) => s.id); [ids[i], ids[j]] = [ids[j], ids[i]]; post('/stages/reorder', { ids }).catch(fail); };
  const newPipe = () => post('/pipelines', { name: 'Novo funil' }).then((r) => setPid(r.id)).catch(fail);
  return html`<div class="col" style="max-width:640px">
    <div class="row wrap"><select aria-label="Funil" value=${p.id} onChange=${(e) => setPid(Number(e.target.value))}>${pipes.map((x) => html`<option value=${x.id}>${x.name}</option>`)}</select>
      <input aria-label="Nome do funil" key=${'n' + p.id} defaultValue=${p.name} onBlur=${(e) => e.target.value.trim() && e.target.value !== p.name && patch(`/pipelines/${p.id}`, { name: e.target.value }).catch(fail)} />
      <span class="spacer"></span><button class="btn" onClick=${newPipe}>+ Funil</button>
      ${pipes.length > 1 && html`<button class="btn danger" onClick=${() => setAsk({ t: 'p' })}>Apagar funil</button>`}</div>
    <div class="card pad">
      ${p.stages.map((s) => { const i = normal.indexOf(s); return html`<div class="list-row" key=${s.id}>
        <input type="color" aria-label=${`Cor de ${s.name}`} value=${s.color} onChange=${(e) => patch(`/stages/${s.id}`, { color: e.target.value }).catch(fail)} />
        <input class="grow" aria-label="Nome da etapa" key=${'s' + s.id + s.name} defaultValue=${s.name} onBlur=${(e) => e.target.value.trim() && e.target.value !== s.name && patch(`/stages/${s.id}`, { name: e.target.value }).catch(fail)} />
        ${s.kind === 'normal' ? html`
          <button class="btn ghost sm" aria-label="Subir" disabled=${i === 0} onClick=${() => swap(i, i - 1)}>↑</button>
          <button class="btn ghost sm" aria-label="Descer" disabled=${i === normal.length - 1} onClick=${() => swap(i, i + 1)}>↓</button>
          <button class="btn ghost sm" aria-label=${`Apagar ${s.name}`} onClick=${() => setAsk({ t: 's', s })}>✕</button>`
          : html`<span class="xs muted" style="width:96px">${{ incoming: 'entrada', won: 'ganho', lost: 'perdido' }[s.kind]}</span>`}
      </div>`; })}
      <button class="btn" style="margin-top:8px" onClick=${() => post('/stages', { pipeline_id: p.id, name: 'Nova etapa' }).catch(fail)}>+ Etapa</button>
    </div>
    <p class="small muted">"Novas conversas" segura as mensagens de clientes novos até alguém aceitar. Ganho e perdido são fixos.</p>
    ${ask && html`<${Confirm} title=${ask.t === 'p' ? `Apagar o funil ${p.name}?` : `Apagar a etapa ${ask.s.name}?`} text="Só dá para apagar se estiver vazio." danger okLabel="Apagar"
      onOk=${() => (ask.t === 'p' ? del(`/pipelines/${p.id}`).then(() => setPid(pipes.find((x) => x.id !== p.id).id)) : del(`/stages/${ask.s.id}`))} onClose=${() => setAsk(null)} />`}
  </div>`;
}

function UserModal({ u, onClose }) {
  const roles = B().roles;
  const [f, setF] = useState(u ? { name: u.name, email: u.email, role_id: u.role_id, is_admin: !!u.is_admin, password: '' } : { name: '', email: '', password: '', role_id: roles.find((r) => r.name === 'Atendente')?.id || roles[0]?.id, is_admin: false });
  const save = (e) => { e.preventDefault(); const b = { ...f }; if (u && !b.password) delete b.password;
    (u ? patch(`/users/${u.id}`, b) : post('/users', b)).then(() => { toast(u ? 'Salvo' : 'Usuário criado. Passe o email e a senha para a pessoa.'); onClose(); }).catch(fail); };
  return html`<${Modal} title=${u ? 'Editar usuário' : 'Adicionar pessoa'} onClose=${onClose}><form class="form" onSubmit=${save}>
    <label class="field">Nome<input required value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></label>
    <label class="field">Email (login)<input required type="email" value=${f.email} onInput=${(e) => setF({ ...f, email: e.target.value })} /></label>
    <label class="field">${u ? 'Nova senha (deixe vazio para manter)' : 'Senha inicial (mín. 8)'}<input type="text" autocomplete="off" required=${!u} minlength="8" value=${f.password} onInput=${(e) => setF({ ...f, password: e.target.value })} /></label>
    <label class="field">Função<select value=${f.role_id || ''} onChange=${(e) => setF({ ...f, role_id: Number(e.target.value) || null })}>${roles.map((r) => html`<option value=${r.id}>${r.name}</option>`)}</select></label>
    <label class="row small"><input type="checkbox" checked=${f.is_admin} onChange=${(e) => setF({ ...f, is_admin: e.target.checked })} /> Administrador (vê tudo e mexe nas configurações)</label>
    <div class="row"><span class="spacer"></span><button type="button" class="btn" onClick=${onClose}>Cancelar</button><button class="btn primary">Salvar</button></div>
  </form><//>`;
}

function DeactivateModal({ u, onClose }) {
  const [to, setTo] = useState(null);
  return html`<${Modal} title=${`Desativar ${u.name}?`} onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancelar</button>
    <button class="btn danger" onClick=${() => patch(`/users/${u.id}`, { is_active: false, reassign_to: to }).then(onClose).catch(fail)}>Desativar</button>`}>
    <p>A pessoa perde o acesso na hora. Os leads, contatos e tarefas abertas dela vão para:</p>
    <${UserSelect} label="Passar para" none="Ninguém (ficam sem responsável)" value=${to} onChange=${setTo} />
  <//>`;
}

function Users() {
  const [edit, setEdit] = useState(null);
  const [off, setOff] = useState(null);
  const roles = B().roles;
  return html`<div class="col" style="max-width:800px">
    <div class="row"><h2 class="grow">Equipe</h2><button class="btn primary" onClick=${() => setEdit({})}>+ Pessoa</button></div>
    <table class="t card"><thead><tr><th>Nome</th><th class="hide-sm">Email</th><th>Função</th><th></th></tr></thead><tbody>
    ${B().users.map((u) => html`<tr style=${u.is_active ? '' : 'opacity:.55'}><td>${u.name}${u.is_admin ? html` <span class="pill xs">admin</span>` : ''}${u.is_active ? '' : ' (inativo)'}</td>
      <td class="hide-sm">${u.email}</td><td>${roles.find((r) => r.id === u.role_id)?.name || '—'}</td>
      <td class="row"><button class="btn sm" onClick=${() => setEdit(u)}>Editar</button>
        ${u.id !== B().user.id && (u.is_active ? html`<button class="btn sm" onClick=${() => setOff(u)}>Desativar</button>` : html`<button class="btn sm" onClick=${() => patch(`/users/${u.id}`, { is_active: true }).catch(fail)}>Reativar</button>`)}</td></tr>`)}
    </tbody></table>
    ${edit && html`<${UserModal} u=${edit.id ? edit : null} onClose=${() => setEdit(null)} />`}
    ${off && html`<${DeactivateModal} u=${off} onClose=${() => setOff(null)} />`}
  </div>`;
}

const ENTS = [['leads', 'Leads'], ['contacts', 'Contatos'], ['companies', 'Empresas']];
function Roles() {
  const roles = B().roles;
  const set = (r, ent, key, val) => patch(`/roles/${r.id}`, { rights: { ...r.rights, [ent]: { ...(r.rights[ent] || {}), [key]: val } } }).catch(fail);
  return html`<div class="col" style="max-width:860px">
    <div class="row"><h2 class="grow">Permissões por função</h2><button class="btn" onClick=${() => post('/roles', { name: 'Nova função', rights: { leads: { view: 'own', edit: 'own', del: false }, contacts: { view: 'all', edit: 'own', del: false }, companies: { view: 'all', edit: 'own', del: false } } }).catch(fail)}>+ Função</button></div>
    <p class="small muted">Administradores sempre veem e editam tudo. "Só os seus" = registros em que a pessoa é a responsável. Conversas sem responsável aparecem para todos, para alguém atender.</p>
    ${roles.map((r) => html`<div class="card pad col">
      <div class="row"><input aria-label="Nome da função" key=${'r' + r.id + r.name} defaultValue=${r.name} onBlur=${(e) => e.target.value.trim() && e.target.value !== r.name && patch(`/roles/${r.id}`, { name: e.target.value }).catch(fail)} />
        <span class="spacer"></span><button class="btn ghost sm" onClick=${() => del(`/roles/${r.id}`).catch(fail)}>Apagar</button></div>
      <table class="t"><thead><tr><th></th><th>Ver</th><th>Editar</th><th>Apagar</th></tr></thead><tbody>
      ${ENTS.map(([k, label]) => { const x = r.rights[k] || {}; return html`<tr><td>${label}</td>
        <td><select aria-label=${`${label}: ver`} value=${x.view || 'own'} onChange=${(e) => set(r, k, 'view', e.target.value)}><option value="all">Todos</option><option value="own">Só os seus</option></select></td>
        <td><select aria-label=${`${label}: editar`} value=${x.edit || 'none'} onChange=${(e) => set(r, k, 'edit', e.target.value)}><option value="all">Todos</option><option value="own">Só os seus</option><option value="none">Nenhum</option></select></td>
        <td><input type="checkbox" aria-label=${`${label}: apagar`} checked=${!!x.del} onChange=${(e) => set(r, k, 'del', e.target.checked)} /></td></tr>`; })}
      </tbody></table></div>`)}
  </div>`;
}

const FTYPES = { text: 'Texto', textarea: 'Texto longo', number: 'Número', money: 'Valor (R$)', date: 'Data', select: 'Lista (uma opção)', multiselect: 'Lista (várias)', checkbox: 'Sim/não', url: 'Link' };
function Fields() {
  const [ent, setEnt] = useState('lead');
  const [f, setF] = useState({ name: '', type: 'text', options: '' });
  const list = B().fields.filter((x) => x.entity === ent);
  const add = (e) => { e.preventDefault(); post('/fields', { entity: ent, name: f.name, type: f.type, options: f.options.split(',').map((s) => s.trim()).filter(Boolean) })
    .then(() => setF({ name: '', type: 'text', options: '' })).catch(fail); };
  const [ask, setAsk] = useState(null);
  return html`<div class="col" style="max-width:640px">
    <h2>Campos personalizados</h2>
    <div class="tabs" role="tablist">${[['lead', 'Lead'], ['contact', 'Contato'], ['company', 'Empresa']].map(([k, l]) => html`<button role="tab" aria-selected=${ent === k} onClick=${() => setEnt(k)}>${l}</button>`)}</div>
    <div class="card pad">
      ${list.map((x) => html`<div class="list-row"><strong class="grow">${x.name}</strong><span class="small muted">${FTYPES[x.type]}${x.options.length ? `: ${x.options.join(', ')}` : ''}</span>
        <button class="btn ghost sm" aria-label=${`Apagar campo ${x.name}`} onClick=${() => setAsk(x)}>✕</button></div>`)}
      ${!list.length && html`<p class="small muted">Nenhum campo extra. Exemplos: "Origem", "CPF", "Data do evento".</p>`}
      <form class="row wrap" style="margin-top:12px" onSubmit=${add}>
        <input aria-label="Nome do campo" placeholder="Nome do campo" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} />
        <select aria-label="Tipo" value=${f.type} onChange=${(e) => setF({ ...f, type: e.target.value })}>${Object.entries(FTYPES).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select>
        ${(f.type === 'select' || f.type === 'multiselect') && html`<input aria-label="Opções" placeholder="Opções, separadas por vírgula" class="grow" value=${f.options} onInput=${(e) => setF({ ...f, options: e.target.value })} />`}
        <button class="btn primary" disabled=${!f.name.trim()}>Adicionar</button>
      </form>
    </div>
    ${ask && html`<${Confirm} title=${`Apagar o campo ${ask.name}?`} text="Os valores preenchidos neste campo também somem." danger okLabel="Apagar" onOk=${() => del(`/fields/${ask.id}`)} onClose=${() => setAsk(null)} />`}
  </div>`;
}

function SimpleList({ title, items, route, color, hint }) {
  const [name, setName] = useState('');
  const [c, setC] = useState('#cfe3ff');
  const add = (e) => { e.preventDefault(); post(`/${route}`, { name, color: c }).then(() => setName('')).catch(fail); };
  return html`<div class="card pad col"><h3>${title}</h3>${hint && html`<p class="small muted">${hint}</p>`}
    ${items.map((x) => html`<div class="list-row">
      ${color && html`<input type="color" aria-label=${`Cor de ${x.name}`} value=${x.color} onChange=${(e) => patch(`/${route}/${x.id}`, { color: e.target.value }).catch(fail)} />`}
      <span class="grow">${x.name}</span><button class="btn ghost sm" aria-label=${`Apagar ${x.name}`} onClick=${() => del(`/${route}/${x.id}`).catch(fail)}>✕</button></div>`)}
    <form class="row" onSubmit=${add}>${color && html`<input type="color" aria-label="Cor" value=${c} onInput=${(e) => setC(e.target.value)} />`}
      <input class="grow" aria-label=${`Novo item em ${title}`} placeholder="Novo" value=${name} onInput=${(e) => setName(e.target.value)} /><button class="btn" disabled=${!name.trim()}>Adicionar</button></form>
  </div>`;
}
function Lists() {
  const b = B();
  return html`<div class="col" style="max-width:640px">
    <${SimpleList} title="Tags" items=${b.tags} route="tags" color hint="Tags novas também nascem ao digitar no cartão do lead." />
    <${SimpleList} title="Tipos de tarefa" items=${b.task_types} route="task-types" />
    <${SimpleList} title="Motivos de perda" items=${b.loss_reasons} route="loss-reasons" />
  </div>`;
}

export function SettingsPage({ section }) {
  const isAdmin = B().user.is_admin;
  const sec = isAdmin ? section || (B().billing?.plan === 'interno' ? 'general' : 'plano') : 'account';
  const View = { plano: Plano, general: General, channels: Channels, templates: Templates, email: EmailSettings, ai: AiSettings, resumo: Resumo, quick: QuickReplies, pipelines: Pipelines, users: Users, roles: Roles, fields: Fields, lists: Lists, account: Account }[sec] || General;
  return html`<div class="main"><div class="topbar"><h1>Configurações</h1></div><div class="page"><div class="settings">
    <nav aria-label="Seções">${SECTIONS.filter(([k]) => isAdmin || k === 'account').map(([k, l]) => html`<a href=${`#/settings/${k}`} aria-current=${sec === k ? 'page' : null}>${l}</a>`)}</nav>
    <div><${View} /></div>
  </div></div></div>`;
}
