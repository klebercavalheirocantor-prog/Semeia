import { html, useState, useEffect, api, post, patch, del, fail, toast, Confirm, B, go, ago, money, useData, useDebounced, Modal, Channel, UserSelect, StageSelect, Skeleton, ErrorBox, Empty, stageById, userName } from '../lib.js';
import { Bubble, Composer } from './feed.js';
import { LossModal } from './leads.js';

// Filtro rápido por número: só aparecem os grupos que têm canal (EUA aparece quando houver número com tradução para inglês).
const VIA = [['br', '🇧🇷 Brasil'], ['es', '🇵🇾 Espanhol'], ['en', '🇺🇸 EUA'], ['email', '✉ E-mail']];
const FILTERS = [['open', 'Abertas'], ['waiting', 'Aguardando resposta'], ['unread', 'Não lidas'], ['mine', 'Minhas'], ['closed', 'Fechadas']];

function LinkLeadModal({ convId, onClose }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data } = useData(() => (dq.length >= 2 ? api(`/leads?closed=all&q=${encodeURIComponent(dq)}`) : Promise.resolve([])), [dq]);
  const link = (leadId) => post(`/conversations/${convId}/link`, { lead_id: leadId }).then(onClose).catch(fail);
  return html`<${Modal} title="Juntar a um lead existente" onClose=${onClose}>
    <div class="col"><input autofocus type="search" aria-label="Buscar lead" placeholder="Buscar lead pelo nome ou telefone" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${(data || []).filter((l) => stageById(l.stage_id)?.kind !== 'incoming').map((l) => html`<button class="btn" style="justify-content:flex-start" onClick=${() => link(l.id)}>${l.name}
      <span class="muted small">${stageById(l.stage_id)?.name}</span></button>`)}</div>
  <//>`;
}

