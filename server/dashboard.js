// Números do painel: funil, vendas, origem dos leads, contatos por etiqueta e campanhas.
import { one, all } from './db.js';

const OFFSET_MS = 3 * 3600e3; // America/Sao_Paulo (UTC-3, sem horário de verão desde 2019)
const dayExpr = (col) => `date((${col} - ${OFFSET_MS}) / 1000, 'unixepoch')`;

export function dashboard({ days = 30, pipelineId = null, user, brandId = 1 }) {
  days = Math.min(Math.max(Math.round(days), 1), 365);
  const since = Date.now() - days * 864e5;
  const pipes = all('select id, name from pipelines where brand_id = ? order by sort, id', brandId);
  const pid = pipes.some((p) => p.id === pipelineId) ? pipelineId : pipes[0]?.id;
  const own = user.is_admin || user.rights?.leads?.view === 'all' ? '' : ` and l.responsible_id = ${Number(user.id)}`;
  const base = `from leads l join stages s on s.id = l.stage_id where l.deleted_at is null and l.pipeline_id = ${Number(pid)}${own}`;

  const created = one(`select count(*) n ${base} and l.created_at >= ?`, since).n;
  const open = one(`select count(*) n, coalesce(sum(l.price_cents), 0) v ${base} and s.kind in ('incoming','normal')`);
  const won = one(`select count(*) n, coalesce(sum(l.price_cents), 0) v, avg(l.closed_at - l.created_at) t ${base} and s.kind = 'won' and l.closed_at >= ?`, since);
  const lost = one(`select count(*) n, coalesce(sum(l.price_cents), 0) v ${base} and s.kind = 'lost' and l.closed_at >= ?`, since);

  // série diária com todos os dias do período (dias sem movimento aparecem com zero)
  const map = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - OFFSET_MS - i * 864e5).toISOString().slice(0, 10);
    map.set(d, { day: d, novos: 0, ganhos: 0, perdidos: 0 });
  }
  for (const r of all(`select ${dayExpr('l.created_at')} d, count(*) n ${base} and l.created_at >= ? group by d`, since)) if (map.has(r.d)) map.get(r.d).novos = r.n;
  for (const r of all(`select ${dayExpr('l.closed_at')} d, s.kind k, count(*) n ${base} and s.kind in ('won','lost') and l.closed_at >= ? group by d, k`, since)) {
    if (map.has(r.d)) map.get(r.d)[r.k === 'won' ? 'ganhos' : 'perdidos'] = r.n;
  }

  const stages = all(`select s.id, s.name, s.color, s.kind, count(l.id) n, coalesce(sum(l.price_cents), 0) v from stages s
    left join leads l on l.stage_id = s.id and l.deleted_at is null${own}
    where s.pipeline_id = ? group by s.id order by s.sort`, pid);

  const sources = all(`select coalesce(json_extract(e.data, '$.source'), 'manual') source, count(*) n from events e join leads l on l.id = e.entity_id
    where e.entity = 'lead' and e.type = 'lead_added' and l.deleted_at is null and l.pipeline_id = ? and l.created_at >= ?${own} group by source order by n desc`, pid, since);

  const tags = all(`select t.name, t.color, count(c.id) n from tags t join entity_tags et on et.tag_id = t.id and et.entity = 'contact'
    join contacts c on c.id = et.entity_id and c.deleted_at is null group by t.id order by n desc`);
  const contacts = one(`select count(*) n, sum(exists (select 1 from contact_optouts o where o.contact_id = contacts.id and o.brand_id = ${Number(brandId)})) optout,
    sum(exists (select 1 from contact_points p where p.contact_id = contacts.id and p.kind = 'phone')) with_phone,
    sum(exists (select 1 from contact_points p where p.contact_id = contacts.id and p.kind = 'email')) with_email
    from contacts where deleted_at is null`);

  // campanhas da empresa, separadas por canal (WhatsApp x e-mail)
  const byChannel = Object.fromEntries(['whatsapp', 'email'].map((ch) => [ch, { sent: 0, replied: 0, optout: 0, failed: 0 }]));
  for (const r of all(`select c.channel, sum(r.status in ('sent','replied','optout')) sent, sum(r.status = 'replied') replied, sum(r.status = 'optout') optout, sum(r.status = 'failed') failed
    from campaign_recipients r join campaigns c on c.id = r.campaign_id where r.sent_at >= ? and c.brand_id = ? group by c.channel`, since, brandId)) {
    byChannel[r.channel] = { sent: r.sent || 0, replied: r.replied || 0, optout: r.optout || 0, failed: r.failed || 0 };
  }
  const camp = Object.values(byChannel).reduce((a, x) => ({ sent: a.sent + x.sent, replied: a.replied + x.replied, optout: a.optout + x.optout, failed: a.failed + x.failed }),
    { sent: 0, replied: 0, optout: 0, failed: 0 });
  const campaigns = all(`select c.id, c.name, c.channel, c.status,
    (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status in ('sent','replied','optout')) sent,
    (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'replied') replied,
    (select count(*) from campaign_recipients r where r.campaign_id = c.id) total
    from campaigns c where c.brand_id = ? order by c.id desc limit 6`, brandId);

  const overdue = one(`select count(*) n from tasks k where k.done_at is null and k.due_at < ?${user.is_admin ? '' : ` and k.responsible_id = ${Number(user.id)}`}
    and (k.entity is not 'lead' or exists (select 1 from leads x join pipelines px on px.id = x.pipeline_id where x.id = k.entity_id and px.brand_id = ${Number(brandId)}))`, Date.now()).n;

  return {
    days, pipeline_id: pid, pipelines: pipes,
    kpis: {
      created, open_n: open.n, open_v: open.v, won_n: won.n, won_v: won.v, lost_n: lost.n, lost_v: lost.v,
      conversion: won.n + lost.n ? won.n / (won.n + lost.n) : null,
      avg_close_days: won.t ? won.t / 864e5 : null,
      avg_ticket: won.n ? Math.round(won.v / won.n) : 0,
      overdue,
    },
    series: [...map.values()], stages, sources, tags,
    contacts: { total: contacts.n || 0, optout: contacts.optout || 0, with_phone: contacts.with_phone || 0, with_email: contacts.with_email || 0 },
    campaign_totals: camp, campaign_channels: byChannel,
    campaigns,
  };
}
