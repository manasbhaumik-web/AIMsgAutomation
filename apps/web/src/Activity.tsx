import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

interface Entry { id: number; actor: 'user' | 'workflow' | 'system'; kind: string; summary: string; at: string }

const GROUPS: { id: string; label: string }[] = [
  { id: '', label: 'Everything' },
  { id: 'workflow', label: 'Workflows' },
  { id: 'approval', label: 'Approvals' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'report', label: 'Reports' },
  { id: 'reply', label: 'Replies' },
];
const ACTOR: Record<Entry['actor'], string> = { user: 'You', workflow: 'Workflow', system: 'System' };

/** The record of everything done for you. Short sentences only: message text and file contents are never written here. */
export function Activity() {
  const [items, setItems] = useState<Entry[] | null>(null);
  const [kind, setKind] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<Entry[]>(`/activity?limit=50${kind ? `&kind=${kind}` : ''}`).then((r) => { setItems(r); setMore(r.length === 50); }).catch((e) => setError(e.message));
  }, [kind]);
  useEffect(load, [load]);

  async function older() {
    if (!items?.length) return;
    const r = await api<Entry[]>(`/activity?limit=50&before=${items[items.length - 1].id}${kind ? `&kind=${kind}` : ''}`);
    setItems([...items, ...r]); setMore(r.length === 50);
  }

  return (
    <section aria-label="Activity">
      <header className="page-head"><h2>Activity</h2><p className="muted">A plain record of drafts, sends, approvals, calendar changes and reports made for you.</p></header>
      <div className="row tabs">{GROUPS.map((g) => <button key={g.id} className={kind === g.id ? 'active' : ''} onClick={() => setKind(g.id)}>{g.label}</button>)}</div>
      {error && <p className="error" role="alert">{error}</p>}
      {items?.length === 0 && <div className="empty"><strong>Nothing yet</strong><p className="muted">Actions taken for you appear here.</p></div>}
      <ol className="timeline">
        {items?.map((e) => (
          <li key={e.id}>
            <span className={`dot ${e.actor}`} aria-hidden="true" />
            <div><span>{e.summary}</span><div className="muted small">{ACTOR[e.actor]} · {new Date(e.at).toLocaleString()}</div></div>
          </li>
        ))}
      </ol>
      {more && <button onClick={older}>Show older</button>}
    </section>
  );
}