function Conversation({ id }) {
  const { data: c, error, reload } = useData(() => api(`/conversations/${id}`), [id], ['message', 'lead']);
  const [linking, setLinking] = useState(false);
  const [loss, setLoss] = useState(null);
  const [askDel, setAskDel] = useState(false);
  useEffect(() => { if (c?.unread > 0) patch(`/conversations/${id}`, { read: true }).catch(() => {}); }, [c?.messages.length, c?.unread]);
  useEffect(() => { const el = document.getElementById('chat-scroll'); if (el) el.scrollTop = el.scrollHeight; }, [c?.messages.length, c?.messages.at(-1)?.status]);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!c) return html`<div class="page"><${Skeleton} rows=${5} /></div>`;
  const stage = c.lead && stageById(c.lead.stage_id);
  const act = (a) => post(`/conversations/${id}/${a}`).then(reload).catch(fail);
  const saveLead = (b) => patch(`/leads/${c.lead.id}`, b).then(reload).catch(fail);
  const conversations = [{ id: c.id, channel_id: c.channel.id ?? c.channel_id, channel: c.channel.kind, status: c.status, last_inbound_at: c.last_inbound_at }];
  return html`
    <div class="inbox-chat">
      <div class="chat-head">
        <a href="#/chats" class="btn ghost sm" aria-label="Voltar para a lista" style="display:var(--back,inline-flex)">←</a>
        <${Channel} kind=${c.channel.kind} />
        <div class="grow" style="min-width:0"><div class="ellipsis"><strong>${c.contact.name}</strong></div>
          <div class="xs muted ellipsis">${c.contact.phones[0] || c.channel.name}${c.lead ? html` · <a href=${`#/lead/${c.lead.id}`}>${c.lead.name}</a>` : ''}</div></div>
        ${c.status === 'open' ? html`<button class="btn sm" onClick=${() => patch(`/conversations/${id}`, { status: 'closed' }).then(reload).catch(fail)}>Encerrar conversa</button>`
          : html`<button class="btn sm" onClick=${() => patch(`/conversations/${id}`, { status: 'open' }).then(reload).catch(fail)}>Reabrir</button>`}
        ${B().user.is_admin && html`<button class="btn danger sm" title="Excluir conversa" onClick=${() => setAskDel(true)}>Excluir</button>`}
      </div>
      ${stage?.kind === 'incoming' && html`<div class="banner info row wrap" style="margin:8px 16px 0">Conversa nova. É um cliente de verdade?<span class="spacer"></span>
        <button class="btn primary sm" onClick=${() => act('accept')}>Aceitar</button>
        <button class="btn sm" onClick=${() => setLinking(true)}>Juntar a um lead</button>
        <button class="btn danger sm" onClick=${() => act('decline')}>Recusar</button></div>`}
      <div class="feed" id="chat-scroll">
        ${c.messages.map((m) => html`<${Bubble} key=${m.id} m=${m} channelId=${c.channel_id} />`)}
        ${!c.messages.length && html`<${Empty} title="Sem mensagens" />`}
      </div>
      <${Composer} key=${id} entity="lead" entityId=${c.lead?.id || 0} conversations=${conversations} onSent=${reload}
        contactId=${c.contact.id} contactName=${c.contact.name} leadId=${c.lead?.id} />
    </div>
    <aside class="inbox-side col" aria-label="Lead">
      ${c.lead ? html`
        <h2><a href=${`#/lead/${c.lead.id}`}>${c.lead.name}</a></h2>
        <label class="field">Etapa<${StageSelect} pipelineId=${c.lead.pipeline_id} value=${c.lead.stage_id} onChange=${(sid) => (stageById(sid).kind === 'lost' ? setLoss(sid) : saveLead({ stage_id: sid }))} /></label>
        <label class="field">Responsável<${UserSelect} value=${c.lead.responsible_id} onChange=${(v) => saveLead({ responsible_id: v })} /></label>
        <p class="small">Valor: <strong>${money(c.lead.price_cents)}</strong></p>
        <a class="btn" href=${`#/lead/${c.lead.id}`}>Abrir cartão completo</a>`
        : html`<p class="muted small">Esta conversa não está ligada a um lead.</p>`}
      <div class="section-title">Contato</div>
      <a href=${`#/contact/${c.contact.id}`}>${c.contact.name}</a>
      ${c.contact.phones.map((p) => html`<span class="small">📞 ${p}</span>`)}
      ${c.contact.emails.map((m) => html`<span class="small">✉ ${m}</span>`)}
    </aside>
    ${linking && html`<${LinkLeadModal} convId=${id} onClose=${() => { setLinking(false); reload(); }} />`}
    ${askDel && html`<${Confirm} title="Excluir conversa?" danger okLabel="Excluir"
      text=${`Apaga esta conversa e todas as mensagens dela aqui no Fechaê (no celular continua). O contato fica${stage?.kind === 'incoming' ? '; o lead ainda não triado sai do funil' : ' e o lead continua no funil'}. Não dá para desfazer.`}
      onClose=${() => setAskDel(false)}
      onOk=${() => del(`/conversations/${id}`).then(() => { toast('Conversa excluída'); go('#/chats'); })} />`}
    ${loss && html`<${LossModal} onClose=${() => setLoss(null)} onOk=${(r) => saveLead({ stage_id: loss, loss_reason_id: r })} />`}`;
}

export function InboxPage({ id, query }) {
  const [filter, setFilter] = useState(query.f || 'open');
  const [via, setVia] = useState(() => { try { return sessionStorage.getItem('semeia-via') || ''; } catch { return ''; } });
  const pickVia = (v) => { setVia(v); try { sessionStorage.setItem('semeia-via', v); } catch {} };
  const vias = VIA.filter(([k]) => B().channels.some((c) => c.group === k && c.status !== 'disabled'));
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, error, reload } = useData(() => api(`/conversations?filter=${filter}${via ? `&via=${via}` : ''}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`), [filter, via, dq], ['message', 'lead']);
  const hasChannel = B().channels.length > 0;
  // Zera as não lidas (no Semeia e no celular), respeitando o número escolhido no filtro.
  const readAll = async () => {
    if (!confirm(`Marcar como lidas todas as conversas com mensagem nova${via ? ' deste número' : ''}? No celular elas também ficam lidas.`)) return;
    try { const r = await post('/conversations/read-all', { via }); toast(`${r.count} conversa${r.count === 1 ? '' : 's'} marcada${r.count === 1 ? '' : 's'} como lida${r.count === 1 ? '' : 's'}`); reload(); } catch (e) { fail(e); }
  };
  return html`<div class="main"><div class="inbox ${id ? 'has-chat' : ''}">
    <section class="inbox-list" aria-label="Conversas">
      <div style="padding:8px"><input type="search" aria-label="Buscar conversas" placeholder="Buscar cliente ou mensagem" value=${q} onInput=${(e) => setQ(e.target.value)} style="width:100%" /></div>
      ${vias.length > 1 && html`<div class="filters" role="group" aria-label="Número">
        <button class="chip" aria-pressed=${!via} onClick=${() => pickVia('')}>Todas</button>
        ${vias.map(([k, label]) => html`<button class="chip" aria-pressed=${via === k} onClick=${() => pickVia(via === k ? '' : k)}>${label}</button>`)}</div>`}
      <div class="filters" role="group" aria-label="Filtro">${FILTERS.map(([k, label]) => html`<button class="chip" aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${label}</button>`)}</div>
      ${(data || []).some((c) => c.unread > 0) && html`<div style="padding:0 8px 6px"><button class="btn sm" onClick=${readAll}>✓ Marcar todas como lidas</button></div>`}
      <div class="items">
        ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
        ${!data && !error && html`<div style="padding:8px"><${Skeleton} rows=${6} h=${48} /></div>`}
        ${data && !data.length && (hasChannel ? html`<${Empty} title="Nenhuma conversa aqui"><p>As mensagens de clientes aparecem nesta lista.</p><//>`
          : html`<${Empty} title="Nenhum canal conectado"><p>Conecte o WhatsApp para receber mensagens.</p>${B().user.is_admin && html`<a class="btn primary" href="#/settings/channels">Conectar canal</a>`}<//>`)}
        ${(data || []).map((c) => html`<a class="conv-item ${c.unread ? 'unread' : ''}" href=${`#/chats/${c.id}`} aria-current=${String(c.id) === String(id) ? 'page' : null}>
          <${Channel} kind=${c.channel} />
          <div class="grow" style="min-width:0">
            <div class="row"><span class="name grow ellipsis">${c.contact_name}</span><span class="xs muted">${ago(c.last_message_at)}</span></div>
            <div class="row small muted"><span class="grow ellipsis">${c.last_msg?.dir === 'out' ? 'Você: ' : ''}${c.last_msg?.body || (c.last_msg ? '[mídia]' : '')}</span>
              ${c.unread > 0 && html`<span class="badge">${c.unread}</span>`}</div>
            <div class="xs muted ellipsis">${stageById(c.stage_id)?.name || 'Sem lead'}${c.responsible_id ? ` · ${userName(c.responsible_id)}` : ''}</div>
          </div></a>`)}
      </div>
    </section>
    ${id ? html`<${Conversation} key=${id} id=${id} />` : html`<div class="inbox-chat"><${Empty} title="Escolha uma conversa"><p>Clique numa conversa à esquerda para responder.</p><//></div>`}
  </div></div>`;
}
