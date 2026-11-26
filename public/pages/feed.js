import { html, useState, useEffect, useRef, api, post, patch, del, fail, B, userName, money, fmtTime, fmtDay, dayKey, dueLabel, toLocalInput, endOfDay, Channel, UserSelect, Confirm, Modal } from '../lib.js';

const STATUS = { pending: ['🕓', 'Enviando'], sent: ['✓', 'Enviada'], delivered: ['✓✓', 'Entregue'], read: ['✓✓', 'Lida'], failed: ['⚠', 'Falhou'] };

// Foto aberta por cima da conversa, com "Fechar". No app instalado no celular não há botão de voltar do navegador:
// abrir a foto numa página nova deixava a pessoa presa nela. O gesto/botão "voltar" do celular também fecha.
function PhotoView({ src, alt, onClose }) {
  useEffect(() => {
    history.pushState({ foto: 1 }, '');
    let closed = false;
    const onPop = () => { closed = true; onClose(); };
    const onKey = (e) => e.key === 'Escape' && history.back();
    addEventListener('popstate', onPop);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('popstate', onPop); removeEventListener('keydown', onKey); if (!closed && history.state?.foto) history.back(); };
  }, []);
  return html`<div class="lightbox" role="dialog" aria-modal="true" aria-label="Foto" onClick=${() => history.back()}>
    <button class="btn lightbox-close" onClick=${(e) => { e.stopPropagation(); history.back(); }}>✕ Fechar</button>
    <img src=${src} alt=${alt} onClick=${(e) => e.stopPropagation()} />
    <a class="btn sm lightbox-dl" href=${src} download onClick=${(e) => e.stopPropagation()}>Baixar</a>
  </div>`;
}

// Player de áudio no estilo WhatsApp: play/pausa, barra, tempo e velocidade (1x, 1,5x, 2x).
const fmtSec = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');
const SPEEDS = [1, 1.5, 2];
function AudioPlayer({ src, voice, mine }) {
  const ref = useRef();
  const [on, setOn] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [sp, setSp] = useState(0);
  const toggle = () => { const a = ref.current; if (a.paused) { document.querySelectorAll('audio').forEach((x) => x !== a && x.pause()); a.play().catch(fail); } else a.pause(); };
  const speed = () => { const n = (sp + 1) % SPEEDS.length; setSp(n); ref.current.playbackRate = SPEEDS[n]; };
  // WebM gravado no navegador às vezes não informa a duração: descobre pulando para o fim.
  const meta = (e) => { const a = e.target; if (Number.isFinite(a.duration)) setDur(a.duration); else { a.currentTime = 1e9; a.ontimeupdate = () => { a.ontimeupdate = null; setDur(a.duration); a.currentTime = 0; }; } };
  return html`<div class=${`ap ${mine ? 'mine' : ''}`}>
    <audio ref=${ref} src=${src} preload="metadata" onLoadedMetadata=${meta} onTimeUpdate=${(e) => setT(e.target.currentTime)}
      onPlay=${() => setOn(true)} onPause=${() => setOn(false)} onEnded=${() => { setOn(false); setT(0); }}></audio>
    <button type="button" class="ap-play" onClick=${toggle} aria-label=${on ? 'Pausar áudio' : 'Tocar áudio'}>
      ${on ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>`
        : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>`}</button>
    <div class="ap-mid">
      <input type="range" class="ap-bar" min="0" max=${dur || 1} step="0.1" value=${t} aria-label="Posição do áudio" style=${`--p:${dur ? (t / dur) * 100 : 0}%`}
        onInput=${(e) => { ref.current.currentTime = Number(e.target.value); setT(Number(e.target.value)); }} />
      <div class="ap-time"><span>${fmtSec(on || t ? t : dur)}</span>${voice && html`<span class="ap-mic" title="Mensagem de voz">🎤</span>`}</div>
    </div>
    <button type="button" class="ap-speed" onClick=${speed} aria-label="Velocidade do áudio">${String(SPEEDS[sp]).replace('.', ',')}x</button>
  </div>`;
}

