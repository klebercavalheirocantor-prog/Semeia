import { html, render, useState, useEffect, useRef, useMemo, useCallback } from '/vendor/preact.mjs';
export { html, render, useState, useEffect, useRef, useMemo, useCallback };

// ---------- API
// Empresa escolhida na setinha do menu (AgroVox, AgroPool...). Vai em todo pedido; cada aba lembra a sua.
const BRAND_KEY = 'crm-brand';
export const currentBrand = () => { try { return Number(localStorage.getItem(BRAND_KEY)) || 1; } catch { return 1; } };
export function switchBrand(id) {
  try { localStorage.setItem(BRAND_KEY, String(id)); } catch {}
  location.hash = '#/dashboard';
  location.reload();
}

export async function api(path, { method, body, raw, headers } = {}) {
  const o = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-crm': '1', 'x-brand': String(currentBrand()), ...(headers || {}) } };
  if (body !== undefined) {
    if (raw) o.body = body;
    else { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  }
  const r = await fetch('/api' + path, o);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login' && path !== '/me') { location.hash = '#/login'; location.reload(); }
  if (!r.ok) throw new Error(d.error || `Erro ${r.status}`);
  return d;
}
export const post = (p, b = {}) => api(p, { method: 'POST', body: b });
export const patch = (p, b) => api(p, { method: 'PATCH', body: b });
export const del = (p) => api(p, { method: 'DELETE' });

// ---------- dados globais (usuário, funis, campos...) e eventos ao vivo
const subs = new Set();
const live = new Set();
export const store = { boot: null };
export const B = () => store.boot;
export async function loadBoot() {
  store.boot = await api('/me');
  subs.forEach((f) => f());
}
export function useBoot() {
  const [, set] = useState(0);
  useEffect(() => { const f = () => set((x) => x + 1); subs.add(f); return () => subs.delete(f); }, []);
  return store.boot;
}
let es;
export function startStream() {
  if (es) return;
  es = new EventSource('/api/stream');
  let t;
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'config' || d.type === 'message') { clearTimeout(t); t = setTimeout(() => loadBoot().catch(() => {}), 400); }
    live.forEach((f) => f(d));
  };
}

// Carrega dados e recarrega sozinho quando chega um evento dos tipos indicados.
export function useData(fn, deps, types = []) {
  const [st, set] = useState({ loading: true, data: null, error: null });
  const ref = useRef(fn);
  ref.current = fn;
  const load = useCallback(() => ref.current().then((data) => set({ loading: false, data, error: null }), (e) => set((s) => ({ ...s, loading: false, error: e.message }))), []);
  useEffect(() => { set((s) => ({ ...s, loading: true })); load(); }, deps);
  useEffect(() => {
    let t;
    const f = (d) => { if (types.includes(d.type)) { clearTimeout(t); t = setTimeout(load, 250); } };
    live.add(f);
    return () => { live.delete(f); clearTimeout(t); };
  }, deps);
  return { ...st, reload: load, setData: (data) => set((s) => ({ ...s, data: typeof data === 'function' ? data(s.data) : data })) };
}

