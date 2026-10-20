import { useEffect, useState } from 'react';
import { api } from './api';
import { Account } from './Connections';

interface Ev { id: string; account_id: string; title: string; start_at: string; end_at: string; all_day: boolean; location: string | null; meeting_link: string | null; status: string; attendees: unknown[] }
type Rsvp = 'accept' | 'decline' | 'tentative';
const RSVP_LABEL: Record<Rsvp, string> = { accept: 'Accept', decline: 'Decline', tentative: 'Maybe' };

const dayKey = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const fmt = (s: string) => new Date(s).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Calendar() {
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{ ev: Ev; response: Rsvp } | null>(null);
  const [comment, setComment] = useState('');
  const [slots, setSlots] = useState<{ start: string; end: string }[] | null>(null);
  const [duration, setDuration] = useState(30);

  useEffect(() => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 2); // today and tomorrow
    api<{ events: Ev[] }>(`/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`).then((r) => setEvents(r.events)).catch((e) => setError(e.message));
    api<Account[]>('/accounts').then(setAccounts).catch(() => undefined);
  }, []);

  const canRespond = (e: Ev) => !!accounts.find((a) => a.id === e.account_id)?.can_respond && e.status !== 'cancelled' && e.attendees.length > 0 && new Date(e.end_at) > new Date();

  async function respond() {
    if (!pending) return;
    setError(''); setNotice('');
    try {
      await api(`/events/${pending.ev.id}/respond`, { method: 'POST', body: JSON.stringify({ confirm: true, response: pending.response, comment: comment || undefined }) });
      setNotice(`${RSVP_LABEL[pending.response]} sent for “${pending.ev.title}”. The organizer is notified.`);
      setPending(null); setComment('');
    } catch (e) { setError((e as Error).message); setPending(null); }
  }

  async function suggest() {
    setError('');
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setSlots((await api<{ slots: { start: string; end: string }[] }>('/calendar/suggest-times', { method: 'POST', body: JSON.stringify({ durationMin: duration, timezone }) })).slots);
    } catch (e) { setError((e as Error).message); }
  }

  const groups = new Map<string, Ev[]>();
  for (const e of events ?? []) { const k = dayKey(new Date(e.start_at)); groups.set(k, [...(groups.get(k) ?? []), e]); }

  return (
    <section>
      <h2>Today and tomorrow</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {events?.length === 0 && <p className="muted">No events. Connect Google Calendar or Microsoft Calendar under Accounts.</p>}
      {[...groups].map(([day, list]) => (
        <div key={day} className="stack">
          <h3>{day}</h3>
          {list.map((e) => (
            <article key={e.id} className="card wide">
              <div className="between"><strong>{e.title}</strong><span className="muted small">{e.all_day ? 'All day' : `${new Date(e.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(e.end_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span></div>
              {e.location && <div className="muted small">{e.location}</div>}
              {e.meeting_link && <a href={e.meeting_link} target="_blank" rel="noopener noreferrer">Join meeting</a>}
              {e.attendees.length > 0 && <div className="muted small">{e.attendees.length} attendee{e.attendees.length > 1 ? 's' : ''}</div>}
              {canRespond(e) && (
                <div className="row">
                  {(Object.keys(RSVP_LABEL) as Rsvp[]).map((r) => <button key={r} onClick={() => setPending({ ev: e, response: r })}>{RSVP_LABEL[r]}</button>)}
                </div>
              )}
              {pending?.ev.id === e.id && (
                <div className="confirm" role="alertdialog" aria-label="Confirm response">
                  <p><strong>{RSVP_LABEL[pending.response]} “{e.title}”?</strong> The organizer and other attendees may be told.</p>
                  <input aria-label="Optional note to the organizer" placeholder="Optional note" value={comment} maxLength={500} onChange={(ev) => setComment(ev.target.value)} />
                  <div className="row">
                    <button className="primary" onClick={respond}>Send response</button>
                    <button onClick={() => setPending(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      ))}

      <h3 style={{ marginTop: 24 }}>Find a time</h3>
      <p className="muted small">Free slots in your working hours (9–17, weekdays, your time zone) based on your own calendars. Nothing is sent or booked; copy a time into a reply.</p>
      <div className="row">
        <label>Length <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}</select></label>
        <button onClick={suggest}>Suggest times</button>
      </div>
      {slots?.length === 0 && <p className="muted">No free slot found in the next week.</p>}
      <ul className="plain-list">{slots?.map((s) => <li key={s.start}>{fmt(s.start)} – {new Date(s.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</li>)}</ul>
    </section>
  );
}