// Gravar áudio (mensagem de voz): microfone do navegador; o servidor converte para o formato de voz do WhatsApp.
const REC_TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
function VoiceRecorder({ onSend, onCancel }) {
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState('');
  const rec = useRef(null);
  const chunks = useRef([]);
  const sendOnStop = useRef(false);
  useEffect(() => {
    let stream, timer, alive = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        const type = REC_TYPES.find((x) => window.MediaRecorder?.isTypeSupported?.(x)) || '';
        const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
        r.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          if (!sendOnStop.current) return;
          const mime = (r.mimeType || 'audio/webm').split(';')[0];
          const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
          onSend(new File(chunks.current, `voz.${ext}`, { type: mime }));
        };
        r.start(250);
        rec.current = r;
        const t0 = Date.now();
        timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); setSecs(s); if (s >= 300) stop(true); }, 250);
      } catch (e) { setErr(e.name === 'NotAllowedError' ? 'O navegador não liberou o microfone. Clique no cadeado ao lado do endereço e permita o microfone.' : `Não consegui usar o microfone (${e.message}).`); }
    })();
    return () => { alive = false; clearInterval(timer); if (rec.current?.state === 'recording') { sendOnStop.current = false; rec.current.stop(); } else stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  const stop = (send) => { sendOnStop.current = send; if (rec.current?.state === 'recording') rec.current.stop(); if (!send) onCancel(); };
  if (err) return html`<div class="rec-bar"><span class="error-text grow">${err}</span><button type="button" class="btn sm" onClick=${onCancel}>Fechar</button></div>`;
  return html`<div class="rec-bar" role="group" aria-label="Gravando áudio">
    <button type="button" class="round-btn ghost" onClick=${() => stop(false)} aria-label="Descartar áudio" title="Descartar">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7z" /></svg></button>
    <span class="rec-dot" aria-hidden="true"></span><span class="rec-time" aria-live="off">${fmtSec(secs)}</span>
    <span class="grow small muted">Gravando… fale normalmente</span>
    <button type="button" class="round-btn send" onClick=${() => stop(true)} aria-label="Enviar áudio" title="Enviar áudio">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20l18-8L3 4v6l12 2-12 2z" /></svg></button>
  </div>`;
}

export function Bubble({ m, channelId }) {
  const [zoom, setZoom] = useState(false);
  // Número com tradução (Paraguai/Argentina, EUA): a mensagem do cliente ganha "Traduzir para português".
  const group = B().channels.find((x) => x.id === (m.channel_id ?? channelId))?.group;
  const [tr, setTr] = useState(m.translated_body || '');
  const [trBusy, setTrBusy] = useState(false);
  const translate = async () => { setTrBusy(true); try { setTr((await post(`/messages/${m.id}/translate`)).text); } catch (e) { fail(e); } setTrBusy(false); };
  // Áudio do cliente: texto transcrito (Groq); os novos chegam transcritos, os antigos têm o botão.
  const [ts, setTs] = useState(m.transcript || '');
  const transcribe = async () => { setTrBusy(true); try { const r = await post(`/messages/${m.id}/transcribe`); setTs(r.transcript); if (r.translated) setTr(r.translated); } catch (e) { fail(e); } setTrBusy(false); };
  useEffect(() => { if (m.transcript) setTs(m.transcript); if (m.translated_body) setTr(m.translated_body); }, [m.transcript, m.translated_body]);
  const canTr = m.direction === 'in' && (m.body || ts) && (group === 'es' || group === 'en');
  const canTs = m.direction === 'in' && m.kind === 'audio' && m.file_id && !ts && B().transcribe;
  const f = m.file_id && `/api/files/${m.file_id}`;
  const mime = m.file_mime || '';
  let media = null;
  if (f && mime.startsWith('image/')) media = html`<button type="button" class="bubble-img" onClick=${() => setZoom(true)} aria-label="Abrir foto"><img src=${f} alt=${m.file_name || 'imagem'} loading="lazy" /></button>
    ${zoom && html`<${PhotoView} src=${f} alt=${m.file_name || 'imagem'} onClose=${() => setZoom(false)} />`}`;
  else if (f && mime.startsWith('audio/')) media = html`<${AudioPlayer} src=${f} voice=${mime === 'audio/ogg' || /^voz-/.test(m.file_name || '')} mine=${m.direction === 'out'} />`;
  else if (f && mime.startsWith('video/')) media = html`<video controls src=${f} preload="none"></video>`;
  else if (f) media = html`<a href=${f} target="_blank" rel="noopener">📎 ${m.file_name || 'arquivo'}</a>`;
  else if (m.kind !== 'text' && m.kind !== 'other' && !m.body) media = html`<span class="muted small">${m.error ? 'Mídia indisponível' : 'Baixando mídia…'}</span>`;
  const st = STATUS[m.status];
  return html`<div class="bubble ${m.direction} ${m.status === 'failed' ? 'failed' : ''}">
    ${media}${media && m.body ? html`<br />` : ''}${m.body}
    ${m.original_body && html`<div class="small muted" style="margin-top:4px">🌐 traduzido · você escreveu: ${m.original_body}</div>`}
    ${ts && html`<div class="small tr-in">📝 ${ts}</div>`}
    ${canTs && html`<button type="button" class="link-btn small" disabled=${trBusy} onClick=${transcribe}>${trBusy ? 'Transcrevendo…' : '📝 Transcrever áudio'}</button>`}
    ${tr && html`<div class="small tr-in">🌐 Em português: ${tr}</div>`}
    ${canTr && !tr && html`<button type="button" class="link-btn small" disabled=${trBusy} onClick=${translate}>${trBusy ? 'Traduzindo…' : '🌐 Traduzir para português'}</button>`}
    <div class="meta">
      ${m.channel && html`<${Channel} kind=${m.channel} />`}
      ${m.kind === 'template' && html`<span>modelo ·</span>`}
      ${m.direction === 'out' && (m.user_name || userName(m.user_id)) && html`<span>${m.user_name || userName(m.user_id)} ·</span>`}
      ${m.bot ? html`<span title="Enviada pelo fluxo automático">🤖 robô ·</span>` : ''}
      <span>${fmtTime(m.created_at)}</span>
      ${m.direction === 'out' && st && html`<span class="tick ${m.status}" title=${st[1]}>${st[0]}<span class="sr-only">${st[1]}</span></span>`}
    </div>
    ${m.status === 'failed' && m.error && html`<div class="error-text">${m.error}</div>`}
  </div>`;
}

