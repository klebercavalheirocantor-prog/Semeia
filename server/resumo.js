// "Bom dia! Resumo de hoje": todo dia, na hora escolhida, o dono recebe no WhatsApp o que aconteceu desde o resumo
// anterior (o que a IA respondeu de madrugada, leads novos, vendas, quem está esperando resposta, tarefas do dia).
// Na segunda-feira vem junto "o que funcionou na semana". Só números do banco: não usa IA, não custa nada.
// Fica no ajuste "resumo" da empresa: { ativo, hora, fuso, telefone, canal_id, semanal, ultimo, erro, url }.
import { one, all, getSetting, setSetting } from './db.js';
import { sendWeb, isWeb } from './waweb.js';

export const FUSOS = { 'America/Sao_Paulo': 'Brasília', 'America/Campo_Grande': 'Mato Grosso do Sul / Mato Grosso',
  'America/Manaus': 'Amazonas', 'America/Rio_Branco': 'Acre' };
export const DEFAULTS = { ativo: false, hora: 7, fuso: 'America/Sao_Paulo', telefone: '', canal_id: null, semanal: true };
export const config = () => ({ ...DEFAULTS, ...getSetting('resumo', {}) });

const SRC = { manual: 'Cadastro manual', whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', email: 'E-mail',
  'campanha-whatsapp': 'Campanha no WhatsApp', 'campanha-email': 'Campanha por e-mail', anuncio: 'Anúncio Facebook/Instagram' };
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const n = (x) => (x || 0).toLocaleString('pt-BR');
const plural = (x, um, varios) => `${n(x)} ${x === 1 ? um : varios}`;

// Data e hora no fuso da empresa, e a meia-noite de hoje nesse fuso.
export function local(ts, fuso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts).map((x) => [x.type, x.value]));
  const y = +p.year, m = +p.month, d = +p.day, h = +p.hour, min = +p.minute;
  const offset = Date.UTC(y, m - 1, d, h, min) - Math.floor(ts / 60e3) * 60e3;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: h, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
    label: `${DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${p.day}/${p.month}`, midnight: Date.UTC(y, m - 1, d) - offset };
}

// "AgroVox 3, KC First Class 2" quando mais de uma marca tem números; senão nada.
const porMarca = (rows) => (rows.filter((r) => r.n).length > 1 ? ` (${rows.filter((r) => r.n).map((r) => `${r.name} ${n(r.n)}`).join(', ')})` : '');

function numeros(from, to) {
  const ia = one('select count(distinct conversation_id) n from messages where direction = \'out\' and bot = 1 and created_at >= ? and created_at < ?', from, to).n;
  const entrada = one("select count(*) n, count(distinct conversation_id) c from messages where direction = 'in' and created_at >= ? and created_at < ?", from, to);
  const leads = all(`select b.name, count(l.id) n from brands b left join pipelines p on p.brand_id = b.id
    left join leads l on l.pipeline_id = p.id and l.deleted_at is null and l.created_at >= ? and l.created_at < ? group by b.id order by b.id`, from, to);
  const vendas = all(`select b.name, count(l.id) n, coalesce(sum(l.price_cents), 0) v from brands b left join pipelines p on p.brand_id = b.id
    left join stages s on s.pipeline_id = p.id and s.kind = 'won'
    left join leads l on l.stage_id = s.id and l.deleted_at is null and l.closed_at >= ? and l.closed_at < ? group by b.id order by b.id`, from, to);
  const camp = one("select sum(status in ('sent','replied','optout')) sent, sum(status = 'replied') replied from campaign_recipients where sent_at >= ? and sent_at < ?", from, to);
  return { ia, msgs: entrada.n, convs: entrada.c, leads, vendas, camp: { sent: camp.sent || 0, replied: camp.replied || 0 } };
}

