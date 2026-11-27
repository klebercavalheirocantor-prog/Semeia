// Resultado: vendas fechadas x investimento (anúncios e disparo), lucro, ROAS e ROI, do jeito do relatório de escala.
// Investimento vem de data/investimento.json, gravado todo dia pela tarefa que lê a conta de anúncios (o CRM só lê).
// Custo, taxa, canal e tipo de cada venda vêm dos campos do cartão do lead.
import fs from 'node:fs';
import path from 'node:path';
import { all, one, accountDir } from './db.js';
import { semPrefixo } from './perfil.js';

export const CANAIS = ['Anúncio Facebook Brasil', 'Anúncio Facebook EUA', 'Disparo no WhatsApp'];
const OFFSET_MS = 3 * 3600e3; // America/Sao_Paulo

// Investimento em anúncios é de cada marca: o arquivo de sempre é da marca principal (AgroVox);
// as outras (AgroPool, KC First Class) têm o próprio, e sem arquivo o investimento é zero.
export const investmentFile = (brandId = 1) => (Number(brandId) > 1 ? `investimento-marca${Number(brandId)}.json` : 'investimento.json');
export function readInvestment(dir = accountDir(), brandId = 1) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, investmentFile(brandId)), 'utf8')); } catch { return null; }
}

// Qual criativo é cada anúncio do Facebook: data/anuncios.json { "<id do anúncio>": { criativo, campanha } }.
// Gravado pela tarefa que lê a conta de anúncios (ou à mão em Ajustes); sem ele, aparece o título do anúncio.
export const adsFile = (brandId = 1) => (Number(brandId) > 1 ? `anuncios-marca${Number(brandId)}.json` : 'anuncios.json');
export function readAds(dir = accountDir(), brandId = 1) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, adsFile(brandId)), 'utf8')); } catch { return {}; }
}
export const AD_FIELD = 'Anúncio de origem'; // campo do cartão do lead: preenchido à mão para vendas antigas (vale mais que o automático)

export function results({ brandId = 1, investment = readInvestment(accountDir(), brandId), ads = readAds(accountDir(), brandId) } = {}) {
  const fields = Object.fromEntries(all("select name, id from custom_fields where entity = 'lead'").map((f) => [f.name, f.id]));
  const fv = (leadId, name) => {
    if (!fields[name]) return null;
    const r = one("select value from field_values where entity = 'lead' and entity_id = ? and field_id = ?", leadId, fields[name]);
    return r ? JSON.parse(r.value) : null;
  };
  const leads = all(`select l.id, l.name, l.price_cents, l.closed_at from leads l join stages s on s.id = l.stage_id join pipelines p on p.id = l.pipeline_id
    where l.deleted_at is null and s.kind = 'won' and p.brand_id = ? order by l.closed_at desc`, brandId);
  // Anúncio de onde o cliente veio: campo do cartão (à mão) > clique no anúncio gravado neste lead > em outro lead do mesmo contato.
  const adName = (id, title) => ads?.[id]?.criativo || title || (id ? `Anúncio ${id}` : null);
  const adOf = (leadId) => {
    const manual = fv(leadId, AD_FIELD);
    if (manual) return { id: null, criativo: String(manual), campanha: null, fonte: 'manual' };
    const ev = one("select data from events where entity = 'lead' and entity_id = ? and type = 'ad_click' order by id limit 1", leadId)
      || one(`select e.data from events e join lead_contacts a on a.lead_id = e.entity_id join lead_contacts b on b.contact_id = a.contact_id
        where e.entity = 'lead' and e.type = 'ad_click' and b.lead_id = ? order by e.id limit 1`, leadId);
    if (!ev) return null;
    const d = JSON.parse(ev.data || '{}');
    return { id: d.id || null, criativo: adName(d.id, d.title), campanha: ads?.[d.id]?.campanha || null, fonte: 'automático' };
  };
  const sales = leads.map((l) => {
    const src = one("select json_extract(data, '$.source') s from events where entity = 'lead' and entity_id = ? and type = 'lead_added' order by id limit 1", l.id)?.s;
    const contact = one('select c.name from lead_contacts lc join contacts c on c.id = lc.contact_id where lc.lead_id = ? order by lc.is_main desc, c.id limit 1', l.id)?.name;
    const [produto, clienteDoNome] = l.name.includes(' — ') ? l.name.split(' — ') : [l.name, null];
    const custo = fv(l.id, 'Custo do produto'), taxa = fv(l.id, 'Taxa de pagamento');
    let canal = fv(l.id, 'Canal da venda');
    if (!CANAIS.includes(canal)) canal = src === 'anuncio' ? CANAIS[0] : CANAIS[2];
    return {
      lead_id: l.id, id: fv(l.id, 'ID da venda') || `L${l.id}`, closed_at: l.closed_at, canal, tipo: fv(l.id, 'Tipo de produto') || 'Digital', produto,
      cliente: clienteDoNome || (contact ? semPrefixo(contact) : one('select name from brands where id = ?', brandId)?.name || ''),
      valor: l.price_cents, taxa: typeof taxa === 'number' ? taxa : 0, custo: typeof custo === 'number' ? custo : null,
      anuncio: adOf(l.id),
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
  // Por criativo: quantos contatos cada anúncio trouxe (cliques gravados) e quanto vendeu.
  const porCriativo = new Map();
  const slot = (nome) => { if (!porCriativo.has(nome)) porCriativo.set(nome, { nome, campanhas: new Set(), contatos: 0, vendas: 0, receita: 0, lucro: 0 }); return porCriativo.get(nome); };
  for (const r of all(`select json_extract(e.data, '$.id') id, json_extract(e.data, '$.title') title, count(distinct e.entity_id) n from events e
      join leads l on l.id = e.entity_id join pipelines p on p.id = l.pipeline_id
      where e.entity = 'lead' and e.type = 'ad_click' and l.deleted_at is null and p.brand_id = ? group by 1, 2`, brandId)) {
    const x = slot(adName(r.id, r.title));
    x.contatos += r.n;
    if (ads?.[r.id]?.campanha) x.campanhas.add(ads[r.id].campanha);
  }
  for (const s of sales) {
    if (!s.anuncio) continue;
    const x = slot(s.anuncio.criativo);
    x.vendas++; x.receita += s.valor; x.lucro += s.valor - (s.custo || 0) - (s.taxa || 0);
    if (s.anuncio.campanha) x.campanhas.add(s.anuncio.campanha);
  }
  const criativos = [...porCriativo.values()].map((x) => ({ ...x, campanhas: [...x.campanhas].sort() }))
    .sort((a, b) => b.receita - a.receita || b.contatos - a.contatos);
  const anuncioVendas = sales.filter((s) => s.canal !== CANAIS[2]);

  return {
    criativos, sem_anuncio: anuncioVendas.filter((s) => !s.anuncio).length,
    investment: investment ? { updated_at: investment.updated_at || null, cambio: investment.cambio || null, campanhas: investment.campanhas || [] } : null,
    total, canais, tipos,
    meses: [...byMonth.values()].sort((a, b) => a.mes.localeCompare(b.mes)),
    clientes: [...byClient.values()].sort((a, b) => b.receita - a.receita).slice(0, 10),
    vendas: sales,
  };
}