const fmtVal = (v) => (v === null || v === undefined || v === '' ? 'vazio' : Array.isArray(v) ? v.join(', ') : v === true ? 'sim' : v === false ? 'não' : String(v));

function eventText(e) {
  const d = e.data || {};
  const who = e.user_id ? userName(e.user_id) : d.by === 'robô' ? 'O robô' : 'Sistema';
  switch (e.type) {
    case 'lead_added': return `Lead criado${d.source === 'anuncio' ? ' pelo anúncio' : d.source && d.source !== 'manual' ? ` por mensagem (${d.source})` : ''} em "${d.stage}"`;
    case 'ad_click': return `Chegou pelo anúncio do ${d.where}${d.title ? `: ${d.title}` : ''}`;
    case 'stage_changed': return `${who} moveu de "${d.from}" para "${d.to}"${d.reason ? ` · motivo: ${d.reason}` : ''}`;
    case 'responsible_changed': return `${who} trocou o responsável: ${userName(d.from) || 'ninguém'} → ${userName(d.to) || 'ninguém'}`;
    case 'price_changed': return `${who} mudou o valor: ${money(d.from)} → ${money(d.to)}`;
    case 'name_changed': return `${who} renomeou: "${d.from}" → "${d.to}"`;
    case 'contact_linked': return `${who} vinculou o contato ${d.name}`;
    case 'contact_unlinked': return `${who} desvinculou o contato ${d.name || ''}`;
    case 'field_changed': return `${who} mudou ${d.name}: ${fmtVal(d.from)} → ${fmtVal(d.to)}`;
    case 'bot_handoff': return `O robô passou para um atendente: ${d.note}`;
    case 'conversation_linked': return `${who} juntou uma conversa a este lead`;
    default: return e.type;
  }
}

