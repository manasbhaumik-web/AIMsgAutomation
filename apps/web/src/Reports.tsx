import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, apiDownload } from './api';

interface Report { id: string; title: string; kind: string; format: 'pdf' | 'docx' | 'xlsx'; size_bytes: number; created_at: string; expires_at: string }

const KINDS: { id: string; label: string; help: string }[] = [
  { id: 'weekly', label: 'Weekly summary', help: 'Inbox, action items and calendar in one document' },
  { id: 'inbox', label: 'Inbox report', help: 'Conversations, channels, priorities and unread counts' },
  { id: 'actions', label: 'Action items', help: 'Open, overdue and completed tasks' },
  { id: 'calendar', label: 'Calendar', help: 'Upcoming events and any overlaps' },
];
const FORMAT_LABEL = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel' } as const;
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** PDF, Word and Excel reports built from your own synced data. They hold subjects, senders, dates and counts, never message bodies. */
export function Reports() {
  const [items, setItems] = useState<Report[] | null>(null);
  const [kind, setKind] = useState('weekly');
  const [format, setFormat] = useState<'pdf' | 'docx' | 'xlsx'>('pdf');
  const [rangeDays, setRangeDays] = useState(7);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => { api<Report[]>('/reports').then(setItems).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ reportPrefs: { defaultFormat: 'pdf' | 'docx' | 'xlsx'; rangeDays: number } }>('/me/profile').then((p) => { setFormat(p.reportPrefs.defaultFormat); setRangeDays(p.reportPrefs.rangeDays); }).catch(() => undefined);
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api<Report>('/reports', { method: 'POST', body: JSON.stringify({ kind, format, rangeDays, title: title.trim() || undefined }) });
      setMsg(`Built “${r.title}”.`); setTitle(''); load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function download(r: Report) {
    setError('');
    try { await apiDownload(`/reports/${r.id}/download`, `${r.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'report'}.${r.format}`); } catch (err) { setError((err as Error).message); }
  }

  return (
    <section aria-label="Reports">
      <header className="page-head"><h2>Reports</h2><p className="muted">Build a PDF, Word or Excel file from your messages, tasks and calendar. Files are encrypted and deleted after 30 days.</p></header>
      <form className="card wide" onSubmit={create}>
        <div className="grid2">
          <label>What to include
            <select id="rp-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
            <span className="muted small">{KINDS.find((k) => k.id === kind)?.help}</span>
          </label>
          <label>Format
            <select id="rp-format" value={format} onChange={(e) => setFormat(e.target.value as 'pdf' | 'docx' | 'xlsx')}>{(Object.keys(FORMAT_LABEL) as (keyof typeof FORMAT_LABEL)[]).map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}</select>
          </label>
          <label>Days covered<input id="rp-days" type="number" min={1} max={90} value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))} /></label>
          <label>Title (optional)<input id="rp-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
        </div>
        <div className="row"><button className="primary" disabled={busy}>{busy ? 'Building…' : 'Build report'}</button></div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p role="status" className="ok">{msg}</p>}

      <h3>Your reports</h3>
      {items?.length === 0 && <div className="empty"><strong>No reports yet</strong><p className="muted">Build one above, or let a workflow build one on a schedule.</p></div>}
      {items && items.length > 0 && (
        <table>
          <thead><tr><th>Report</th><th>Type</th><th>Size</th><th>Built</th><th>Deleted on</th><th /></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.title}</strong></td><td>{FORMAT_LABEL[r.format]}</td><td>{size(r.size_bytes)}</td>
                <td>{new Date(r.created_at).toLocaleString()}</td><td>{new Date(r.expires_at).toLocaleDateString()}</td>
                <td className="row"><button onClick={() => download(r)}>Download</button><button className="danger" onClick={async () => { await api(`/reports/${r.id}`, { method: 'DELETE' }); load(); }}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
