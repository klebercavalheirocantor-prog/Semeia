// Assistente do Fechaê: botão no menu que abre uma conversa com o Claude, que faz coisas no CRM pela pessoa.
import { html, useState, useEffect, useRef, post } from '../lib.js';

const KEY = 'fechae-assistente';
const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || []; } catch { return []; } };
const save = (m) => { try { sessionStorage.setItem(KEY, JSON.stringify(m.slice(-30))); } catch {} };
const EXEMPLOS = ['Quais conversas estão esperando resposta?', 'Quais leads estão sem tarefa?', 'Como foram as vendas nos últimos 7 dias?'];

export const ASSIST_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>`;

export function Assistente() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState(load);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { save(msgs); end.current?.scrollIntoView({ block: 'end' }); }, [msgs, open]);
  const send = async (t) => {
    const content = String(t ?? text).trim();
    if (!content || busy) return;
    const next = [...msgs, { role: 'user', content }];
    setMsgs(next); setText(''); setBusy(true);
    try {
      const r = await post('/assistente', { messages: next.map(({ role, content }) => ({ role, content })) });
      setMsgs([...next, { role: 'assistant', content: r.reply || '(sem resposta)', actions: r.actions }]);
    } catch (e) { setMsgs([...next, { role: 'assistant', content: `Não consegui: ${e.message}`, error: true }]); }
    setBusy(false);
  };
  // O botão "Assistente" do menu abre o painel.
  useEffect(() => { const f = () => setOpen((o) => !o); addEventListener('assistente', f); return () => removeEventListener('assistente', f); }, []);
  if (!open) return null;
  return html`<section class="assist" aria-label="Assistente">
    <header><strong>Assistente</strong><span class="xs muted">faz no CRM o que você pedir</span>
      ${msgs.length > 0 && html`<button class="btn ghost" onClick=${() => setMsgs([])} title="Começar de novo">Limpar</button>`}
      <button class="btn ghost" onClick=${() => setOpen(false)} aria-label="Fechar o assistente">✕</button></header>
    <div class="assist-body">
      ${!msgs.length && html`<div class="assist-hello"><p>Oi! Posso procurar leads e conversas, resumir uma conversa, criar tarefas, mudar lead de etapa e mostrar os números do painel.</p>
        ${EXEMPLOS.map((e) => html`<button class="btn" onClick=${() => send(e)}>${e}</button>`)}</div>`}
      ${msgs.map((m) => html`<div class=${`assist-msg ${m.role}${m.error ? ' error' : ''}`}>${m.content}
        ${m.actions?.length > 0 && html`<ul class="assist-done">${m.actions.map((a) => html`<li>✓ ${a}</li>`)}</ul>`}</div>`)}
      ${busy && html`<div class="assist-msg assistant muted">Pensando…</div>`}
      <div ref=${end}></div>
    </div>
    <form class="assist-input" onSubmit=${(e) => { e.preventDefault(); send(); }}>
      <label class="sr-only" for="assist-text">Mensagem para o assistente</label>
      <textarea id="assist-text" rows="2" placeholder="Ex.: cria uma tarefa para ligar para o João amanhã às 9h" value=${text} onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
      <button class="btn primary" disabled=${busy || !text.trim()}>Enviar</button>
    </form>
  </section>`;
}