function TaskItem({ k }) {
  const [res, setRes] = useState(null);
  const type = B().task_types.find((t) => t.id === k.type_id);
  const overdue = !k.done_at && k.due_at < Date.now();
  const done = async () => { try { await patch(`/tasks/${k.id}`, { done: true, result: res }); setRes(null); } catch (e) { fail(e); } };
  return html`<div class="task-item ${overdue ? 'overdue' : ''} ${k.done_at ? 'done' : ''}" style=${type ? `--type-color:${type.color}` : ''}>
    <div class="row wrap small">
      <strong>${type?.name || 'Tarefa'}</strong>
      <span class=${overdue ? 'pill danger' : 'muted'}>${overdue ? 'Atrasada · ' : ''}${dueLabel(k.due_at)}</span>
      <span class="muted">para ${userName(k.responsible_id) || '—'}</span>
      <span class="spacer"></span>
      ${!k.done_at && res === null && html`<button class="btn sm" onClick=${() => setRes('')}>Concluir</button>`}
      ${k.done_at && html`<span class="pill ok">Concluída</span>`}
    </div>
    <div>${k.text}</div>
    ${k.result && html`<div class="small muted">Resultado: ${k.result}</div>`}
    ${res !== null && html`<div class="row" style="margin-top:6px"><input class="grow" autofocus placeholder="O que aconteceu? (opcional)" aria-label="Resultado da tarefa" value=${res}
      onInput=${(e) => setRes(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && done()} /><button class="btn primary sm" onClick=${done}>Salvar</button><button class="btn sm" onClick=${() => setRes(null)}>Cancelar</button></div>`}
  </div>`;
}

function NoteItem({ n }) {
  const [ask, setAsk] = useState(false);
  const me = B().user;
  return html`<div class="note ${n.is_pinned ? 'pinned' : ''}">
    <div class="row small muted"><strong>${userName(n.created_by) || 'Nota'}</strong><span>${fmtTime(n.created_at)}</span><span class="spacer"></span>
      <button class="btn ghost sm" onClick=${() => patch(`/notes/${n.id}`, { is_pinned: !n.is_pinned }).catch(fail)}>${n.is_pinned ? 'Desafixar' : 'Fixar'}</button>
      ${(n.created_by === me.id || me.is_admin) && html`<button class="btn ghost sm" onClick=${() => setAsk(true)}>Apagar</button>`}</div>
    ${n.body}
    ${ask && html`<${Confirm} title="Apagar nota?" text="Isso não pode ser desfeito." danger okLabel="Apagar" onOk=${() => del(`/notes/${n.id}`)} onClose=${() => setAsk(false)} />`}
  </div>`;
}

export function Feed({ items }) {
  const ref = useRef();
  const last = items[items.length - 1];
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [items.length, last?.id, last?.status]);
  const pinned = items.filter((i) => i.t === 'note' && i.is_pinned);
  let prevDay = null;
  return html`<div class="feed" ref=${ref} aria-live="polite">
    ${pinned.length > 0 && html`<div class="col">${pinned.map((n) => html`<${NoteItem} key=${'p' + n.id} n=${n} />`)}</div>`}
    ${!items.length && html`<div class="empty"><h3>Nada por aqui ainda</h3><p>Escreva uma nota, crie uma tarefa ou responda o cliente.</p></div>`}
    ${items.map((i) => {
      const d = dayKey(i.created_at);
      const sep = d !== prevDay ? html`<div class="day">${fmtDay(i.created_at)}</div>` : null;
      prevDay = d;
      const body = i.t === 'message' ? html`<${Bubble} m=${i} />` : i.t === 'note' ? html`<${NoteItem} n=${i} />` : i.t === 'task' ? html`<${TaskItem} k=${i} />`
        : html`<div class="event">${fmtTime(i.created_at)} · ${eventText(i)}</div>`;
      return html`${sep}<div key=${i.t + i.id} style=${i.t === 'message' ? 'display:flex;flex-direction:column' : ''}>${body}</div>`;
    })}
  </div>`;
}

// Caixa de envio. conversations: [{id, channel, status, last_inbound_at}] (vazio = sem aba de mensagem)

