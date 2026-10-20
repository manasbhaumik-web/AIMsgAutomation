import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { ConsentGate } from './AiConsent';

interface Digest { digest_date: string; text: string; model: string | null; created_at: string }
interface Item { id: string; text: string; due_at: string | null; thread_id: string; subject: string | null }
interface Settings { digest: { enabled: boolean; hour: number; timezone: string } }

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

export function Today({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  return (
    <section>
      <h2>Today</h2>
      <ConsentGate><Body onOpenThread={onOpenThread} /></ConsentGate>
    </section>
  );
}

function Body({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const [digest, setDigest] = useState<Digest | null | undefined>(undefined);
  const [items, setItems] = useState<Item[]>([]);
  const [sched, setSched] = useState<Settings['digest']>({ enabled: false, hour: 8, timezone: browserTz() });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api<Digest | null>('/digests/latest').then((d) => setDigest(d ?? null)).catch((e) => setMsg(e.message));
    api<Item[]>('/action-items').then(setItems).catch(() => undefined);
    api<Settings>('/me/ai').then((s) => setSched((p) => ({ ...p, ...s.digest, timezone: s.digest.timezone === 'UTC' && !s.digest.enabled ? browserTz() : s.digest.timezone }))).catch(() => undefined);
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
      <article className="card wide">
        <div className="between"><strong>Daily digest</strong>{digest && <span className="muted small">{digest.digest_date}</span>}</div>
        {digest === undefined && <p className="muted">Loading&hellip;</p>}
        {digest === null && <p className="muted">No digest yet. Generate one now, or set a daily time below.</p>}
        {digest && <div className="digest">{digest.text}</div>}
        <div className="row"><button className="primary" disabled={busy} onClick={generate}>{busy ? 'Writing…' : digest ? 'Refresh digest' : 'Generate digest'}</button></div>
      </article>

      <form className="card inline" onSubmit={saveSchedule} aria-label="Digest schedule">
        <label className="inline-check"><input type="checkbox" checked={sched.enabled} onChange={(e) => setSched({ ...sched, enabled: e.target.checked })} /> Send me a digest every day</label>
        <label>Hour (0–23)<input id="d-hour" type="number" min={0} max={23} value={sched.hour} onChange={(e) => setSched({ ...sched, hour: Number(e.target.value) })} /></label>
        <label>Time zone<input id="d-tz" value={sched.timezone} onChange={(e) => setSched({ ...sched, timezone: e.target.value })} /></label>
        <button>Save schedule</button>
      </form>
      {msg && <p role="status">{msg}</p>}

      <h3>Open action items</h3>
      {items.length === 0 && <p className="muted">Nothing open. Action items found in your conversations appear here.</p>}
      <div className="stack">
        {items.map((i) => (
          <label key={i.id} className="card wide item">
            <span className="inline-check">
              <input type="checkbox" onChange={async () => { await api(`/action-items/${i.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) }); load(); }} aria-label={`Mark done: ${i.text}`} />
              <span>{i.text}</span>
            </span>
            <span className="muted small">
              {i.due_at ? `Due ${new Date(i.due_at).toLocaleDateString()} · ` : ''}
              <button type="button" className="link" onClick={() => onOpenThread(i.thread_id)}>{i.subject || 'Open conversation'}</button>
            </span>
          </label>
        ))}
      </div>
    </>
  );
}
