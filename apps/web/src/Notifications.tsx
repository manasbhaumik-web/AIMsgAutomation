import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { CHANNEL_LABEL } from './Connections';

interface Item { id: number; channel: string | null; priority: string | null; created_at: string; read_at: string | null; thread_id: string | null; subject: string | null }
interface Feed { unread: number; items: Item[] }
interface Prefs { minPriority: 'off' | 'urgent' | 'needs_reply' | 'all'; showPreview: boolean; quietStart: number | null; quietEnd: number | null; timezone: string }
interface Device { id: string; label: string | null; created_at: string; last_ok_at: string | null }

export function NotificationsBell({ onOpenThread }: { onOpenThread: (id: string) => void }) {
  const [feed, setFeed] = useState<Feed>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { api<Feed>('/notifications').then(setFeed).catch(() => undefined); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  return (
    <div className="bell">
      <button aria-expanded={open} aria-label={`Notifications, ${feed.unread} unread`} onClick={() => { setOpen(!open); load(); }}>
        Notifications {feed.unread > 0 && <span className="badge">{feed.unread}</span>}
      </button>
      {open && (
        <div className="card wide bell-panel" role="region" aria-label="Notifications">
          {feed.items.length === 0 && <p className="muted">Nothing yet.</p>}
          <ul className="plain-list">
            {feed.items.slice(0, 15).map((n) => (
              <li key={n.id}>
                <button className={`row-item ${n.read_at ? '' : 'unread'}`} disabled={!n.thread_id} onClick={async () => { await api('/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [n.id] }) }); setOpen(false); load(); if (n.thread_id) onOpenThread(n.thread_id); }}>
                  <span className="between"><strong>{n.priority === 'urgent' ? 'Urgent' : n.priority === 'needs_reply' ? 'Needs reply' : 'New message'} · {CHANNEL_LABEL[n.channel ?? ''] ?? n.channel}</strong><time className="muted small">{new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></span>
                  <span className="clip">{n.subject || '(no subject)'}</span>
                </button>
              </li>
            ))}
          </ul>
          {feed.unread > 0 && <button onClick={async () => { await api('/notifications/read', { method: 'POST', body: JSON.stringify({ all: true }) }); load(); }}>Mark all read</button>}
        </div>
      )}
    </div>
  );
}

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pushAvailable, setPushAvailable] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<{ prefs: Prefs; devices: Device[]; pushAvailable: boolean }>('/notifications/settings').then((r) => { setPrefs(r.prefs); setDevices(r.devices); setPushAvailable(r.pushAvailable); }).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  if (!prefs) return error ? <p className="error" role="alert">{error}</p> : null;

  const quiet = prefs.quietStart !== null && prefs.quietEnd !== null;
  async function save(next: Prefs) {
    setPrefs(next); setSaved(''); setError('');
    try { await api('/notifications/settings', { method: 'PUT', body: JSON.stringify(next) }); setSaved('Saved'); } catch (e) { setError((e as Error).message); }
  }

  return (
    <section className="card wide" aria-label="Notification settings">
      <h3>Notifications</h3>
      {error && <p className="error" role="alert">{error}</p>}
      <label>Tell me about
        <select value={prefs.minPriority} onChange={(e) => save({ ...prefs, minPriority: e.target.value as Prefs['minPriority'] })}>
          <option value="off">Nothing</option>
          <option value="urgent">Urgent messages</option>
          <option value="needs_reply">Messages that need a reply (needs AI features)</option>
          <option value="all">Every new message</option>
        </select>
      </label>
      <label className="inline-check"><input type="checkbox" checked={prefs.showPreview} onChange={(e) => save({ ...prefs, showPreview: e.target.checked })} /> Show the sender and subject on my phone’s lock screen</label>
      <p className="muted small">Off by default: phone notifications then say only that something needs you, because they pass through your phone maker’s servers.</p>
      <label className="inline-check"><input type="checkbox" checked={quiet} onChange={(e) => save({ ...prefs, quietStart: e.target.checked ? 22 : null, quietEnd: e.target.checked ? 7 : null })} /> Quiet hours (no phone alerts)</label>
      {quiet && (
        <div className="row">
          <label>From <input type="number" min={0} max={23} value={prefs.quietStart ?? 22} onChange={(e) => save({ ...prefs, quietStart: Number(e.target.value) })} /></label>
          <label>Until <input type="number" min={0} max={23} value={prefs.quietEnd ?? 7} onChange={(e) => save({ ...prefs, quietEnd: Number(e.target.value) })} /></label>
          <label>Time zone <input value={prefs.timezone} onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value })} onBlur={() => save(prefs)} /></label>
        </div>
      )}
      {saved && <span role="status" className="muted small">{saved}</span>}
      <h4>Phones</h4>
      {!pushAvailable && <p className="muted small">Phone alerts are not set up on this server. Notifications still appear here.</p>}
      {devices.length === 0 && pushAvailable && <p className="muted small">No phone registered yet. The mobile app registers itself after you sign in.</p>}
      <ul className="plain-list">
        {devices.map((d) => (
          <li key={d.id} className="row between"><span>{d.label ?? 'Phone'} <span className="muted small">added {new Date(d.created_at).toLocaleDateString()}</span></span>
            <button onClick={async () => { await api(`/notifications/devices/${d.id}`, { method: 'DELETE' }); load(); }}>Remove</button></li>
        ))}
      </ul>
    </section>
  );
}
