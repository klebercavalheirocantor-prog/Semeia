// Vendas para o Facebook (API de Conversões): cada lead em "Venda fechada" com valor vira uma compra ("Purchase")
// no conjunto de dados da empresa. O Facebook cruza o telefone (embaralhado com SHA-256) com quem clicou no anúncio
// e mostra a compra no anúncio certo. Até 7 dias da venda vai como "chat" (também ensina o Facebook a buscar quem compra);
// de 8 a 62 dias vai como venda fora da internet ("physical_store", só entra nos relatórios). Mais antiga que isso o Facebook recusa.
import crypto from 'node:crypto';
import { all, one, getSetting, setSetting, now } from './db.js';
import { brandKey, logEvent } from './crm.js';

const DAY = 864e5;
const sha = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
const KEY = 'capi';

export const capiConfig = (brandId = 1) => getSetting(brandKey(KEY, brandId), {});
export function saveCapiConfig(brandId, { dataset_id, token }) {
  const cur = capiConfig(brandId);
  const next = { ...cur };
  if (dataset_id !== undefined) next.dataset_id = String(dataset_id || '').replace(/\D/g, '');
  if (token) next.token = String(token).trim(); // vazio = manter a chave salva
  setSetting(brandKey(KEY, brandId), next);
  return next;
}

// Vendas da marca que ainda não foram para o Facebook e ainda cabem no prazo (62 dias).
export function pendingSales(brandId = 1, t = now()) {
  return all(`select l.id, l.price_cents, l.closed_at from leads l join stages s on s.id = l.stage_id join pipelines p on p.id = l.pipeline_id
      where s.kind = 'won' and l.deleted_at is null and p.brand_id = ? and l.price_cents > 0 and l.closed_at > ?
        and not exists (select 1 from events e where e.entity = 'lead' and e.entity_id = l.id and e.type = 'capi_purchase')
      order by l.closed_at`, brandId, t - 62 * DAY);
}

function userData(leadId) {
  const phones = all(`select distinct p.value_norm v from lead_contacts lc join contact_points p on p.contact_id = lc.contact_id
      where lc.lead_id = ? and p.kind = 'phone' and length(p.value_norm) >= 10`, leadId).map((r) => r.v.replace(/\D/g, ''));
  const emails = all(`select distinct p.value_norm v from lead_contacts lc join contact_points p on p.contact_id = lc.contact_id
      where lc.lead_id = ? and p.kind = 'email'`, leadId).map((r) => r.v);
  const contacts = all('select contact_id id from lead_contacts where lead_id = ?', leadId).map((r) => String(r.id));
  const ud = {};
  if (phones.length) ud.ph = phones.map(sha);
  if (emails.length) ud.em = emails.map(sha);
  if (contacts.length) ud.external_id = contacts.map(sha);
  if (phones.some((p) => p.startsWith('55'))) ud.country = [sha('br')];
  return ud;
}

export function buildEvent(sale, t = now(), currency = 'BRL') {
  const age = t - sale.closed_at;
  const ud = userData(sale.id);
  if (!ud.ph && !ud.em) return null; // sem telefone nem e-mail o Facebook não tem como achar a pessoa
  return {
    event_name: 'Purchase',
    event_time: Math.floor(Math.min(sale.closed_at, t) / 1000),
    event_id: `venda-${sale.id}`,
    action_source: age <= 7 * DAY - 3600e3 ? 'chat' : 'physical_store',
    user_data: ud,
    custom_data: { currency, value: Math.round(sale.price_cents) / 100, order_id: `venda-${sale.id}` },
  };
}

// Manda as vendas pendentes de uma marca. Devolve o resumo; grava em cada lead que a venda foi enviada.
export async function sendSales(brandId = 1, { fetchImpl = fetch } = {}) {
  const cfg = capiConfig(brandId);
  if (!cfg.dataset_id || !cfg.token) return { ok: false, motivo: 'Falta o ID do conjunto de dados ou a chave de acesso' };
  const t = now();
  const currency = getSetting('general', {}).currency || 'BRL';
  const sales = pendingSales(brandId, t);
  const evs = [], semContato = [];
  for (const s of sales) { const e = buildEvent(s, t, currency); if (e) evs.push([s, e]); else semContato.push(s.id); }
  let enviadas = 0, erro = null;
  for (let i = 0; i < evs.length; i += 500) {
    const lote = evs.slice(i, i + 500);
    const version = getSetting('meta', {}).graph_version || 'v23.0';
    try {
      const r = await fetchImpl(`https://graph.facebook.com/${version}/${cfg.dataset_id}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: lote.map(([, e]) => e), access_token: cfg.token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) { erro = j.error?.message || `HTTP ${r.status}`; break; }
      for (const [s, e] of lote) logEvent('lead', s.id, 'capi_purchase', { action_source: e.action_source, value: e.custom_data.value, fbtrace_id: j.fbtrace_id || null });
      enviadas += lote.length;
    } catch (x) { erro = x.message; break; }
  }
  const status = { at: t, enviadas, pendentes: evs.length - enviadas, sem_contato: semContato.length, erro };
  setSetting(brandKey(KEY, brandId), { ...capiConfig(brandId), ultimo: status });
  return { ok: !erro, ...status };
}

// Trabalho de fundo: a cada rodada, manda o que estiver pendente em todas as marcas que configuraram.
export async function tickCapi() {
  for (const b of all('select id from brands')) {
    const cfg = capiConfig(b.id);
    if (cfg.dataset_id && cfg.token && pendingSales(b.id).length) await sendSales(b.id);
  }
}

export function capiStatus(brandId = 1) {
  const cfg = capiConfig(brandId);
  const enviadas = one(`select count(*) n from events e join leads l on l.id = e.entity_id join pipelines p on p.id = l.pipeline_id
      where e.entity = 'lead' and e.type = 'capi_purchase' and p.brand_id = ?`, brandId).n;
  return { dataset_id: cfg.dataset_id || '', has_token: !!cfg.token, enviadas, pendentes: pendingSales(brandId).length, ultimo: cfg.ultimo || null };
}

