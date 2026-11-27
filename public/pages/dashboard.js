import { html, useState, useEffect, useRef, api, money, useData, Skeleton, ErrorBox } from '../lib.js';

// Cores por papel (paleta validada para fundo claro; ordem fixa).
const C = { novos: '#2a78d6', ganhos: '#1baf7a', perdidos: '#e34948' };
const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SRC = { manual: 'Manual', whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', email: 'E-mail', campanha: 'Campanha',
  'campanha-whatsapp': 'Campanha WhatsApp', 'campanha-email': 'Campanha e-mail', anuncio: 'Anúncio Facebook/Instagram' };
const num = (n) => (n || 0).toLocaleString('pt-BR');
const pct = (x) => (x == null ? '—' : `${(x * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const shortDay = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

const icon = (d) => html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  leads: icon(html`<circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5M16 11a3 3 0 1 0 0-6M21 20c0-2-1-4-4-4.6" />`),
  money: icon(html`<path d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6" />`),
  target: icon(html`<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" />`),
  clock: icon(html`<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />`),
  up: icon(html`<path d="M3 17l6-6 4 4 8-8M15 7h6v6" />`),
  down: icon(html`<path d="M3 7l6 6 4-4 8 8M15 17h6v-6" />`),
  bars: icon(html`<path d="M5 20V10M12 20V4M19 20v-7" />`),
  trophy: icon(html`<path d="M8 4h8v5a4 4 0 0 1-8 0zM6 5H3v2a3 3 0 0 0 3 3M18 5h3v2a3 3 0 0 1-3 3M9 20h6M12 13v7" />`),
  send: icon(html`<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" />`),
  mail: icon(html`<rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" />`),
};

function Kpi({ label, value, sub, ic, tone }) {
  return html`<div class="card pad kpi"><div class="row"><span class="small muted grow">${label}</span><span class=${`kpi-ic ${tone || ''}`}>${ic}</span></div>
    <div class="kpi-v">${value}</div>${sub && html`<div class="xs muted">${sub}</div>`}</div>`;
}

