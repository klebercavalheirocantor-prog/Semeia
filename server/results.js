// Resultado: vendas fechadas x investimento (anúncios e disparo), lucro, ROAS e ROI, do jeito do relatório de escala.
// Investimento vem de data/investimento.json, gravado todo dia pela tarefa que lê a conta de anúncios (o CRM só lê).
// Custo, taxa, canal e tipo de cada venda vêm dos campos do cartão do lead.
import fs from 'node:fs';
import path from 'node:path';
import { all, one, DATA_DIR } from './db.js';

export const CANAIS = ['Anúncio Facebook Brasil', 'Anúncio Facebook EUA', 'Disparo no WhatsApp'];
const PREFIX = /^(agro\s+sinal|agro\s+revenda\s+sinal|agro|atualize)\s+/i;
const OFFSET_MS = 3 * 3600e3; // America/Sao_Paulo

export function readInvestment(dir = DATA_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'investimento.json'), 'utf8')); } catch { return null; }
}

export function results({ brandId = 1, investment = readInvestment() } = {}) {
  const fields = Object.fromEntries(all("select name, id from custom_fields where entity = 'lead'").map((f) => [f.name, f.id]));
  const fv = (leadId, name) => {
    if (!fields[name]) return null;
    const r = one("select value from field_values where entity = 'lead' and entity_id = ? and field_id = ?", leadId, fields[name]);
    return r ? JSON.parse(r.value) : null;
  };
  const leads = all(`select l.id, l.name, l.price_cents, l.closed_at from leads l join stages s on s.id = l.stage_id join pipelines p on p.id = l.pipeline_id
    where l.deleted_at is null and s.kind = 'won' and p.brand_id = ? order by l.closed_at desc`, brandId);
  const sales = leads.map((l) => {
    const src = one("select json_extract(data, '$.source') s from events where entity = 'lead' and entity_id = ? and type = 'lead_added' order by id limit 1", l.id)?.s;
    const contact = one('select c.name from lead_contacts lc join contacts c on c.id = lc.contact_id where lc.lead_id = ? order by lc.is_main desc, c.id limit 1', l.id)?.name;
    const [produto, clienteDoNome] = l.name.includes(' — ') ? l.name.split(' — ') : [l.name, null];
    const custo = fv(l.id, 'Custo do produto'), taxa = fv(l.id, 'Taxa de pagamento');
    let canal = fv(l.id, 'Canal da venda');
    if (!CANAIS.includes(canal)) canal = src === 'anuncio' ? CANAIS[0] : CANAIS[2];
    return {
      lead_id: l.id, id: fv(l.id, 'ID da venda') || `L${l.id}`, closed_at: l.closed_at, canal, tipo: fv(l.id, 'Tipo de produto') || 'Digital', produto,
      cliente: clienteDoNome || (contact ? contact.replace(PREFIX, '') : 'AgroVox'),
      valor: l.price_cents, taxa: typeof taxa === 'number' ? taxa : 0, custo: typeof custo === 'number' ? custo : null,
    };
  });

  const inv = (canal) => Math.round((investment?.canais?.[canal]?.brl || 0) * 100); // centavos
  const sum = (list, k) => list.reduce((a, x) => a + (x[k] || 0), 0);
  const line = (nome, list, investido) => {
    const receita = sum(list, 'valor'), custos = sum(list, 'custo') + sum(list, 'taxa');
    const lucro = receita - custos - investido;
    return { nome, vendas: list.length, sem_custo: list.filter((x) => x.custo == null).length, investido, receita, custos, lucro,
      roas: investido ? receita / investido : null, roi: investido ? lucro / investido : null };
  };
  const canais = CANAIS.map((c) => line(c, sales.filter((s) => s.canal === c), inv(c)));
  const total = line('Total', sales, canais.reduce((a, c) => a + c.investido, 0));
  const tipos = ['Digital', 'Físico'].map((t) => {
    const list = sales.filter((s) => s.tipo === t);
    const receita = sum(list, 'valor'), custos = sum(list, 'custo') + sum(list, 'taxa');
    return { nome: t, vendas: list.length, receita, custos, bruto: receita - custos, margem: receita ? (receita - custos) / receita : null };
  });
  const byMonth = new Map();
  for (const s of sales) {
    const m = new Date(s.closed_at - OFFSET_MS).toISOString().slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, Object.fromEntries([['mes', m], ...CANAIS.map((c) => [c, 0])]));
    byMonth.get(m)[s.canal] += s.valor;
  }
  const byClient = new Map();
  for (const s of sales) { const c = byClient.get(s.cliente) || { nome: s.cliente, receita: 0, vendas: 0 }; c.receita += s.valor; c.vendas++; byClient.set(s.cliente, c); }
  return {
    investment: investment ? { updated_at: investment.updated_at || null, cambio: investment.cambio || null, campanhas: investment.campanhas || [] } : null,
    total, canais, tipos,
    meses: [...byMonth.values()].sort((a, b) => a.mes.localeCompare(b.mes)),
    clientes: [...byClient.values()].sort((a, b) => b.receita - a.receita).slice(0, 10),
    vendas: sales,
  };
}
