import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, Citation, api, apiDownload, streamPost } from './api';
import { ApprovalCard, ApprovalRow } from './Approvals';
import { ConsentGate } from './AiConsent';

interface Conv { id: string; title: string | null; updated_at: string }
type Card = { type: 'approval'; approval: ApprovalRow } | { type: 'report'; report: { id: string; title: string; format: string } };
interface CommandResult { handled: boolean; reply?: string; cards?: Card[] }
interface Turn { id?: number; cards?: Card[]; role: 'user' | 'assistant'; content: string; citations: Citation[]; pending?: boolean; failed?: string }

export function Assistant({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  return (
    <section>
      <header className="page-head">
        <h2>Assistant</h2>
        <p className="muted">Ask about your mail and calendar. Answers cite the messages they come from. It can draft wording for you but never sends anything.</p>
      </header>
      <ConsentGate><Chat onOpenThread={onOpenThread} /></ConsentGate>
    </section>
  );
}

const EXAMPLES = ['What did the client say about the invoice this week?', 'Do I have any conflicts tomorrow?', 'What needs a reply from me?', 'Build a weekly report as a PDF', 'Schedule a call with Dana tomorrow at 3pm for 30 minutes', 'Show my approvals'];

function Chat({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const loadConvs = useCallback(() => { api<Conv[]>('/chat/conversations').then(setConvs).catch((e) => setError(e.message)); }, []);
  useEffect(loadConvs, [loadConvs]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  async function open(id: string) {
    abort.current?.abort();
    setActive(id); setError('');
    const c = await api<{ turns: Turn[] }>(`/chat/conversations/${id}`);
    setTurns(c.turns);
  }

  async function ask(e?: FormEvent, preset?: string) {
    e?.preventDefault();
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    setInput(''); setError(''); setBusy(true);
    try {
      // Commands (report, calendar request, approvals) are matched by fixed patterns on the server, not by the AI; anything else is a question.
      const cmd = await api<CommandResult>('/assistant/command', { method: 'POST', body: JSON.stringify({ text }) });
      if (cmd.handled) {
        setTurns((t) => [...t, { role: 'user', content: text, citations: [] }, { role: 'assistant', content: cmd.reply ?? '', citations: [], cards: cmd.cards }]);
        setBusy(false);
        return;
      }
    } catch (err) {
      setError((err as Error).message); setBusy(false);
      return;
    }
    let id = active;
    try {
      if (!id) { id = (await api<{ id: string }>('/chat/conversations', { method: 'POST' })).id; setActive(id); }
      setTurns((t) => [...t, { role: 'user', content: text, citations: [] }, { role: 'assistant', content: '', citations: [], pending: true }]);
      const ctl = new AbortController();
      abort.current = ctl;
      await streamPost(`/chat/conversations/${id}/messages`, { content: text }, (ev) => {
        setTurns((t) => {
          const copy = [...t];
          const last = { ...copy[copy.length - 1] };
          if (ev.type === 'token') last.content += ev.text ?? '';
          else if (ev.type === 'citations') last.citations = ev.citations ?? [];
          else if (ev.type === 'error') last.failed = ev.message;
          else if (ev.type === 'done') last.pending = false;
          copy[copy.length - 1] = last;
          return copy;
        });
      }, ctl.signal);
      loadConvs();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setTurns((t) => (t.at(-1)?.pending ? t.slice(0, -1) : t));
      setError(err instanceof ApiError && err.code === 'ai_consent_required' ? 'Turn on AI features above to use the assistant.' : (err as Error).message);
    } finally {
      setBusy(false);
      setTurns((t) => t.map((x) => ({ ...x, pending: false })));
    }
  }

  return (
    <div className="chat">
      <aside className="chat-list" aria-label="Conversations">
        <button className="primary" onClick={() => { abort.current?.abort(); setActive(null); setTurns([]); }}>New chat</button>
        {convs.map((c) => (
          <div key={c.id} className={`row between conv ${c.id === active ? 'active' : ''}`}>
            <button className="link-btn" onClick={() => open(c.id)}>{c.title || 'Untitled'}</button>
            <button aria-label={`Delete ${c.title ?? 'conversation'}`} className="x" onClick={async () => { await api(`/chat/conversations/${c.id}`, { method: 'DELETE' }); if (active === c.id) { setActive(null); setTurns([]); } loadConvs(); }}>&times;</button>
          </div>
        ))}
      </aside>
      <div className="chat-main">
        <div className="turns" aria-live="polite">
          {turns.length === 0 && (
            <div className="muted">
              <p>Try asking:</p>
              <div className="stack">{EXAMPLES.map((x) => <button key={x} onClick={() => ask(undefined, x)}>{x}</button>)}</div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`turn ${t.role}`}>
              <div className="who muted small">{t.role === 'user' ? 'You' : 'Assistant'}</div>
              <div className="text">{t.content || (t.pending ? 'Thinking…' : '')}</div>
              {t.cards?.map((c, ci) => c.type === 'approval'
                ? <ApprovalCard key={ci} a={c.approval} onDone={(m) => setTurns((x) => [...x, { role: 'assistant', content: m, citations: [] }])} />
                : <div key={ci} className="card wide report-card"><span><strong>{c.report.title}</strong> <span className="muted small">{c.report.format.toUpperCase()}</span></span><button className="primary" onClick={() => apiDownload(`/reports/${c.report.id}/download`, `${c.report.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'report'}.${c.report.format}`).catch((e) => setError((e as Error).message))}>Download</button></div>)}
              {t.failed && <p className="error" role="alert">{t.failed}</p>}
              {t.citations.length > 0 && (
                <ul className="cites" aria-label="Sources">
                  {t.citations.map((c) => (
                    <li key={c.marker}>
                      <span className="badge">{c.marker}</span>{' '}
                      {c.kind === 'message' && c.threadId ? <button className="link" onClick={() => onOpenThread(c.threadId!)}>{c.title}</button> : <span>{c.title}</span>}
                      <span className="muted small"> · {c.who ? `${c.who} · ` : ''}{new Date(c.at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <form className="composer" onSubmit={ask}>
          <label className="sr-only" htmlFor="q">Ask a question</label>
          <input id="q" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about your mail and calendar" maxLength={2000} autoComplete="off" />
          <button className="primary" disabled={busy || !input.trim()}>{busy ? 'Answering…' : 'Ask'}</button>
        </form>
      </div>
    </div>
  );
}
