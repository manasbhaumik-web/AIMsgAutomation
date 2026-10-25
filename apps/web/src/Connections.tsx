import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export interface Account {
  id: string; channel: string; external_id: string; display_name: string | null; status: string;
  last_sync_at: string | null; last_error: string | null; ai_enabled: boolean; backfill_days: number; unread: number;
  can_send: boolean; can_respond: boolean;
}
interface ChannelInfo { id: string; displayName: string; notice: string | null }

export const CHANNEL_LABEL: Record<string, string> = { gmail: 'Gmail', google_calendar: 'Google Calendar', outlook: 'Outlook', microsoft_calendar: 'Microsoft Calendar', slack: 'Slack', teams: 'Microsoft Teams', whatsapp: 'WhatsApp Business', linkedin: 'LinkedIn' };
const STATUS_TEXT: Record<string, string> = { active: 'Syncing', paused: 'Paused', reauth: 'Reconnect needed', error: 'Error', revoked: 'Disconnected' };

export function Connections() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [write, setWrite] = useState(false);

  const load = useCallback(() => {
    api<Account[]>('/accounts').then(setAccounts).catch((e) => setError(e.message));
    api<ChannelInfo[]>('/accounts/channels').then(setChannels).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function connect(channel: string, allowWrite = write) {
    setError('');
    try {
      const r = await api<{ url: string }>(`/accounts/${channel}/connect`, { method: 'POST', body: JSON.stringify({ redirectUri: `${location.origin}/connect/callback`, write: allowWrite }) });
      location.href = r.url;
    } catch (e) { setError((e as Error).message); }
  }

  async function patch(id: string, body: object) {
    try { await api(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); load(); } catch (e) { setError((e as Error).message); }
  }

  async function remove(id: string, deleteData: boolean) {
    try { await api(`/accounts/${id}?deleteData=${deleteData}`, { method: 'DELETE' }); setConfirmDelete(null); load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <section>
      <header className="page-head">
        <h2>Connected accounts</h2>
        <p className="muted">Each account is read-only for now. We never send or change anything in your mailbox or calendar.</p>
      </header>
      {error && <p className="error" role="alert">{error}</p>}

      {channels.length === 0 && <p className="notice">No channels are configured on this server. Add provider credentials to .env (see apps/api/src/connectors/README.md).</p>}
      <div className="channel-grid">
        {channels.map((c) => (
          <div key={c.id} className="channel-card">
            <div className="channel-top">
              <span className="avatar" aria-hidden="true">{c.displayName.slice(0, 1).toUpperCase()}</span>
              <strong>{c.displayName}</strong>
            </div>
            <button className="primary" onClick={() => connect(c.id)}>Connect {c.displayName}</button>
            {c.notice && <span className="muted small">{c.notice}</span>}
          </div>
        ))}
      </div>
      <label className="inline-check">
        <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Also allow replies and calendar responses when I connect
      </label>
      <p className="muted small">Off by default, so providers ask only for read access. Nothing is ever sent without your confirmation, even when this is on.</p>

      <div className="stack">
        {accounts?.length === 0 && <p className="muted">Nothing connected yet. Pick a channel above to start. The last 14 days are imported first.</p>}
        {accounts?.map((a) => (
          <article key={a.id} className="card wide">
            <div className="row between">
              <div>
                <strong>{CHANNEL_LABEL[a.channel] ?? a.channel}</strong>
                <div className="muted">{a.external_id}</div>
              </div>
              <span className={`pill ${a.status}`}>{STATUS_TEXT[a.status] ?? a.status}</span>
            </div>
            <div className="muted small">
              {a.last_sync_at ? `Last synced ${new Date(a.last_sync_at).toLocaleString()}` : 'Not synced yet'}
              {a.last_error && a.status !== 'reauth' && <> · {a.last_error}</>}
            </div>
            <div className="row">
              {a.status === 'reauth' && <button className="primary" onClick={() => connect(a.channel)}>Reconnect</button>}
              {a.status !== 'reauth' && a.status !== 'revoked' && (a.can_send || a.can_respond) && <span className="pill active">Replies allowed</span>}
              {a.status === 'active' && !a.can_send && !a.can_respond && ['gmail', 'outlook', 'slack', 'teams', 'google_calendar', 'microsoft_calendar'].includes(a.channel) && (
                <button onClick={() => connect(a.channel, true)}>Allow replies…</button>
              )}
              {a.status === 'active' && <button onClick={() => patch(a.id, { paused: true })}>Pause sync</button>}
              {a.status === 'paused' && <button onClick={() => patch(a.id, { paused: false })}>Resume</button>}
              <label className="inline-check">
                <input type="checkbox" checked={a.ai_enabled} onChange={(e) => patch(a.id, { aiEnabled: e.target.checked })} /> Allow AI features
              </label>
              {a.status !== 'revoked' && <button onClick={() => setConfirmDelete(a.id)}>Disconnect</button>}
            </div>
            {confirmDelete === a.id && (
              <div className="confirm" role="alertdialog" aria-label="Confirm disconnect">
                <p>Disconnect {a.external_id}? Access is revoked at the provider where supported.</p>
                <div className="row">
                  <button className="danger" onClick={() => remove(a.id, true)}>Disconnect and delete imported data</button>
                  <button onClick={() => remove(a.id, false)}>Disconnect, keep imported data</button>
                  <button onClick={() => setConfirmDelete(null)}>Cancel</button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
