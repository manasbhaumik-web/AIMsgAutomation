import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api';

interface Draft { id: string; body: string; channel: string; to: { name?: string; email?: string; handle?: string }[]; subject: string | null; canSend: boolean; blockedReason: string | null; stale: boolean; accountLabel: string }
interface EventPayload { title: string; start: string; end: string; timezone?: string; location?: string | null; attendees?: string[] }
export interface ApprovalRow { id: string; kind: 'send_reply' | 'create_event'; summary: string; status: string; error: string | null; expires_at: string; created_at: string; workflow_name: string | null; payload: Record<string, unknown>; payload_hash: string }
interface View { id: string; kind: string; payload: Record<string, unknown>; payloadHash: string; status: string; error: string | null; draft: Draft | null }
interface Clash { id: string; title: string; start_at: string; end_at: string }

const ev0 = (a: ApprovalRow) => a.payload as unknown as EventPayload;
const when = (s: string, tz?: string) => new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
const who = (p: { name?: string; email?: string; handle?: string }) => p.name ? `${p.name}${p.email ? ` <${p.email}>` : ''}` : p.email ?? p.handle ?? 'Unknown';

/** Everything a workflow wants to do that needs a person: review exactly what will happen, then approve or decline. */
export function Approvals({ onChange }: { onChange?: (pending: number) => void }) {
  const [items, setItems] = useState<ApprovalRow[] | null>(null);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    api<ApprovalRow[]>('/approvals').then((r) => { setItems(r); onChange?.(r.filter((a) => a.status === 'pending').length); }).catch((e) => setError(e.message));
  }, [onChange]);
  useEffect(load, [load]);

  const pending = items?.filter((a) => a.status === 'pending') ?? [];
  const past = items?.filter((a) => a.status !== 'pending') ?? [];

  return (
    <section aria-label="Approvals">
      <header className="page-head"><h2>Approvals</h2><p className="muted">Nothing here has happened yet. Review exactly what would be sent or added to your calendar, then approve or decline.</p></header>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {items && pending.length === 0 && <div className="empty"><strong>Nothing waiting for you</strong><p className="muted">When a workflow wants to send a reply or add an event, it appears here first.</p></div>}
      <div className="stack">
        {pending.map((a) => <ApprovalCard key={a.id} a={a} onDone={(m) => { setNotice(m); load(); }} />)}
      </div>
      {past.length > 0 && (
        <>
          <button className="link" onClick={() => setHistory(!history)}>{history ? 'Hide' : 'Show'} earlier requests ({past.length})</button>
          {history && (
            <ul className="plain-list history">
              {past.map((a) => (
                <li key={a.id}>
                  <span className={`pill ${a.status === 'executed' ? 'active' : a.status === 'failed' ? 'error' : ''}`}>{a.status === 'executed' ? 'approved' : a.status}</span>{' '}
                  {a.summary} <span className="muted small">· {when(a.created_at)}{a.error ? ` · ${a.error}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function ApprovalCard({ a, onDone }: { a: ApprovalRow; onDone: (message: string) => void }) {
  const [view, setView] = useState<View | null>(null);
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [acceptNew, setAcceptNew] = useState(false);
  const [acceptClash, setAcceptClash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<View>(`/approvals/${a.id}`).then(setView).catch((e) => setError(e.message));
    if (a.kind === 'create_event') {
      api<{ conflicts: Clash[] }>('/calendar/conflicts', { method: 'POST', body: JSON.stringify({ start: ev0(a).start, end: ev0(a).end }) }).then((r) => setClashes(r.conflicts)).catch(() => undefined);
    }
  }, [a]);

  async function decide(approve: boolean) {
    setBusy(true); setError('');
    try {
      if (approve) {
        await api(`/approvals/${a.id}/approve`, { method: 'POST', body: JSON.stringify({ payloadHash: a.payload_hash, acceptNewMessages: acceptNew, acceptConflicts: acceptClash }) });
        onDone(a.kind === 'send_reply' ? 'Approved: the reply was sent.' : 'Approved: the event was added to your calendar.');
      } else {
        await api(`/approvals/${a.id}/reject`, { method: 'POST' });
        onDone('Declined. Nothing was sent or changed.');
      }
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      setError(code === 'thread_changed' ? 'A newer message arrived in this conversation. Read it, tick the box below, then approve again.' : code === 'event_conflict' ? 'This overlaps another event. Tick the box below to add it anyway.' : (e as Error).message);
      if (code === 'thread_changed') setAcceptNew(false);
    } finally { setBusy(false); }
  }

  const d = view?.draft;
  const ev = a.payload as unknown as EventPayload; // only read when kind is create_event
  const tz = ev.timezone;
  return (
    <article className="card wide approval">
      <div className="between">
        <div><span className="chip needs_reply">{a.kind === 'send_reply' ? 'Send a reply' : 'Add to calendar'}</span> <span className="muted small">from {a.workflow_name ?? 'a workflow'} · expires {when(a.expires_at)}</span></div>
      </div>
      <strong>{a.summary}</strong>

      {a.kind === 'send_reply' && d && (
        <div className="review">
          <dl className="facts">
            <dt>To</dt><dd>{d.to.map(who).join(', ') || 'Unknown'}</dd>
            <dt>Channel</dt><dd>{d.channel} · {d.accountLabel}</dd>
            {d.subject && <><dt>Subject</dt><dd>{d.subject}</dd></>}
          </dl>
          <pre className="plain draft-text" aria-label="The exact reply that will be sent">{d.body}</pre>
          {!d.canSend && <p className="error">This cannot be sent right now: {d.blockedReason}</p>}
          {d.stale && (
            <label className="inline-check"><input type="checkbox" checked={acceptNew} onChange={(e) => setAcceptNew(e.target.checked)} />A newer message arrived since this was written. I have read it and still want to send.</label>
          )}
        </div>
      )}
      {a.kind === 'send_reply' && view && !d && <p className="error">The draft is no longer available, so this cannot be approved.</p>}

      {a.kind === 'create_event' && (
        <div className="review">
          <dl className="facts">
            <dt>Title</dt><dd>{ev.title}</dd>
            <dt>When</dt><dd>{when(ev.start, tz)} to {new Date(ev.end).toLocaleTimeString([], { timeStyle: 'short', timeZone: tz })}{tz ? ` (${tz})` : ''}</dd>
            {ev.location && <><dt>Where</dt><dd>{ev.location}</dd></>}
            {ev.attendees && ev.attendees.length > 0 && <><dt>Invites</dt><dd>{ev.attendees.join(', ')} (they will be emailed by your calendar)</dd></>}
          </dl>
          {clashes.length > 0 && (
            <div className="warn" role="alert">
              <strong>Overlaps {clashes.length === 1 ? 'an existing event' : `${clashes.length} existing events`}:</strong> {clashes.map((c) => `${c.title} (${when(c.start_at, tz)})`).join('; ')}
              <label className="inline-check"><input type="checkbox" checked={acceptClash} onChange={(e) => setAcceptClash(e.target.checked)} />Add it anyway</label>
            </div>
          )}
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="primary" disabled={busy || (a.kind === 'send_reply' && (!d || !d.canSend || (d.stale && !acceptNew))) || (a.kind === 'create_event' && clashes.length > 0 && !acceptClash)} onClick={() => decide(true)}>
          {busy ? 'Working…' : a.kind === 'send_reply' ? 'Approve and send' : 'Approve and add'}
        </button>
        <button disabled={busy} onClick={() => decide(false)}>Decline</button>
      </div>
    </article>
  );
}