// ---------- rotas (hash)
export function useRoute() {
  const [h, set] = useState(location.hash);
  useEffect(() => { const f = () => set(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const [p, qs] = (h.slice(1) || '/leads').split('?');
  return { parts: p.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
export const go = (p) => { location.hash = p; };

// ---------- avisos
const toastSubs = new Set();
let toasts = [];
export function toast(text, kind = 'info') {
  const t = { id: Math.random(), text, kind };
  toasts = [...toasts, t];
  toastSubs.forEach((f) => f(toasts));
  setTimeout(() => { toasts = toasts.filter((x) => x !== t); toastSubs.forEach((f) => f(toasts)); }, kind === 'error' ? 6000 : 3000);
}
export const fail = (e) => toast(e.message || String(e), 'error');
export function Toasts() {
  const [list, set] = useState(toasts);
  useEffect(() => { toastSubs.add(set); return () => toastSubs.delete(set); }, []);
  return html`<div class="toasts" role="status" aria-live="polite">${list.map((t) => html`<div class="toast ${t.kind}" key=${t.id}>${t.text}</div>`)}</div>`;
}

// ---------- formatação
export const money = (cents) => ((cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: B()?.general?.currency || 'BRL', maximumFractionDigits: (cents || 0) % 100 ? 2 : 0 });
export const parseMoney = (s) => Math.round(Number(String(s).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) * 100) || 0;
const df = (o) => new Intl.DateTimeFormat('pt-BR', o);
export const fmtDay = (ms) => df({ weekday: 'long', day: '2-digit', month: 'long' }).format(ms);
export const fmtTime = (ms) => df({ hour: '2-digit', minute: '2-digit' }).format(ms);
export const fmtDateTime = (ms) => df({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms);
export const dayKey = (ms) => new Date(ms).toDateString();
export function ago(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60e3) return 'agora';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} min`;
  if (dayKey(ms) === dayKey(Date.now())) return fmtTime(ms);
  if (dayKey(ms) === dayKey(Date.now() - 864e5)) return 'ontem';
  return df({ day: '2-digit', month: '2-digit' }).format(ms);
}
export function dueLabel(ms) {
  const today = dayKey(Date.now());
  if (dayKey(ms) === today) return `hoje ${fmtTime(ms)}`;
  if (dayKey(ms) === dayKey(Date.now() + 864e5)) return `amanhã ${fmtTime(ms)}`;
  return fmtDateTime(ms);
}
export const toLocalInput = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };
export const endOfDay = (plusDays = 0) => { const d = new Date(); d.setDate(d.getDate() + plusDays); d.setHours(18, 0, 0, 0); return d.getTime(); };

export const userName = (id) => B()?.users.find((u) => u.id === id)?.name || '';
export const stageById = (id) => { for (const p of B()?.pipelines || []) { const s = p.stages.find((x) => x.id === id); if (s) return { ...s, pipeline: p }; } return null; };
export const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

// ---------- componentes pequenos
export const Avatar = ({ name }) => html`<span class="avatar" aria-hidden="true">${initials(name)}</span>`;
const CH = { whatsapp: ['WA', 'WhatsApp'], instagram: ['IG', 'Instagram'], messenger: ['FB', 'Messenger'], email: ['@', 'E-mail'] };
export const Channel = ({ kind }) => kind ? html`<span class="ch ${kind}" title=${CH[kind]?.[1]}>${CH[kind]?.[0]}<span class="sr-only"> ${CH[kind]?.[1]}</span></span>` : null;
export const Tag = ({ t }) => html`<span class="tag" style=${`--tag-color:${t.color}`}>${t.name}</span>`;
export const Skeleton = ({ rows = 4, h = 56 }) => html`<div class="col" aria-busy="true" aria-label="Carregando">${Array.from({ length: rows }, () => html`<div class="skel" style=${`height:${h}px`}></div>`)}</div>`;
export const Empty = ({ title, children }) => html`<div class="empty"><h3>${title}</h3>${children}</div>`;
export const ErrorBox = ({ error, retry }) => html`<div class="empty"><h3>Não deu para carregar</h3><p>${error}</p>${retry && html`<button class="btn" onClick=${retry}>Tentar de novo</button>`}</div>`;

export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef();
  useEffect(() => { ref.current.showModal(); }, []);
  return html`<dialog ref=${ref} onClose=${onClose} onCancel=${(e) => { e.preventDefault(); onClose(); }} style=${wide ? 'width:min(760px, calc(100vw - 32px))' : ''} aria-label=${title}>
    <div class="modal-head"><h2 class="grow">${title}</h2><button class="btn ghost icon" onClick=${onClose} aria-label="Fechar">✕</button></div>
    <div class="modal-body">${children}</div>
    ${footer && html`<div class="modal-foot">${footer}</div>`}
  </dialog>`;
}

export function Confirm({ title, text, danger, okLabel = 'Confirmar', onOk, onClose }) {
  const [busy, setBusy] = useState(false);
  return html`<${Modal} title=${title} onClose=${onClose} footer=${html`
    <button class="btn" onClick=${onClose}>Cancelar</button>
    <button class="btn ${danger ? 'danger' : 'primary'}" disabled=${busy} onClick=${async () => { setBusy(true); try { await onOk(); onClose(); } catch (e) { fail(e); setBusy(false); } }}>${okLabel}</button>`}>
    <p>${text}</p>
  <//>`;
}

export function UserSelect({ value, onChange, none = 'Sem responsável', label, id, disabled }) {
  const users = (B()?.users || []).filter((u) => u.is_active || u.id === value);
  return html`<select id=${id} disabled=${disabled} aria-label=${label || 'Responsável'} value=${value || ''} onChange=${(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
    ${none !== false && html`<option value="">${none}</option>`}
    ${users.map((u) => html`<option value=${u.id}>${u.name}${u.is_active ? '' : ' (inativo)'}</option>`)}
  </select>`;
}

export function StageSelect({ value, onChange, pipelineId, label = 'Etapa', id, disabled }) {
  const pipes = (B()?.pipelines || []).filter((p) => !pipelineId || p.id === pipelineId);
  return html`<select id=${id} disabled=${disabled} aria-label=${label} value=${value || ''} onChange=${(e) => onChange(Number(e.target.value))}>
    ${pipes.map((p) => html`<optgroup label=${p.name}>${p.stages.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</optgroup>`)}
  </select>`;
}

export function TagEditor({ tags, onChange, disabled }) {
  const [txt, setTxt] = useState('');
  const names = tags.map((t) => t.name);
  const add = () => { const n = txt.trim(); if (n && !names.includes(n)) onChange([...names, n]); setTxt(''); };
  return html`<div class="col">
    <div class="row wrap">${tags.map((t) => html`<span class="tag" style=${`--tag-color:${t.color}`}>${t.name}
      ${!disabled && html` <button class="btn ghost sm" style="height:16px;padding:0 2px" aria-label=${`Tirar tag ${t.name}`} onClick=${() => onChange(names.filter((n) => n !== t.name))}>✕</button>`}</span>`)}</div>
    ${!disabled && html`<div class="row"><input list="all-tags" placeholder="Adicionar tag" aria-label="Adicionar tag" value=${txt} onInput=${(e) => setTxt(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} class="grow" />
      <datalist id="all-tags">${(B()?.tags || []).map((t) => html`<option value=${t.name} />`)}</datalist>
      <button class="btn sm" onClick=${add} disabled=${!txt.trim()}>+</button></div>`}
  </div>`;
}

// Campo personalizado: salva ao sair do campo (ou ao mudar, nos de escolha).
export function FieldInput({ f, value, onSave, disabled }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const id = `f${f.id}`;
  const save = (x) => { if (JSON.stringify(x) !== JSON.stringify(value ?? '')) onSave(x); };
  let input;
  if (f.type === 'select') input = html`<select id=${id} disabled=${disabled} value=${v} onChange=${(e) => { setV(e.target.value); save(e.target.value); }}><option value="">—</option>${f.options.map((o) => html`<option value=${o}>${o}</option>`)}</select>`;
  else if (f.type === 'multiselect') input = html`<div class="row wrap">${f.options.map((o) => { const on = (v || []).includes(o); return html`<label class="row small"><input type="checkbox" disabled=${disabled} checked=${on} onChange=${() => { const n = on ? v.filter((x) => x !== o) : [...(v || []), o]; setV(n); save(n); }} />${o}</label>`; })}</div>`;
  else if (f.type === 'checkbox') input = html`<input id=${id} type="checkbox" disabled=${disabled} checked=${!!v} onChange=${(e) => { setV(e.target.checked); save(e.target.checked); }} />`;
  else if (f.type === 'textarea') input = html`<textarea id=${id} disabled=${disabled} rows="2" value=${v} onInput=${(e) => setV(e.target.value)} onBlur=${() => save(v)}></textarea>`;
  else {
    const type = { number: 'number', money: 'text', date: 'date', url: 'url' }[f.type] || 'text';
    const shown = f.type === 'money' && typeof v === 'number' ? money(v) : v;
    input = html`<input id=${id} type=${type} disabled=${disabled} value=${shown} onInput=${(e) => setV(e.target.value)}
      onBlur=${() => save(f.type === 'money' ? (v === '' ? '' : parseMoney(v)) : f.type === 'number' ? (v === '' ? '' : Number(v)) : v)} />`;
  }
  return html`<label for=${id} class="small muted ellipsis" title=${f.name}>${f.name}</label>${input}`;
}

export function Fields({ entity, values, onSave, disabled }) {
  const fs = (B()?.fields || []).filter((f) => f.entity === entity);
  if (!fs.length) return null;
  return html`<div class="kv">${fs.map((f) => html`<${FieldInput} key=${f.id} f=${f} value=${values[f.id]} disabled=${disabled} onSave=${(val) => onSave({ [f.id]: val })} />`)}</div>`;
}

// Debounce simples para buscas
export function useDebounced(value, ms = 300) {
  const [v, set] = useState(value);
  useEffect(() => { const t = setTimeout(() => set(value), ms); return () => clearTimeout(t); }, [value]);
  return v;
}