export function texto(cfg = config(), ts = Date.now()) {
  const hoje = local(ts, cfg.fuso);
  const from = ts - 864e5;
  const d = numeros(from, ts);
  const madrugada = one("select count(distinct conversation_id) n from messages where direction = 'out' and bot = 1 and created_at >= ? and created_at < ?", hoje.midnight, ts).n;
  const esperando = one(`select count(*) n from conversations c where c.status = 'open' and c.last_inbound_at >= ?
    and (select m.direction from messages m where m.conversation_id = c.id order by m.id desc limit 1) = 'in'`, ts - 3 * 864e5).n;
  const tarefas = one('select count(*) n from tasks where done_at is null and due_at >= ? and due_at < ?', Math.max(ts, hoje.midnight), hoje.midnight + 864e5).n;
  const atrasadas = one('select count(*) n from tasks where done_at is null and due_at < ?', ts).n;
  const leadsN = d.leads.reduce((a, r) => a + r.n, 0);
  const vendasN = d.vendas.reduce((a, r) => a + r.n, 0), vendasV = d.vendas.reduce((a, r) => a + r.v, 0);

  const L = [`☀️ *Bom dia! Resumo de hoje* (${hoje.label})`, ''];
  L.push('🌙 *Enquanto você dormia*', madrugada ? `• A IA atendeu ${plural(madrugada, 'conversa', 'conversas')} de madrugada` : '• Nenhuma conversa de madrugada', '');
  L.push('📥 *Últimas 24 horas*');
  L.push(`• ${plural(d.msgs, 'mensagem', 'mensagens')} de clientes em ${plural(d.convs, 'conversa', 'conversas')}`);
  if (d.ia) L.push(`• A IA respondeu ${plural(d.ia, 'conversa', 'conversas')}`);
  L.push(`• ${plural(leadsN, 'lead novo', 'leads novos')}${porMarca(d.leads)}`);
  L.push(vendasN ? `• ${plural(vendasN, 'venda fechada', 'vendas fechadas')}: ${brl(vendasV)}${porMarca(d.vendas)}` : '• Nenhuma venda fechada');
  if (d.camp.sent) L.push(`• Campanhas: ${n(d.camp.sent)} enviadas, ${plural(d.camp.replied, 'respondeu', 'responderam')}`);
  L.push('', '✋ *Esperando você*');
  L.push(esperando ? `• ${plural(esperando, 'conversa', 'conversas')} com cliente esperando resposta` : '• Ninguém esperando resposta 👏');
  L.push(`• ${plural(tarefas, 'tarefa', 'tarefas')} para hoje${atrasadas ? `, ${plural(atrasadas, 'atrasada', 'atrasadas')}` : ''}`);
  if (cfg.semanal && hoje.dow === 1) L.push('', ...semana(ts));
  if (cfg.url) L.push('', `Abrir o Fechaê: ${cfg.url}`);
  return L.join('\n');
}

// Segunda-feira: o que funcionou nos últimos 7 dias.
function semana(ts) {
  const from = ts - 7 * 864e5;
  const d = numeros(from, ts);
  const leadsN = d.leads.reduce((a, r) => a + r.n, 0);
  const vendasN = d.vendas.reduce((a, r) => a + r.n, 0), vendasV = d.vendas.reduce((a, r) => a + r.v, 0);
  const origens = all(`select coalesce(json_extract(e.data, '$.source'), 'manual') s, count(*) n from events e join leads l on l.id = e.entity_id
    where e.entity = 'lead' and e.type = 'lead_added' and l.deleted_at is null and l.created_at >= ? group by s order by n desc limit 2`, from);
  const camp = one(`select c.name, sum(r.status in ('sent','replied','optout')) sent, sum(r.status = 'replied') replied
    from campaign_recipients r join campaigns c on c.id = r.campaign_id where r.sent_at >= ? group by c.id having sent >= 20
    order by 1.0 * replied / sent desc limit 1`, from);
  const L = ['📊 *Semana passada: o que funcionou*'];
  L.push(`• ${plural(leadsN, 'lead novo', 'leads novos')}${porMarca(d.leads)}`);
  L.push(vendasN ? `• ${plural(vendasN, 'venda', 'vendas')}: ${brl(vendasV)}${porMarca(d.vendas)}` : '• Nenhuma venda fechada');
  if (d.ia) L.push(`• A IA atendeu ${plural(d.ia, 'conversa', 'conversas')} sozinha`);
  if (origens.length) L.push(`• De onde mais veio lead: ${origens.map((o) => `${SRC[o.s] || o.s} (${n(o.n)})`).join(', ')}`);
  if (camp) L.push(`• Campanha com mais resposta: ${camp.name} (${Math.round((100 * camp.replied) / camp.sent)}% responderam)`);
  return L;
}

// Manda agora (botão "Mandar um teste" e a rotina do dia).
export async function enviar(cfg = config()) {
  const ch = cfg.canal_id && one("select * from channels where id = ? and kind = 'whatsapp' and status != 'disabled'", cfg.canal_id);
  if (!ch || !isWeb(ch)) throw Object.assign(new Error('Escolha o número de WhatsApp que vai mandar o resumo'), { status: 400 });
  if (String(cfg.telefone).replace(/\D/g, '').length < 10) throw Object.assign(new Error('Coloque o número que vai receber o resumo, com DDD'), { status: 400 });
  await sendWeb(ch, String(cfg.telefone).replace(/\D/g, ''), { text: texto(cfg) });
}

// Confere a cada minuto. Manda uma vez por dia, a partir da hora escolhida (até 3 h depois: servidor fora do ar
// a manhã inteira não manda resumo atrasado à tarde).
export async function tickResumo(ts = Date.now()) {
  const cfg = config();
  if (!cfg.ativo) return;
  const h = local(ts, cfg.fuso);
  if (h.hour < cfg.hora || cfg.ultimo === h.day) return;
  setSetting('resumo', { ...getSetting('resumo', {}), ultimo: h.day }); // antes de mandar: nunca sai duas vezes
  if (h.hour > cfg.hora + 3) return;
  try {
    await enviar(cfg);
    setSetting('resumo', { ...getSetting('resumo', {}), erro: null });
  } catch (e) {
    console.error('resumo do dia:', e.message);
    setSetting('resumo', { ...getSetting('resumo', {}), erro: `${h.day}: ${e.message}` });
  }
}