// Envia mensagem modelo (template) do WhatsApp para um contato.
export function TemplateSend({ contactId, leadId, contactName, onClose, onSent }) {
  const [list, setList] = useState(null);
  const [tid, setTid] = useState(null);
  const [params, setParams] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/templates').then((l) => { const ok = l.filter((t) => t.status === 'APPROVED' && t.supported); setList(ok); if (ok[0]) setTid(ok[0].id); }).catch(fail); }, []);
  const tpl = list?.find((t) => t.id === tid);
  useEffect(() => { if (tpl) setParams(tpl.vars.map((v, i) => (i === 0 ? String(contactName || '').split(' ')[0] : ''))); }, [tid]);
  const body = tpl ? (tpl.components.find((c) => c.type === 'BODY')?.text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => params[tpl.vars.indexOf(v)] || `{{${v}}}`) : '';
  const send = async () => {
    setBusy(true);
    try {
      const r = await post('/whatsapp/template', { template_id: tid, contact_id: contactId, lead_id: leadId, params });
      if (r.status === 'failed') fail(new Error(r.error || 'A Meta recusou'));
      onSent?.(r);
      onClose();
    } catch (e) { fail(e); setBusy(false); }
  };
  return html`<${Modal} title="Mensagem modelo do WhatsApp" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancelar</button>
    <button class="btn primary" disabled=${busy || !tpl || params.some((p) => !p.trim())} onClick=${send}>${busy ? 'Enviando…' : 'Enviar'}</button>`}>
    ${!list && html`<p class="muted">Carregando modelos…</p>`}
    ${list && !list.length && html`<div class="col"><p>Nenhum modelo aprovado ainda.</p>
      <p class="small muted">Crie em Configurações > Modelos do WhatsApp. A Meta costuma aprovar em minutos.</p>
      ${B().user.is_admin && html`<a class="btn" href="#/settings/templates" onClick=${onClose}>Ir para modelos</a>`}</div>`}
    ${list?.length > 0 && html`<div class="form">
      <label class="field">Modelo<select value=${tid} onChange=${(e) => setTid(Number(e.target.value))}>${list.map((t) => html`<option value=${t.id}>${t.name} (${t.language})</option>`)}</select></label>
      ${tpl?.vars.map((v, i) => html`<label class="field">Variável {{${v}}}<input value=${params[i] || ''} onInput=${(e) => { const n = [...params]; n[i] = e.target.value; setParams(n); }} /></label>`)}
      <div class="field">Como o cliente vai ver<div class="bubble out" style="max-width:100%">${body}</div></div>
    </div>`}
  <//>`;
}

// Antes de mandar uma foto: riscar à mão livre (com o dedo ou o mouse) para marcar algo. Sem riscos, vai a foto original.
const PEN_COLORS = [['#e53935', 'Vermelho'], ['#fdd835', 'Amarelo'], ['#1e88e5', 'Azul'], ['#ffffff', 'Branco'], ['#111111', 'Preto']];
function PhotoMarkup({ file, caption, onSend, onClose }) {
  const cv = useRef();
  const img = useRef();
  const strokes = useRef([]);
  const cur = useRef(null);
  const [color, setColor] = useState(PEN_COLORS[0][0]);
  const [count, setCount] = useState(0);
  const [cap, setCap] = useState(caption || '');
  const [busy, setBusy] = useState(false);
  const draw = (ctx, s) => {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
    ctx.stroke();
  };
  const redraw = () => {
    const c = cv.current;
    if (!c || !img.current) return;
    const ctx = c.getContext('2d');
    ctx.drawImage(img.current, 0, 0, c.width, c.height);
    strokes.current.forEach((s) => draw(ctx, s));
  };
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      img.current = im;
      const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight)); // foto grande fica com até 1600 px
      cv.current.width = Math.round(im.naturalWidth * k);
      cv.current.height = Math.round(im.naturalHeight * k);
      redraw();
    };
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, []);
  const pos = (e) => {
    const r = cv.current.getBoundingClientRect();
    return [(e.clientX - r.left) * cv.current.width / r.width, (e.clientY - r.top) * cv.current.height / r.height];
  };
  const down = (e) => {
    e.preventDefault();
    cv.current.setPointerCapture?.(e.pointerId);
    cur.current = { color, w: Math.max(4, cv.current.width / 140), pts: [pos(e)] };
    strokes.current.push(cur.current);
    draw(cv.current.getContext('2d'), cur.current);
  };
  const move = (e) => {
    if (!cur.current) return;
    e.preventDefault();
    const s = cur.current;
    const ctx = cv.current.getContext('2d');
    const [x0, y0] = s.pts.at(-1);
    const p = pos(e);
    s.pts.push(p);
    draw(ctx, { ...s, pts: [[x0, y0], p] });
  };
  const up = () => { if (cur.current) { cur.current = null; setCount(strokes.current.length); } };
  const undo = () => { strokes.current.pop(); setCount(strokes.current.length); redraw(); };
  const clear = () => { strokes.current = []; setCount(0); redraw(); };
  const send = () => {
    setBusy(true);
    if (!strokes.current.length) { onSend(file, cap); return; }
    const name = (file.name || 'foto').replace(/\.[^.]+$/, '') + '-marcada.jpg';
    cv.current.toBlob((b) => {
      if (!b) { setBusy(false); fail(new Error('Não consegui preparar a foto marcada')); return; }
      onSend(new File([b], name, { type: 'image/jpeg' }), cap);
    }, 'image/jpeg', 0.9);
  };
  return html`<${Modal} title="Marcar na foto" wide onClose=${onClose} footer=${html`
    <button class="btn" onClick=${onClose}>Cancelar</button>
    <button class="btn primary" disabled=${busy} onClick=${send}>${busy ? 'Enviando…' : count ? 'Enviar foto marcada' : 'Enviar foto'}</button>`}>
    <div class="col">
      <div class="row wrap markup-tools">
        <span class="small muted">Risque com o dedo ou o mouse:</span>
        ${PEN_COLORS.map(([c, n]) => html`<button type="button" class=${`pen ${color === c ? 'on' : ''}`} style=${`background:${c}`} aria-label=${`Cor ${n}`} aria-pressed=${color === c} onClick=${() => setColor(c)}></button>`)}
        <span class="spacer"></span>
        <button class="btn sm" disabled=${!count} onClick=${undo}>↶ Desfazer</button>
        <button class="btn sm" disabled=${!count} onClick=${clear}>Limpar</button>
      </div>
      <canvas ref=${cv} class="markup-canvas" aria-label="Foto para marcar" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onPointerLeave=${up}></canvas>
      <input aria-label="Legenda" placeholder="Legenda (opcional)" value=${cap} onInput=${(e) => setCap(e.target.value)} />
    </div>
  <//>`;
}