// Evolução por dia (novos, ganhos, perdidos): altura fixa, liga/desliga cada série na legenda,
// arrastar no gráfico dá zoom no período, botões + / − / Tudo, linhas ou barras, dica ao passar o mouse.
const KEYS = ['novos', 'ganhos', 'perdidos'];
const niceStep = (v) => { const p = 10 ** Math.floor(Math.log10(Math.max(v, 1))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
function LeadsChart({ series }) {
  const wrap = useRef(null), svg = useRef(null);
  const [w, setW] = useState(760);
  const [on, setOn] = useState({ novos: true, ganhos: true, perdidos: true });
  const [range, setRange] = useState(null);
  const [drag, setDrag] = useState(null);
  const [hover, setHover] = useState(null);
  const [mode, setMode] = useState('linhas');
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setRange(null); setHover(null); }, [series]);
  const n = series.length;
  if (!n) return html`<p class="small muted">Sem dados no período.</p>`;
  const [a, b] = range || [0, n - 1];
  const view = series.slice(a, b + 1);
  const H = 230, L = 36, R = 12, T = 12, B = 26, pw = w - L - R, ph = H - T - B;
  const shown = KEYS.filter((k) => on[k]);
  const step = niceStep(Math.max(4, ...view.flatMap((d) => shown.map((k) => d[k]))) / 4);
  const top = step * 4;
  const slot = pw / view.length;
  const x = (i) => (mode === 'barras' ? L + slot * (i + 0.5) : L + (view.length < 2 ? pw / 2 : (i * pw) / (view.length - 1)));
  const y = (v) => T + ph * (1 - v / top);
  const every = Math.max(1, Math.ceil(view.length / Math.max(2, Math.floor(pw / 64))));
  const idxAt = (e) => {
    const r = svg.current.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = mode === 'barras' ? Math.floor((px - L) / slot) : Math.round(((px - L) / pw) * (view.length - 1));
    return Math.min(view.length - 1, Math.max(0, i));
  };
  const zoom = (f) => {
    const len = b - a + 1, c = (a + b) / 2;
    const nl = Math.min(n, Math.max(3, Math.round(len * f)));
    let na = Math.round(c - (nl - 1) / 2);
    na = Math.min(Math.max(0, na), n - nl);
    setRange(nl >= n ? null : [na, na + nl - 1]);
    setHover(null);
  };
  const up = () => {
    if (drag && Math.abs(drag.b - drag.a) >= 1) setRange([a + Math.min(drag.a, drag.b), a + Math.max(drag.a, drag.b)]);
    setDrag(null);
  };
  const total = (k) => view.reduce((t, d) => t + d[k], 0);
  const hd = hover != null && !drag ? view[hover] : null;
  const bw = Math.max(2, Math.min(14, (slot - 6) / Math.max(1, shown.length) - 2));
  const tipLeft = hd ? Math.min(Math.max(x(hover), 70), w - 70) : 0;
  return html`<div class="lc">
    <div class="lc-bar">
      <div class="lc-legend" role="group" aria-label="Mostrar ou esconder séries">
        ${KEYS.map((k) => html`<button type="button" class=${`lc-chip ${on[k] ? 'on' : ''}`} aria-pressed=${on[k]}
          onClick=${() => { if (!(on[k] && shown.length === 1)) setOn({ ...on, [k]: !on[k] }); }}>
          <i style=${`background:${on[k] ? C[k] : 'transparent'};border-color:${C[k]}`}></i>${k}<b>${num(total(k))}</b></button>`)}
      </div>
      <div class="lc-tools">
        <span class="seg">${['linhas', 'barras'].map((m) => html`<button type="button" class=${mode === m ? 'on' : ''} onClick=${() => { setMode(m); setHover(null); }}>${m}</button>`)}</span>
        <span class="seg">
          <button type="button" title="Aproximar" aria-label="Aproximar" onClick=${() => zoom(0.5)} disabled=${b - a + 1 <= 3}>+</button>
          <button type="button" title="Afastar" aria-label="Afastar" onClick=${() => zoom(2)} disabled=${!range}>−</button>
          <button type="button" onClick=${() => { setRange(null); setHover(null); }} disabled=${!range}>Tudo</button>
        </span>
      </div>
    </div>
    <div class="lc-plot" ref=${wrap}>
      <svg ref=${svg} width=${w} height=${H} class="chart lc-svg" role="img" aria-label=${`Evolução de leads por dia, de ${shortDay(view[0].day)} a ${shortDay(view.at(-1).day)}`}
        onPointerDown=${(e) => { const i = idxAt(e); setDrag({ a: i, b: i }); e.currentTarget.setPointerCapture?.(e.pointerId); }}
        onPointerMove=${(e) => { const i = idxAt(e); setHover(i); if (drag) setDrag({ ...drag, b: i }); }}
        onPointerUp=${up} onPointerLeave=${() => { if (!drag) setHover(null); }} onDblClick=${() => setRange(null)}>
        ${[0, 1, 2, 3, 4].map((i) => html`<line x1=${L} x2=${w - R} y1=${y(i * step)} y2=${y(i * step)} class="grid" /><text x=${L - 6} y=${y(i * step) + 4} class="ax" text-anchor="end">${num(i * step)}</text>`)}
        ${view.map((d, i) => i % every === 0 && html`<text x=${x(i)} y=${H - 7} class="ax" text-anchor="middle">${shortDay(d.day)}</text>`)}
        ${drag && html`<rect class="lc-brush" x=${Math.min(x(drag.a), x(drag.b))} y=${T} width=${Math.max(2, Math.abs(x(drag.b) - x(drag.a)))} height=${ph} />`}
        ${hd && html`<line x1=${x(hover)} x2=${x(hover)} y1=${T} y2=${H - B} class="cross" />`}
        ${mode === 'linhas'
          ? shown.map((k) => html`<g>
              <polygon points=${`${x(0)},${y(0)} ${view.map((d, i) => `${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(' ')} ${x(view.length - 1)},${y(0)}`} fill=${C[k]} opacity=".07" />
              <polyline points=${view.map((d, i) => `${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(' ')} fill="none" stroke=${C[k]} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
              ${view.length <= 45 && view.map((d, i) => d[k] > 0 && html`<circle cx=${x(i)} cy=${y(d[k])} r="2.5" fill=${C[k]} />`)}
            </g>`)
          : view.map((d, i) => shown.map((k, j) => {
              const h = (d[k] / top) * ph;
              return h > 0 && html`<rect x=${x(i) - (shown.length * (bw + 2)) / 2 + j * (bw + 2)} y=${y(d[k])} width=${bw} height=${h} rx="2" fill=${C[k]} />`;
            }))}
        ${hd && mode === 'linhas' && shown.map((k) => html`<circle cx=${x(hover)} cy=${y(hd[k])} r="4.5" fill=${C[k]} stroke="#fff" stroke-width="2" />`)}
      </svg>
      ${hd && html`<div class="tip" style=${`left:${tipLeft}px;top:4px`}><strong>${shortDay(hd.day)}</strong>${shown.map((k) => html`<div><i style=${`background:${C[k]}`}></i>${k}: <b>${num(hd[k])}</b></div>`)}</div>`}
    </div>
    <p class="xs muted lc-hint">${range ? `Mostrando ${shortDay(view[0].day)} a ${shortDay(view.at(-1).day)} · dois cliques ou "Tudo" volta ao período inteiro` : 'Arraste sobre o gráfico para dar zoom num período · clique na legenda para mostrar ou esconder'}</p>
  </div>`;
}

function StageBars({ stages }) {
  const max = Math.max(1, ...stages.map((s) => s.n));
  return html`<div class="hbars">${stages.map((s) => html`<div class="hbar" title=${`${s.name}: ${s.n} leads · ${money(s.v)}`}>
    <span class="hbar-l ellipsis">${s.name}</span>
    <span class="hbar-track"><span class="hbar-fill" style=${`width:${(s.n / max) * 100}%;background:${s.kind === 'won' ? C.ganhos : s.kind === 'lost' ? C.perdidos : C.novos}`}></span></span>
    <span class="hbar-v">${num(s.n)}<span class="xs muted"> · ${money(s.v)}</span></span></div>`)}</div>`;
}

function Donut({ items, label, fmt = num, fmtTotal }) {
  const total = items.reduce((a, b) => a + b.n, 0);
  if (!total) return html`<p class="small muted">Sem dados no período.</p>`;
  const top = items.slice(0, 7);
  const rest = items.slice(7).reduce((a, b) => a + b.n, 0);
  const list = rest ? [...top, { name: 'Outros', n: rest }] : top;
  const R = 52, CIRC = 2 * Math.PI * R;
  let acc = 0;
  return html`<div class="donut-wrap">
    <svg viewBox="0 0 140 140" width="150" height="150" role="img" aria-label=${label}>
      ${list.map((it, i) => { const len = (it.n / total) * CIRC; const gap = list.length > 1 ? 2 : 0; const el = html`<circle cx="70" cy="70" r=${R} fill="none" stroke=${CAT[i]} stroke-width="18"
        stroke-dasharray=${`${Math.max(len - gap, 0.5)} ${CIRC}`} stroke-dashoffset=${-acc} transform="rotate(-90 70 70)"><title>${it.name}: ${fmt(it.n)}</title></circle>`; acc += len; return el; })}
      <text x="70" y="68" text-anchor="middle" class="donut-n">${(fmtTotal || fmt)(total)}</text><text x="70" y="86" text-anchor="middle" class="ax">total</text>
    </svg>
    <div class="col" style="gap:6px">${list.map((it, i) => html`<div class="row small"><i class="dot" style=${`background:${CAT[i]}`}></i><span class="grow">${it.name}</span><b>${fmt(it.n)}</b><span class="xs muted">${pct(it.n / total)}</span></div>`)}</div>
  </div>`;
}

export function DashboardPage() {
  const [tab, setTab] = useState('geral');
  const [days, setDays] = useState(30);
  const [pid, setPid] = useState('');
  const { data: d, error, reload } = useData(() => api(`/dashboard?days=${days}${pid ? `&pipeline_id=${pid}` : ''}`), [days, pid], ['lead', 'campaign', 'contact']);
  const k = d?.kpis;
  // Total de vendas desde o começo (mesma conta da aba Resultado); quem não vê todos os leads não recebe.
  const { data: res } = useData(() => api('/results').catch(() => null), [], ['lead']);
  return html`<div class="main">
    <div class="topbar"><div class="grow"><h1>Painel</h1><div class="xs muted">Visão geral do funil e das campanhas nos últimos ${days} dias</div></div>
      ${d?.pipelines?.length > 1 && html`<select aria-label="Funil" value=${pid || d.pipeline_id} onChange=${(e) => setPid(e.target.value)}>${d.pipelines.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>`}
      <select aria-label="Período" value=${String(days)} onChange=${(e) => setDays(Number(e.target.value))}>
        <option value="7">7 dias</option><option value="30">30 dias</option><option value="90">90 dias</option><option value="365">12 meses</option></select></div>
    <div class="tabs" role="tablist" style="padding:0 var(--s-4)">
      <button role="tab" aria-selected=${tab === 'geral'} onClick=${() => setTab('geral')}>Visão geral</button>
      <button role="tab" aria-selected=${tab === 'resultado'} onClick=${() => setTab('resultado')}>Resultado (lucro e ROI)</button></div>
    <div class="page dash">
      ${tab === 'resultado' && html`<${Resultado} />`}
      ${tab === 'geral' && error && html`<${ErrorBox} error=${error} retry=${reload} />`}
      ${tab === 'geral' && !d && !error && html`<${Skeleton} rows=${4} h=${110} />`}
      ${tab === 'geral' && d && html`
        <div class="kpis">
          <${Kpi} label="Leads novos" value=${num(k.created)} sub=${`${num(k.open_n)} em aberto no funil`} ic=${I.leads} tone="blue" />
          <${Kpi} label="Valor em aberto" value=${money(k.open_v)} sub=${`${num(k.open_n)} leads no funil`} ic=${I.money} tone="violet" />
          <${Kpi} label="Taxa de conversão" value=${pct(k.conversion)} sub=${`${num(k.won_n)} ganhos · ${num(k.lost_n)} perdidos`} ic=${I.target} tone="green" />
          <${Kpi} label="Tempo médio para fechar" value=${k.avg_close_days == null ? '—' : `${k.avg_close_days.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias`} sub="dos negócios ganhos" ic=${I.clock} tone="amber" />
          ${res && html`<${Kpi} label="Total de vendas (desde o início)" value=${money(res.total.receita)} sub=${`${num(res.total.vendas)} vendas fechadas`} ic=${I.trophy} tone="green" />`}
          ${res && html`<${Kpi} label="Lucro (desde o início)" value=${money(res.total.lucro)} sub=${`vendas − custos/taxas ${money(res.total.custos)} − anúncios ${money(res.total.investido)}`} ic=${I.money} tone="green" />`}
          <${Kpi} label=${`Receita ganha (${days === 365 ? '12 meses' : `${days} dias`})`} value=${money(k.won_v)} sub=${`${num(k.won_n)} negócios fechados no período`} ic=${I.up} tone="green" />
          <${Kpi} label="Receita perdida" value=${money(k.lost_v)} sub=${`${num(k.lost_n)} negócios perdidos`} ic=${I.down} tone="red" />
          <${Kpi} label="Ticket médio (ganhos)" value=${money(k.avg_ticket)} sub=${`${num(k.overdue)} tarefas atrasadas`} ic=${I.trophy} tone="violet" />
          ${[['whatsapp', 'WhatsApp', I.send, 'green'], ['email', 'E-mail', I.mail, 'blue']].map(([k, label, ic, tone]) => {
            const c = d.campaign_channels?.[k] || { sent: 0, replied: 0, optout: 0 };
            return html`<${Kpi} label=${`Campanhas ${label}: enviadas`} value=${num(c.sent)} sub=${`${num(c.replied)} respostas (${pct(c.sent ? c.replied / c.sent : null)}) · ${num(c.optout)} saíram`} ic=${ic} tone=${tone} />`;
          })}
        </div>
        <div class="card pad"><h2>Evolução de leads</h2><${LeadsChart} series=${d.series} /></div>
        <div class="dash-2">
          <div class="card pad"><h2>Leads por etapa</h2><${StageBars} stages=${d.stages} /></div>
          <div class="card pad"><h2>Leads por origem</h2><${Donut} items=${d.sources.map((s) => ({ name: SRC[s.source] || s.source, n: s.n }))} label="Leads por origem" /></div>
        </div>
        <div class="dash-2">
          <div class="card pad"><h2>Contatos por etiqueta</h2>
            <p class="xs muted">${num(d.contacts.total)} contatos · ${num(d.contacts.with_phone)} com telefone · ${num(d.contacts.with_email)} com e-mail · ${num(d.contacts.optout)} pediram para sair</p>
            <${StageBars} stages=${d.tags.map((t) => ({ name: t.name, n: t.n, v: 0, kind: 'normal' }))} /></div>
          <div class="card pad"><div class="row"><h2 class="grow">Campanhas recentes</h2><a class="small" href="#/campaigns">Ver todas</a></div>
            ${d.campaigns.length ? html`<table class="t"><thead><tr><th>Campanha</th><th>Enviadas</th><th>Respostas</th></tr></thead><tbody>
              ${d.campaigns.map((c) => html`<tr><td><a href=${`#/campaign/${c.id}`}>${c.name}</a> <span class="xs muted">${c.channel === 'email' ? 'e-mail' : 'WhatsApp'}</span></td>
                <td>${num(c.sent)} / ${num(c.total)}</td><td>${num(c.replied)} <span class="xs muted">${pct(c.sent ? c.replied / c.sent : null)}</span></td></tr>`)}</tbody></table>`
            : html`<p class="small muted">Nenhuma campanha ainda. <a href="#/campaigns">Criar a primeira</a></p>`}</div>
        </div>`}
    </div>
  </div>`;
}

// ---------- Resultado: vendas x investimento, lucro, ROAS e ROI (como no relatório de escala)
const CH = ['Anúncio Facebook Brasil', 'Anúncio Facebook EUA', 'Disparo no WhatsApp'];
const CH_SHORT = { 'Anúncio Facebook Brasil': 'Facebook Brasil', 'Anúncio Facebook EUA': 'Facebook EUA', 'Disparo no WhatsApp': 'Disparo WhatsApp' };
const n1 = (x) => (x == null ? '—' : x.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const roiPct = (x) => (x == null ? '—' : `${Math.round(x * 100).toLocaleString('pt-BR')}%`);
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const milBRL = (c) => (c >= 100000000 ? `R$ ${(c / 100000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi` : c >= 100000 ? `R$ ${(c / 100000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : money(c));
const mesLabel = (m) => `${MES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;

// Barras deitadas: investido, vendido e lucro de cada canal, na mesma escala.
function ChannelBars({ canais }) {
  const series = [['investido', 'Investido', C.perdidos], ['receita', 'Vendido', C.novos], ['lucro', 'Lucro', C.ganhos]];
  const max = Math.max(1, ...canais.flatMap((c) => series.map(([k]) => Math.abs(c[k]))));
  return html`<div class="col" style="gap:14px">
    <div class="legend">${series.map(([, l, c]) => html`<span><i style=${`background:${c}`}></i>${l}</span>`)}</div>
    ${canais.map((c) => html`<div><div class="small" style="font-weight:600;margin-bottom:4px">${CH_SHORT[c.nome] || c.nome}</div>
      <div class="hbars">${series.map(([k, l, color]) => html`<div class="hbar" title=${`${l}: ${money(c[k])}`}>
        <span class="hbar-l ellipsis">${l}</span>
        <span class="hbar-track"><span class="hbar-fill" style=${`width:${(Math.abs(c[k]) / max) * 100}%;background:${c[k] < 0 ? C.perdidos : color}`}></span></span>
        <span class="hbar-v">${money(c[k])}</span></div>`)}</div></div>`)}
  </div>`;
}

// Colunas empilhadas: vendido por mês, separado por canal.
function MonthBars({ meses }) {
  if (!meses.length) return html`<p class="small muted">Sem vendas fechadas ainda.</p>`;
  const W = 560, H = 220, L = 10, B = 24, T = 22;
  const tot = (m) => CH.reduce((a, c) => a + m[c], 0);
  const max = Math.max(1, ...meses.map(tot));
  const bw = Math.min(90, (W - L * 2) / meses.length * 0.6), gap = (W - L * 2) / meses.length;
  const y = (v) => (H - B - T) * (v / max);
  return html`<div class="chart-wrap">
    <div class="legend">${CH.map((c, i) => html`<span><i style=${`background:${CAT[i]}`}></i>${CH_SHORT[c]}</span>`)}</div>
    <svg viewBox=${`0 0 ${W} ${H}`} class="chart" role="img" aria-label="Valor vendido em cada mês, separado por canal">
      ${meses.map((m, i) => { let acc = 0; const x = L + gap * i + (gap - bw) / 2; return html`<g>
        ${CH.map((c, ci) => { const h = y(m[c]); const el = html`<rect x=${x} y=${H - B - acc - h} width=${bw} height=${h} fill=${CAT[ci]}><title>${CH_SHORT[c]}: ${money(m[c])}</title></rect>`; acc += h; return el; })}
        <text x=${x + bw / 2} y=${H - B - acc - 6} text-anchor="middle" class="ax">${money(tot(m))}</text>
        <text x=${x + bw / 2} y=${H - 6} text-anchor="middle" class="ax">${mesLabel(m.mes)}</text></g>`; })}
    </svg></div>`;
}

function Resultado() {
  const { data: r, error, reload } = useData(() => api('/results'), [], ['lead', 'config']);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!r) return html`<${Skeleton} rows=${4} h=${110} />`;
  const t = r.total;
  const semCusto = r.vendas.filter((v) => v.custo == null);
  const inv = r.investment;
  return html`
    ${!inv && html`<div class="banner warn">Ainda não chegou o investimento dos anúncios (arquivo data/investimento.json). O lucro abaixo está sem o gasto com anúncio e disparo.</div>`}
    ${semCusto.length > 0 && html`<div class="banner warn">${semCusto.length} ${semCusto.length === 1 ? 'venda está' : 'vendas estão'} sem "Custo do produto" no cartão:
      ${semCusto.slice(0, 5).map((v, i) => html`${i ? ', ' : ' '}<a href=${`#/lead/${v.lead_id}`}>${v.produto}</a>`)}. Sem o custo, o lucro aparece maior que o real.</div>`}
    <div class="kpis">
      <${Kpi} label="Investido" value=${money(t.investido)} sub="Anúncios do Facebook e disparo" ic=${I.down} tone="red" />
      <${Kpi} label="Vendido" value=${money(t.receita)} sub=${`${num(t.vendas)} vendas fechadas`} ic=${I.money} tone="blue" />
      <${Kpi} label="Lucro" value=${money(t.lucro)} sub="Depois de taxa, custo do produto e investimento" ic=${I.up} tone="green" />
      <${Kpi} label="ROI" value=${n1(t.roi)} sub=${`${roiPct(t.roi)} · lucro ÷ investido`} ic=${I.target} tone="green" />
      <${Kpi} label="ROAS" value=${n1(t.roas)} sub="Vendido ÷ investido" ic=${I.trophy} tone="violet" />
      <${Kpi} label="Ticket médio" value=${money(t.vendas ? Math.round(t.receita / t.vendas) : 0)} sub=${`Taxa + custo: ${money(t.custos)}`} ic=${I.bars} tone="amber" />
    </div>
    <div class="dash-2">
      <div class="card pad"><h2>Vendido por canal</h2><${Donut} items=${r.canais.map((c) => ({ name: CH_SHORT[c.nome], n: c.receita }))} fmt=${money} fmtTotal=${milBRL} label="Pizza do valor vendido em cada canal" /></div>
      <div class="card pad"><h2>Lucro por canal</h2><${Donut} items=${r.canais.map((c) => ({ name: CH_SHORT[c.nome], n: Math.max(0, c.lucro) }))} fmt=${money} fmtTotal=${milBRL} label="Pizza do lucro de cada canal" /></div>
    </div>
    <div class="dash-2">
      <div class="card pad"><h2>Investido por canal</h2><${Donut} items=${r.canais.map((c) => ({ name: CH_SHORT[c.nome], n: c.investido }))} fmt=${money} fmtTotal=${milBRL} label="Pizza do investimento em cada canal" /></div>
      <div class="card pad"><h2>Digital × físico (vendido)</h2><${Donut} items=${r.tipos.map((x) => ({ name: x.nome, n: x.receita }))} fmt=${money} fmtTotal=${milBRL} label="Pizza do vendido em produto digital e físico" /></div>
    </div>
    <div class="card pad"><h2>Investido, vendido e lucro em cada canal</h2><${ChannelBars} canais=${r.canais} /></div>
    <div class="card pad"><h2>Resultado por canal</h2><div style="overflow-x:auto">
      <table class="t"><thead><tr><th>Canal</th><th>Vendas</th><th>Investido</th><th>Vendido</th><th>Lucro</th><th>ROAS</th><th>ROI (nº)</th><th>ROI (%)</th></tr></thead><tbody>
        ${[...r.canais, t].map((c) => html`<tr style=${c === t ? 'font-weight:700' : ''}><td>${CH_SHORT[c.nome] || c.nome}</td><td>${num(c.vendas)}</td><td>${money(c.investido)}</td><td>${money(c.receita)}</td>
          <td style=${`color:${c.lucro < 0 ? C.perdidos : C.ganhos}`}>${money(c.lucro)}</td><td>${n1(c.roas)}</td><td>${n1(c.roi)}</td><td>${roiPct(c.roi)}</td></tr>`)}
      </tbody></table></div>
      <p class="xs muted">ROAS = vendido ÷ investido. ROI = lucro ÷ investido (ROI 10,3 = 1.030%). É a leitura dos gestores de tráfego.
        ${inv?.updated_at && html` Investimento atualizado em ${new Date(inv.updated_at).toLocaleString('pt-BR')}${inv.cambio ? ` (US$ 1 = R$ ${String(inv.cambio).replace('.', ',')})` : ''}.`}</p></div>
    <div class="dash-2">
      <div class="card pad"><h2>Vendido por mês</h2><${MonthBars} meses=${r.meses} /></div>
      <div class="card pad"><h2>Quem mais comprou</h2><div class="hbars">${r.clientes.map((c) => html`<div class="hbar" title=${`${c.nome}: ${money(c.receita)} · ${c.vendas} ${c.vendas > 1 ? 'vendas' : 'venda'}`}>
        <span class="hbar-l ellipsis">${c.nome}</span>
        <span class="hbar-track"><span class="hbar-fill" style=${`width:${(c.receita / Math.max(1, r.clientes[0]?.receita || 1)) * 100}%;background:${C.ganhos}`}></span></span>
        <span class="hbar-v">${money(c.receita)}</span></div>`)}</div></div>
    </div>
    ${inv?.campanhas?.length > 0 && html`<div class="card pad"><h2>Campanhas do Facebook (desde o início)</h2><div style="overflow-x:auto">
      <table class="t"><thead><tr><th>Campanha</th><th>Gasto</th><th>Conversas</th><th>Custo por conversa</th></tr></thead><tbody>
        ${inv.campanhas.map((c) => html`<tr><td>${c.nome}</td><td>US$ ${Number(c.usd || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td><td>${num(c.conversas)}</td>
          <td>${c.conversas ? `US$ ${(c.usd / c.conversas).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</td></tr>`)}</tbody></table></div></div>`}
    ${r.criativos?.length > 0 && html`<div class="card pad"><h2>Vendas por criativo</h2><div style="overflow-x:auto">
      <table class="t"><thead><tr><th>Criativo</th><th>Campanhas</th><th>Contatos</th><th>Vendas</th><th>Vendido</th><th>Lucro bruto</th><th>Contato → venda</th></tr></thead><tbody>
        ${r.criativos.map((c) => html`<tr><td>${c.nome}</td><td class="small">${c.campanhas.join(', ') || '—'}</td><td>${num(c.contatos)}</td><td>${num(c.vendas)}</td>
          <td>${money(c.receita)}</td><td style=${`color:${C.ganhos}`}>${money(c.lucro)}</td><td>${c.contatos ? `${Math.round((c.vendas / c.contatos) * 100)}%` : '—'}</td></tr>`)}</tbody></table></div>
      <p class="xs muted">Contatos = quem chegou clicando no anúncio (o CRM grava sozinho desde 20/11). Lucro bruto = vendido − custo − taxa, sem o gasto com anúncio.
        ${r.sem_anuncio > 0 && ` ${r.sem_anuncio} ${r.sem_anuncio === 1 ? 'venda de anúncio está' : 'vendas de anúncio estão'} sem o criativo: preencha "Anúncio de origem" no cartão do lead.`}</p></div>`}
    <div class="card pad"><h2>Todas as vendas</h2><div style="overflow-x:auto">
      <table class="t"><thead><tr><th>Data</th><th>Canal</th><th>Cliente</th><th>Produto</th><th>Criativo</th><th>Valor</th><th>Taxa</th><th>Custo</th></tr></thead><tbody>
        ${r.vendas.map((v) => html`<tr><td>${new Date(v.closed_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td><td class="small">${CH_SHORT[v.canal]}</td>
          <td><a href=${`#/lead/${v.lead_id}`}>${v.cliente}</a></td><td class="small">${v.produto}</td><td class="small">${v.anuncio?.criativo || '—'}</td><td>${money(v.valor)}</td><td>${money(v.taxa)}</td>
          <td>${v.custo == null ? html`<span class="pill warn">falta</span>` : money(v.custo)}</td></tr>`)}</tbody></table></div></div>`;
}
