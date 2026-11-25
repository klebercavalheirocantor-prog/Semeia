import { html, render, useState, useEffect, api, post, fail, loadBoot, useBoot, startStream, useRoute, Toasts, B, switchBrand } from './lib.js';
import { LeadsPage } from './pages/leads.js';
import { LeadPage } from './pages/lead.js';
import { InboxPage } from './pages/inbox.js';
import { ContactsPage, ContactPage, CompaniesPage, CompanyPage } from './pages/contacts.js';
import { TasksPage } from './pages/tasks.js';
import { SettingsPage } from './pages/settings.js';
import { DashboardPage } from './pages/dashboard.js';
import { CampaignsPage, CampaignPage } from './pages/campaigns.js';
import { FlowsPage, FlowPage } from './pages/flows.js';

const icon = (d) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  dashboard: icon(html`<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />`),
  flows: icon(html`<circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7 6h10M6 8l5 8M18 8l-5 8" />`),
  campaigns: icon(html`<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14" />`),
  leads: icon(html`<rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" />`),
  chats: icon(html`<path d="M4 5h16v11H9l-5 4z" />`),
  contacts: icon(html`<circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" />`),
  tasks: icon(html`<rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 12l3 3 5-6" />`),
  settings: icon(html`<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />`),
};

function Auth({ setup }) {
  const [f, setF] = useState({ company: '', name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await post(setup ? '/setup' : '/login', f);
      location.hash = '#/leads';
      location.reload();
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return html`<main class="auth"><form class="card pad form" onSubmit=${submit}>
    <div class="auth-brand"><img src="/logo.svg" alt="" width="56" height="56" /><div><strong aria-label="Fechaê"><span class="wordmark">fecha<span class="wm-e">e<svg viewBox="0 0 48 32" aria-hidden="true"><path d="M5 17 L18 28 L43 4" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span></strong><span>CRM que fecha venda</span></div></div>
    <h1>${setup ? 'Bem-vindo ao Fechaê' : 'Entrar'}</h1>
    ${setup && html`<p class="small muted">Crie a conta do administrador. Depois você convida a equipe.</p>
      <label class="field">Nome da empresa<input value=${f.company} onInput=${set('company')} /></label>
      <label class="field">Seu nome<input required value=${f.name} onInput=${set('name')} /></label>`}
    <label class="field">Email<input required type="email" autocomplete="username" autofocus value=${f.email} onInput=${set('email')} /></label>
    <label class="field">Senha${setup ? ' (mín. 8 caracteres)' : ''}<input required type="password" minlength=${setup ? 8 : undefined} autocomplete=${setup ? 'new-password' : 'current-password'} value=${f.password} onInput=${set('password')} /></label>
    ${err && html`<p class="error-text" role="alert">${err}</p>`}
    <button class="btn primary" disabled=${busy}>${setup ? 'Criar e entrar' : 'Entrar'}</button>
    ${!setup && html`<p class="xs muted">Esqueceu a senha? Peça ao administrador para trocar em Configurações > Equipe.</p>`}
  </form></main>`;
}

function Nav({ current }) {
  const b = B();
  const item = (key, href, label, badge) => html`<a href=${href} aria-current=${current === key ? 'page' : null}>${ICONS[key]}<span>${label}</span>
    ${badge > 0 && html`<span class="badge" aria-label=${`${badge} não lidas`}>${badge > 99 ? '99+' : badge}</span>`}</a>`;
  return html`<nav class="nav" aria-label="Menu principal">
    <a class="nav-mark" href="#/dashboard" title="Fechaê"><img src="/logo.svg" alt="Fechaê" width="34" height="34" /></a>
    ${b.brands?.length > 1
      ? html`<label class="brand-pick" title="Trocar de empresa"><span class="sr-only">Empresa</span>
          <select value=${String(b.brand)} onChange=${(e) => switchBrand(Number(e.target.value))}>${b.brands.map((x) => html`<option value=${String(x.id)}>${x.name}</option>`)}</select></label>`
      : html`<div class="logo" title=${b.general.company}>${b.general.company || 'CRM'}</div>`}
    ${item('dashboard', '#/dashboard', 'Painel')}
    ${item('leads', '#/leads', 'Funil')}
    ${item('chats', '#/chats', 'Conversas', b.unread)}
    ${item('contacts', '#/contacts', 'Contatos')}
    ${b.user.is_admin && item('campaigns', '#/campaigns', 'Campanhas')}
    ${b.user.is_admin && item('flows', '#/flows', 'Fluxos')}
    ${item('tasks', '#/tasks', 'Tarefas')}
    ${item('settings', '#/settings', 'Ajustes')}
    <span class="spacer nav-extra"></span>
    <button class="nav-extra" title=${`Sair (${b.user.name})`} onClick=${() => post('/logout').then(() => location.reload()).catch(fail)}>
      ${icon(html`<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />`)}<span>Sair</span></button>
  </nav>`;
}

function App() {
  const boot = useBoot();
  const { parts, query } = useRoute();
  const [state, setState] = useState('loading');
  useEffect(() => {
    loadBoot().then(() => { setState('in'); startStream(); }).catch(async () => {
      const s = await api('/setup').catch(() => ({ needed: false }));
      setState(s.needed ? 'setup' : 'login');
    });
  }, []);
  // Instalável como app (PWA), igual à AgroPool. Só registra em HTTPS ou no próprio computador.
  useEffect(() => { if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {}); }, []);
  useEffect(() => { document.title = boot?.unread ? `(${boot.unread}) Fechaê` : 'Fechaê'; }, [boot?.unread]);
  if (state === 'loading') return html`<div class="auth muted">Carregando…</div>`;
  if (state !== 'in') return html`<${Auth} setup=${state === 'setup'} />`;
  const [p0, p1, p2] = parts;
  let page, nav = p0;
  if (p0 === 'lead' && p1) { page = html`<${LeadPage} key=${p1} id=${Number(p1)} />`; nav = 'leads'; }
  else if (p0 === 'chats') page = html`<${InboxPage} id=${p1 ? Number(p1) : null} query=${query} />`;
  else if (p0 === 'contacts') page = html`<${ContactsPage} />`;
  else if (p0 === 'contact' && p1) { page = html`<${ContactPage} key=${p1} id=${Number(p1)} />`; nav = 'contacts'; }
  else if (p0 === 'companies') { page = html`<${CompaniesPage} />`; nav = 'contacts'; }
  else if (p0 === 'company' && p1) { page = html`<${CompanyPage} key=${p1} id=${Number(p1)} />`; nav = 'contacts'; }
  else if (p0 === 'tasks') page = html`<${TasksPage} />`;
  else if (p0 === 'dashboard') page = html`<${DashboardPage} />`;
  else if (p0 === 'flows') page = html`<${FlowsPage} />`;
  else if (p0 === 'flow' && p1) { page = html`<${FlowPage} key=${p1} id=${Number(p1)} />`; nav = 'flows'; }
  else if (p0 === 'campaigns') page = html`<${CampaignsPage} />`;
  else if (p0 === 'campaign' && p1) { page = html`<${CampaignPage} key=${p1} id=${p1 === 'new' ? 'new' : Number(p1)} />`; nav = 'campaigns'; }
  else if (p0 === 'settings') page = html`<${SettingsPage} section=${p1} />`;
  else { page = html`<${LeadsPage} key=${query.pipeline || 'x'} query=${query} />`; nav = 'leads'; }
  return html`<div class="shell"><${Nav} current=${nav} />${page}</div><${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
