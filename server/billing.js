// Planos, teste grátis e assinatura pelo Mercado Pago (cobrança mensal automática no cartão).
// O estado de cada empresa fica na lista de empresas (data/plataforma.db), fora do banco dela.
// A empresa nº 1 (AgroVox) e as criadas pelo comando "nova-empresa" são "interno": sem cobrança e sem limite.
import { platform, accountIds } from './db.js';

export const PLANS = {
  essencial: { name: 'Essencial', cents: 19700, users: 2, whatsapp: 1 },
  profissional: { name: 'Profissional', cents: 39700, users: 5, whatsapp: 3 },
  empresa: { name: 'Empresa', cents: 79700, users: 15, whatsapp: 10 },
};
export const TRIAL_DAYS = 7;
export const signupOpen = () => process.env.CADASTRO_ABERTO === '1';

// Colunas da cobrança na lista de empresas (criadas uma vez).
const cols = platform.prepare('pragma table_info(accounts)').all().map((c) => c.name);
for (const [c, def] of [['plan', "text not null default 'interno'"], ['status', "text not null default 'ativo'"], ['trial_until', 'integer'],
  ['mp_id', 'text'], ['email', 'text'], ['phone', 'text']]) {
  if (!cols.includes(c)) platform.exec(`alter table accounts add column ${c} ${def}`);
}

export const accountRow = (id) => platform.prepare('select * from accounts where id = ?').get(id);

// Pode usar o sistema? Interno e assinante ativo sempre; em teste, até o fim do prazo.
export function canUse(id) {
  const a = accountRow(id);
  if (!a || !a.active) return false;
  if (a.plan === 'interno' || a.status === 'ativo') return true;
  return a.status === 'teste' && (a.trial_until || 0) > Date.now();
}

// Limites do plano (interno: sem limite).
export function limits(id) {
  const a = accountRow(id);
  return PLANS[a?.plan] || { users: Infinity, whatsapp: Infinity };
}

export function billingInfo(id) {
  const a = accountRow(id);
  if (!a || a.plan === 'interno') return { plan: 'interno', status: 'ativo', blocked: false };
  const left = a.status === 'teste' ? Math.max(0, Math.ceil(((a.trial_until || 0) - Date.now()) / 864e5)) : null;
  return { plan: a.plan, plan_name: PLANS[a.plan]?.name || a.plan, status: a.status, trial_days_left: left, blocked: !canUse(id),
    plans: Object.entries(PLANS).map(([key, p]) => ({ key, ...p })) };
}

// Empresa nova pelo site: começa no teste grátis do plano escolhido.
export function startTrial(id, { plan, email, phone }) {
  platform.prepare("update accounts set plan = ?, status = 'teste', trial_until = ?, email = ?, phone = ? where id = ?")
    .run(PLANS[plan] ? plan : 'essencial', Date.now() + TRIAL_DAYS * 864e5, email, phone || null, id);
}

// ---------- Mercado Pago (assinatura sem plano cadastrado: o valor vai em cada assinatura)
const MP = 'https://api.mercadopago.com';
async function mp(path, init = {}) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw Object.assign(new Error('Pagamento ainda não configurado (falta MP_ACCESS_TOKEN no servidor)'), { status: 503 });
  const r = await fetch(MP + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Mercado Pago: ${d.message || r.status}`), { status: 502 });
  return d;
}

// Link de pagamento da assinatura. O plano só muda quando o Mercado Pago confirmar.
export async function checkout(id, { plan, payerEmail, backUrl }) {
  const p = PLANS[plan];
  if (!p) throw Object.assign(new Error('Plano inválido'), { status: 400 });
  const a = accountRow(id);
  const d = await mp('/preapproval', { method: 'POST', body: JSON.stringify({
    reason: `Fechaê ${p.name}`, external_reference: `${id}:${plan}`, payer_email: payerEmail, back_url: backUrl, status: 'pending',
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: p.cents / 100, currency_id: 'BRL' },
  }) });
  platform.prepare('update accounts set mp_id = ? where id = ?').run(d.id, a.id);
  return d.init_point;
}

// Aviso do Mercado Pago: confere a assinatura direto na API (o aviso em si não é confiável) e atualiza a empresa.
export async function syncSubscription(preapprovalId) {
  const d = await mp(`/preapproval/${encodeURIComponent(preapprovalId)}`);
  const [acc, plan] = String(d.external_reference || '').split(':');
  const id = Number(acc);
  if (!accountIds().includes(id) || !PLANS[plan]) return null;
  const status = { authorized: 'ativo', paused: 'pausado', cancelled: 'cancelado' }[d.status];
  if (!status) return null; // "pending": ainda não pagou
  if (status === 'ativo') platform.prepare("update accounts set plan = ?, status = 'ativo', mp_id = ? where id = ?").run(plan, d.id, id);
  else platform.prepare('update accounts set status = ? where id = ? and mp_id = ?').run(status, id, d.id);
  return { id, status };
}