export function Composer({ entity, entityId, conversations = [], disabled, onSent, contactId, contactName, leadId }) {
  const [tplOpen, setTplOpen] = useState(false);
  const open = conversations.filter((c) => c.status === 'open');
  const [tab, setTab] = useState(open.length ? 'msg' : 'note');
  const [convId, setConvId] = useState(open[0]?.id || conversations[0]?.id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState({ type_id: B().task_types[0]?.id, due_at: endOfDay(0), responsible_id: B().user.id });
  const fileRef = useRef();
  const [markup, setMarkup] = useState(null); // foto escolhida, abrindo para riscar antes de mandar
  const [quickOpen, setQuickOpen] = useState(false);
  const [attach, setAttach] = useState(null); // tabela (imagem já salva) escolhida nas respostas prontas
  const [tables, setTables] = useState([]);
  const [recording, setRecording] = useState(false);
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const touch = matchMedia('(pointer: coarse)').matches; // no celular, Enter pula linha (como no WhatsApp)
  useEffect(() => { if (!conversations.find((c) => c.id === convId)) setConvId(open[0]?.id || conversations[0]?.id); }, [conversations.map((c) => c.id + c.status).join()]);
  const conv = conversations.find((c) => c.id === convId);
  const trTo = B().channels.find((x) => x.id === conv?.channel_id)?.translate_to || '';
  const windowClosed = conv?.channel === 'whatsapp' && (!conv.last_inbound_at || Date.now() - conv.last_inbound_at > 24 * 3600e3);

  const send = async () => {
    if (busy || (!text.trim() && !(tab === 'msg' && attach))) return;
    setBusy(true);
    try {
      if (tab === 'msg') await post(`/conversations/${convId}/messages`, { text, ...(attach && { file_id: attach.file_id }) });
      else if (tab === 'note') await post('/notes', { entity, entity_id: entityId, body: text });
      else await post('/tasks', { entity, entity_id: entityId, text, ...task });
      setText('');
      setAttach(null);
      onSent?.();
    } catch (e) { fail(e); }
    setBusy(false);
  };
  const sendFile = async (file, caption = text, voice = false) => {
    if (!file) return;
    setBusy(true);
    try {
      await api(`/conversations/${convId}/messages`, { method: 'POST', raw: true, body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-caption': encodeURIComponent(caption), ...(voice ? { 'x-voice': '1' } : {}) } });
      if (!voice) setText('');
      onSent?.();
    } catch (e) { fail(e); }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };
  // Foto passa antes pela tela de marcar; outros arquivos vão direto.
  const pickFile = (file) => {
    if (!file) return;
    if (/^image\/(jpeg|png|webp)$/.test(file.type)) setMarkup(file);
    else sendFile(file);
  };
  // Resposta pronta: entra na caixa de texto (dá para mexer antes de enviar). Número com tradução para espanhol usa a versão em espanhol.
  const quick = B().quick_replies || [];
  useEffect(() => { setTables([]); setAttach(null); if (conv?.channel === 'whatsapp') api(`/conversations/${convId}/tables`).then(setTables).catch(() => {}); }, [convId]);
  const useQuick = (r) => {
    const t = (trTo === 'es' && r.es) || r.pt || r.es;
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n${t}` : t));
    setQuickOpen(false);
  };
  const reopen = () => patch(`/conversations/${convId}`, { status: 'open' }).catch(fail);

  if (disabled) return html`<div class="composer muted small">Você pode ver, mas não editar este registro.</div>`;
  return html`<div class="composer" onDragOver=${(e) => tab === 'msg' && e.preventDefault()} onDrop=${(e) => { if (tab !== 'msg') return; e.preventDefault(); pickFile(e.dataTransfer.files[0]); }}>
    <div class="tabs" role="tablist">
      ${conversations.length > 0 && html`<button role="tab" aria-selected=${tab === 'msg'} onClick=${() => setTab('msg')}>Mensagem</button>`}
      <button role="tab" aria-selected=${tab === 'note'} onClick=${() => setTab('note')}>Nota</button>
      <button role="tab" aria-selected=${tab === 'task'} onClick=${() => setTab('task')}>Tarefa</button>
      ${tab === 'msg' && conversations.length > 1 && html`<select class="sm" aria-label="Conversa" style="margin-left:auto" value=${convId} onChange=${(e) => setConvId(Number(e.target.value))}>
        ${conversations.map((c) => html`<option value=${c.id}>${c.channel_name || c.channel} ${c.status === 'closed' ? '(fechada)' : ''}</option>`)}</select>`}
    </div>
    ${tab === 'msg' && conv?.status === 'closed' && html`<div class="banner info row">Conversa fechada.<span class="spacer"></span><button class="btn sm" onClick=${reopen}>Reabrir</button></div>`}
    ${tab === 'msg' && conv?.status !== 'closed' && windowClosed && html`<div class="banner warn row wrap">O cliente não escreve há mais de 24 h. O WhatsApp só entrega mensagem modelo aprovada até ele responder.
      ${contactId && html`<span class="spacer"></span><button class="btn sm" onClick=${() => setTplOpen(true)}>Enviar mensagem modelo</button>`}</div>`}
    ${markup && html`<${PhotoMarkup} file=${markup} caption=${text} onClose=${() => { setMarkup(null); if (fileRef.current) fileRef.current.value = ''; }}
      onSend=${async (f, cap) => { setMarkup(null); await sendFile(f, cap); }} />`}
    ${tplOpen && html`<${TemplateSend} contactId=${contactId} leadId=${leadId} contactName=${contactName} onClose=${() => setTplOpen(false)} onSent=${onSent} />`}
    ${tab === 'task' && html`<div class="row wrap">
      <select aria-label="Tipo" value=${task.type_id} onChange=${(e) => setTask({ ...task, type_id: Number(e.target.value) })}>${B().task_types.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select>
      <input type="datetime-local" aria-label="Prazo" value=${toLocalInput(task.due_at)} onInput=${(e) => e.target.value && setTask({ ...task, due_at: new Date(e.target.value).getTime() })} />
      <button class="btn sm" onClick=${() => setTask({ ...task, due_at: endOfDay(0) })}>Hoje</button>
      <button class="btn sm" onClick=${() => setTask({ ...task, due_at: endOfDay(1) })}>Amanhã</button>
      <button class="btn sm" onClick=${() => setTask({ ...task, due_at: endOfDay(3) })}>Em 3 dias</button>
      <${UserSelect} label="Responsável pela tarefa" none=${false} value=${task.responsible_id} onChange=${(v) => setTask({ ...task, responsible_id: v })} />
    </div>`}
    ${tab === 'msg' && attach && html`<div class="row small attach-chip">🖼 <span class="grow ellipsis">Tabela: <strong>${attach.name}</strong> (o texto abaixo vai como legenda)</span>
      <button class="btn ghost sm" aria-label="Tirar a tabela" onClick=${() => setAttach(null)}>✕</button></div>`}
    ${tab === 'msg' ? html`<div class="wa-input">
      ${recording ? html`<${VoiceRecorder} onCancel=${() => setRecording(false)} onSend=${(f) => { setRecording(false); sendFile(f, '', true); }} />` : html`
      <input type="file" ref=${fileRef} class="sr-only" id="file-${entityId}" onChange=${(e) => pickFile(e.target.files[0])} />
      <label for="file-${entityId}" class="round-btn ghost" title="Anexar foto ou arquivo" aria-label="Anexar foto ou arquivo" tabindex="0" onKeyDown=${(e) => e.key === 'Enter' && fileRef.current.click()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6.5l-7.8 7.8a2 2 0 002.8 2.8l7.8-7.8a4 4 0 00-5.7-5.7L5.8 11.4a6 6 0 008.5 8.5l6.2-6.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg></label>
      ${(quick.length > 0 || tables.length > 0) && html`<span style="position:relative">
        <button type="button" class="round-btn ghost" aria-expanded=${quickOpen} title="Respostas prontas" aria-label="Respostas prontas" disabled=${conv?.status === 'closed'} onClick=${() => setQuickOpen(!quickOpen)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></svg></button>
        ${quickOpen && html`<div class="card col quick-menu" role="menu" aria-label="Respostas prontas">
          ${quick.map((r) => html`<button role="menuitem" class="btn ghost" onClick=${() => useQuick(r)} title=${(trTo === 'es' && r.es) || r.pt || r.es}>
            <strong>${r.title}</strong><span class="xs muted ellipsis">${(trTo === 'es' && r.es) || r.pt || r.es}</span></button>`)}
          ${tables.length > 0 && html`<div class="xs muted" style="padding:6px 8px 2px">Tabelas de preço</div>
            ${tables.map((t) => html`<button role="menuitem" class="btn ghost" onClick=${() => { setAttach(t); setQuickOpen(false); }}><strong>🖼 ${t.name}</strong></button>`)}`}
          ${B().user.is_admin && html`<a class="xs" href="#/settings/quick" style="padding:4px 8px">Editar respostas prontas</a>`}
        </div>`}</span>`}
      <textarea class="wa-text" rows="1" aria-label="Mensagem" disabled=${conv?.status === 'closed'}
        placeholder=${trTo ? `Escreva em português: vai em ${trTo === 'es' ? 'espanhol' : 'inglês'}` : 'Mensagem'}
        value=${text} onInput=${(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!e.shiftKey && !touch))) { e.preventDefault(); send(); } }}></textarea>
      ${text.trim() || attach || !canRecord
        ? html`<button type="button" class="round-btn send" disabled=${busy || (!text.trim() && !attach) || conv?.status === 'closed'} onClick=${send} aria-label="Enviar" title="Enviar">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20l18-8L3 4v6l12 2-12 2z" /></svg></button>`
        : html`<button type="button" class="round-btn send" disabled=${busy || conv?.status === 'closed'} onClick=${() => setRecording(true)} aria-label="Gravar áudio" title="Gravar áudio">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V21h2v-2.1a7 7 0 006-6.9z" /></svg></button>`}`}
    </div>
    ${busy && html`<div class="xs muted">Enviando…</div>`}`
    : html`<textarea aria-label=${tab === 'note' ? 'Nota' : 'Descrição da tarefa'}
      placeholder=${tab === 'note' ? 'Nota interna, o cliente não vê' : 'O que precisa ser feito?'}
      value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}></textarea>
    <div class="row">
      <span class="spacer"></span>
      <button class="btn primary" disabled=${busy || !text.trim()} onClick=${send}>
        ${busy ? 'Salvando…' : tab === 'note' ? 'Salvar nota' : 'Criar tarefa'}</button>
    </div>`}
  </div>`;
}

