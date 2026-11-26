// Planos, teste grátis e assinatura pelo Mercado Pago (cobrança mensal automática no cartão).
// O estado de cada empresa fica na lista de empresas (data/plataforma.db), fora do banco dela.
// A empresa nº 1 (AgroVox) e as criadas pelo comando "nova-empresa" são "interno": sem cobrança e sem limite.
import { platform, accountIds } from './db.js';

// Pacotes: Fecha (básico), Fecha Mais (intermediário) e Fecha Tudo (avançado). As chaves internas não mudam.
// features: o que cada pacote libera além do básico (funil, conversas, atendente com IA e fluxos, áudio em texto).
export const PLANS = {
  essencial: { name: 'Fecha', cents: 4700, users: 2, whatsapp: 1, features: [] },
  profissional: { name: 'Fecha Mais', cents: 9700, users: 5, whatsapp: 3, features: ['campanhas', 'assistente'] },
  empresa: { name: 'Fecha Tudo', cents: 19700, users: 15, whatsapp: 10, features: ['campanhas', 'assistente', 'traducao', 'marcas'] },
};
export const FEATURE_NAMES = { campanhas: 'Campanhas', assistente: 'Assistente', traducao: 'Tradução automática', marcas: 'Várias marcas' };
const ALL = Object.keys(FEATURE_NAMES);
export const TRIAL_DAYS = 7;
export const signupOpen = () => process.env.CADASTRO_ABERTO === '1';

// Colunas da cobrança na lista de empresas (criadas uma vez).
const cols = platform.prepare('pragma table_info(accounts)').all().map((c) => c.name);
for (const [c, def] of [['plan', "text not null default 'interno'"], ['status', "text not null default 'ativo'"], ['trial_until', 'integer'],
  ['mp_id', 'text'], ['email', 'text'], ['phone', 'text'], ['paid_until', 'integer']]) {
  if (!cols.includes(c)) platform.exec(`alter table accounts add column ${c} ${def}`);
}

export const accountRow = (id) => platform.prepare('select * from accounts where id = ?').get(id);

// Pode usar o sistema? Interno e assinante ativo sempre; em teste, até o fim do prazo.
export function canUse(id) {
  const a = accountRow(id);
  if (!a || !a.active) return false;
  if (a.plan === 'interno' || a.status === 'ativo') return true;
  if (a.status === 'cancelado') return (a.paid_until || 0) > Date.now(); // cancelou: usa até o fim do mês já pago
  return a.status === 'teste' && (a.trial_until || 0) > Date.now();
}

// O pacote da empresa libera este recurso? (interno: tudo)
export function hasFeature(id, f) {
  const a = accountRow(id);
  return !a || a.plan === 'interno' || !!PLANS[a.plan]?.features.includes(f);
}
// Qual é o pacote mais barato que libera o recurso (para a mensagem de "mude de pacote").
export const planFor = (f) => Object.values(PLANS).find((p) => p.features.includes(f))?.name || '';

// Limites do plano (interno: sem limite).
export function limits(id) {
  const a = accountRow(id);
  return PLANS[a?.plan] || { users: Infinity, whatsapp: Infinity };
}

export function billingInfo(id) {
  const a = accountRow(id);
  if (!a || a.plan === 'interno') return { plan: 'interno', status: 'ativo', blocked: false, features: ALL };
  const left = a.status === 'teste' ? Math.max(0, Math.ceil(((a.trial_until || 0) - Date.now()) / 864e5)) : null;
  return { plan: a.plan, plan_name: PLANS[a.plan]?.name || a.plan, status: a.status, trial_days_left: left, blocked: !canUse(id), paid_until: a.paid_until || null, features: PLANS[a.plan]?.features || [],
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
  const next = Date.parse(d.next_payment_date || '') || null;
  if (status === 'ativo') platform.prepare("update accounts set plan = ?, status = 'ativo', mp_id = ?, paid_until = ? where id = ?").run(plan, d.id, next, id);
  else platform.prepare('update accounts set status = ?, paid_until = coalesce(?, paid_until) where id = ? and mp_id = ?').run(status, next, id, d.id);
  return { id, status };
}

// Cancelar pela própria tela (Decreto 7.962/2013: cancelar pelo mesmo meio em que contratou). A cobrança para e o acesso
// continua até o fim do mês já pago.
export async function cancel(id) {
  const a = accountRow(id);
  if (!a?.mp_id || a.status !== 'ativo') throw Object.assign(new Error('Não há assinatura ativa para cancelar'), { status: 400 });
  const d = await mp(`/preapproval/${encodeURIComponent(a.mp_id)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
  const until = Date.parse(d.next_payment_date || '') || a.paid_until || Date.now();
  platform.prepare("update accounts set status = 'cancelado', paid_until = ? where id = ?").run(until, id);
  return until;
}

// Registro de acesso (Marco Civil da Internet, art. 15: guardar data, hora e IP de acesso por 6 meses).
// Fica na lista de empresas; registros com mais de 1 ano são apagados.
platform.exec('create table if not exists access_log (at integer not null, account_id integer, user_id integer, ip text, kind text not null)');
export function logAccess({ account, user, ip, kind }) {
  try {
    platform.prepare('insert into access_log(at, account_id, user_id, ip, kind) values(?, ?, ?, ?, ?)').run(Date.now(), account ?? null, user ?? null, String(ip || ''), kind);
    if (Math.random() < 0.01) platform.prepare('delete from access_log where at < ?').run(Date.now() - 366 * 864e5);
  } catch (e) { console.error('registro de acesso', e.message); }
}
