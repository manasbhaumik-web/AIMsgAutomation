import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { ConsentGate } from './AiConsent';

interface Digest { digest_date: string; text: string; model: string | null; created_at: string }
interface Item { id: string; text: string; due_at: string | null; thread_id: string; subject: string | null }
interface Settings { digest: { enabled: boolean; hour: number; timezone: string } }
interface Attn { id: string; subject: string | null; channel: string; priority: 'urgent' | 'needs_reply' | null; snippet: string | null; last_message_at: string; last_sender: { name?: string; email?: string; handle?: string } | null }
interface Ev { id: string; title: string; start_at: string; end_at: string; all_day: boolean }

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };
const time = (s: string) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (s: string) => new Date(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export function Today({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  return (
    <section>
      <header className="page-head"><h2>Today</h2><p className="muted">Your digest, schedule and open action items.</p></header>
      <ConsentGate><Body onOpenThread={onOpenThread} /></ConsentGate>
    </section>
  );
}

function Body({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const [digest, setDigest] = useState<Digest | null | undefined>(undefined);
  const [items, setItems] = useState<Item[]>([]);
  const [attention, setAttention] = useState<Attn[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [sched, setSched] = useState<Settings['digest']>({ enabled: false, hour: 8, timezone: browserTz() });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api<Digest | null>('/digests/latest').then((d) => setDigest(d ?? null)).catch((e) => setMsg(e.message));
    api<Item[]>('/action-items').then(setItems).catch(() => undefined);
    api<Settings>('/me/ai').then((s) => setSched((p) => ({ ...p, ...s.digest, timezone: s.digest.timezone === 'UTC' && !s.digest.enabled ? browserTz() : s.digest.timezone }))).catch(() => undefined);
    Promise.all(['urgent', 'needs_reply'].map((p) => api<{ threads: Attn[] }>(`/inbox/threads?priority=${p}&limit=5`).then((r) => r.threads)))
      .then(([a, b]) => setAttention([...a, ...b])).catch(() => undefined);
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 2);
    api<{ events: Ev[] }>(`/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`).then((r) => setEvents(r.events)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function generate() {
    setBusy(true); setMsg('');
    try { await api('/digests', { method: 'POST', body: JSON.stringify({}) }); load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  async function saveSchedule(e: FormEvent) {
    e.preventDefault();
    try { await api('/me/digest-schedule', { method: 'PUT', body: JSON.stringify(sched) }); setMsg('Schedule saved.'); } catch (err) { setMsg((err as Error).message); }
  }

  return (
    <>
      <article className="card wide digest-card">
        <div className="between"><strong className="eyebrow">Daily digest</strong>{digest && <span className="muted small">{digest.digest_date}</span>}</div>
        {digest === undefined && <p className="muted">Loading&hellip;</p>}
        {digest === null && <p className="muted">No digest yet. Generate one now, or set a daily time below.</p>}
        {digest && <div className="digest">{digest.text}</div>}
        <div className="row"><button className="primary" disabled={busy} onClick={generate}>{busy ? 'Writing…' : digest ? 'Refresh digest' : 'Generate digest'}</button></div>
      </article>

      <div className="today-grid">
        <section className="panel" aria-label="Needs attention">
          <header className="panel-head"><h3>Needs attention</h3>{attention.length > 0 && <span className="count">{attention.length}</span>}</header>
          {attention.length === 0 && <p className="muted pad">Nothing urgent. Messages that need a reply or are time-critical appear here.</p>}
          {attention.map((t) => (
            <button key={`${t.priority}-${t.id}`} className="attn" onClick={() => onOpenThread(t.id)}>
              <span className="chips"><span className={`chip ${t.priority ?? ''}`}>{t.priority === 'urgent' ? 'Urgent' : 'Needs reply'}</span><span className="muted small">{new Date(t.last_message_at).toLocaleDateString()}</span></span>
              <strong>{t.subject || '(no subject)'}</strong>
              <span className="muted small clip">{t.snippet}</span>
            </button>
          ))}
        </section>

        <div className="today-col">
          <section className="panel" aria-label="Today and tomorrow">
            <header className="panel-head"><h3>Today and tomorrow</h3></header>
            {events.length === 0 && <p className="muted pad">No events today or tomorrow.</p>}
            {events.map((e) => (
              <div key={e.id} className="ev-row">
                <span className="ev-bar" aria-hidden="true" />
                <span><strong>{e.title}</strong><br /><span className="muted small">{dayLabel(e.start_at)} · {e.all_day ? 'All day' : `${time(e.start_at)} to ${time(e.end_at)}`}</span></span>
              </div>
            ))}
          </section>

          <section className="panel" aria-label="Open action items">
            <header className="panel-head"><h3>Open action items</h3></header>
            {items.length === 0 && <p className="muted pad">Nothing open. Action items found in your conversations appear here.</p>}
            {items.map((i) => (
              <label key={i.id} className="action-row">
                <input type="checkbox" onChange={async () => { await api(`/action-items/${i.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) }); load(); }} aria-label={`Mark done: ${i.text}`} />
                <span className="action-text">
                  <span>{i.text}</span>
                  <span className="muted small">
                    {i.due_at ? `Due ${new Date(i.due_at).toLocaleDateString()} · ` : ''}
                    <button type="button" className="link" onClick={() => onOpenThread(i.thread_id)}>{i.subject || 'Open conversation'}</button>
                  </span>
                </span>
              </label>
            ))}
          </section>
        </div>
      </div>

      <form className="card inline" onSubmit={saveSchedule} aria-label="Digest schedule">
        <label className="inline-check"><input type="checkbox" checked={sched.enabled} onChange={(e) => setSched({ ...sched, enabled: e.target.checked })} /> Send me a digest every day</label>
        <label>Hour (0–23)<input id="d-hour" type="number" min={0} max={23} value={sched.hour} onChange={(e) => setSched({ ...sched, hour: Number(e.target.value) })} /></label>
        <label>Time zone<input id="d-tz" value={sched.timezone} onChange={(e) => setSched({ ...sched, timezone: e.target.value })} /></label>
        <button>Save schedule</button>
      </form>
      {msg && <p role="status">{msg}</p>}
    </>
  );
}
