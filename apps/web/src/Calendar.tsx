import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from './api';
import { Account } from './Connections';

interface Ev { id: string; account_id: string; title: string; start_at: string; end_at: string; all_day: boolean; location: string | null; meeting_link: string | null; status: string; attendees: unknown[] }
type Rsvp = 'accept' | 'decline' | 'tentative';
const RSVP_LABEL: Record<Rsvp, string> = { accept: 'Accept', decline: 'Decline', tentative: 'Maybe' };

const fmt = (s: string) => new Date(s).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const clock = (s: string) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** Monday of the week containing d, at local midnight. */
function weekStartOf(d: Date) {
  const s = new Date(d); s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

export function Calendar() {
  const [weekStart, setWeekStart] = useState(() => weekStartOf(new Date()));
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{ ev: Ev; response: Rsvp } | null>(null);
  const [comment, setComment] = useState('');
  const [slots, setSlots] = useState<{ start: string; end: string }[] | null>(null);
  const [duration, setDuration] = useState(30);

  const load = useCallback(() => {
    const to = new Date(weekStart); to.setDate(to.getDate() + 7);
    api<{ events: Ev[] }>(`/calendar/events?from=${weekStart.toISOString()}&to=${to.toISOString()}`).then((r) => setEvents(r.events)).catch((e) => setError(e.message));
  }, [weekStart]);
  useEffect(() => { setEvents(null); load(); }, [load]);
  useEffect(() => { api<Account[]>('/accounts').then(setAccounts).catch(() => undefined); }, []);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: '', start: '', end: '', location: '', attendees: '' });
  const [clashes, setClashes] = useState<{ id: string; title: string; start_at: string; end_at: string }[]>([]);
  const [moving, setMoving] = useState<{ start: string; end: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const iso = (local: string) => new Date(local).toISOString();
  const toLocal = (d: Date | string) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

  async function createEvent(e: FormEvent | null, acceptConflicts = false) {
    e?.preventDefault();
    setError(''); setNotice('');
    try {
      await api('/calendar/events', { method: 'POST', body: JSON.stringify({
        confirm: true, acceptConflicts, title: draft.title, start: iso(draft.start), end: iso(draft.end),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, location: draft.location || undefined,
        attendees: draft.attendees.split(/[,\s]+/).filter(Boolean),
      }) });
      setNotice('Added “' + draft.title + '” to your calendar.');
      setCreating(false); setClashes([]); setDraft({ title: '', start: '', end: '', location: '', attendees: '' }); load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'event_conflict') {
        const r = await api<{ conflicts: typeof clashes }>('/calendar/conflicts', { method: 'POST', body: JSON.stringify({ start: iso(draft.start), end: iso(draft.end) }) });
        setClashes(r.conflicts);
      } else setError((err as Error).message);
    }
  }

  async function reschedule(accept = false) {
    if (!sel || !moving) return;
    setError(''); setNotice('');
    try {
      await api('/calendar/events/' + sel.id, { method: 'PATCH', body: JSON.stringify({ confirm: true, acceptConflicts: accept, start: iso(moving.start), end: iso(moving.end) }) });
      setNotice('Moved “' + sel.title + '”.'); setMoving(null); load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'event_conflict') setError('The new time overlaps another event. Press “Move anyway” to keep it.');
      else setError((err as Error).message);
    }
  }

  async function cancelEvent() {
    if (!sel) return;
    setError(''); setNotice('');
    try {
      await api('/calendar/events/' + sel.id + '/cancel', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setNotice('Cancelled “' + sel.title + '”.'); setCancelling(false); setSelected(null); load();
    } catch (err) { setError((err as Error).message); }
  }

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; }), [weekStart]);
  const today = new Date();
  const sel = events?.find((e) => e.id === selected) ?? null;
  const canRespond = (e: Ev) => !!accounts.find((a) => a.id === e.account_id)?.can_respond && e.status !== 'cancelled' && e.attendees.length > 0 && new Date(e.end_at) > new Date();
  const shiftWeek = (n: number) => setWeekStart((w) => { const d = new Date(w); d.setDate(d.getDate() + 7 * n); return d; });
  const rangeTitle = `${days[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} to ${days[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;

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

  return (
    <section>
      <header className="page-head cal-head">
        <div>
          <h2>{rangeTitle}</h2>
          <p className="muted">Your connected calendars. Adding, moving or cancelling an event always asks you to confirm.</p>
        </div>
        <div className="row cal-nav">
          <button aria-label="Previous week" onClick={() => shiftWeek(-1)}>&lsaquo;</button>
          <button onClick={() => setWeekStart(weekStartOf(new Date()))}>This week</button>
          <button aria-label="Next week" onClick={() => shiftWeek(1)}>&rsaquo;</button>
          <button className="primary" onClick={() => { setCreating(!creating); setClashes([]); }}>{creating ? 'Close' : 'New event'}</button>
        </div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {creating && (
        <form className="card wide" onSubmit={(e) => createEvent(e)} aria-label="New event">
          <div className="grid2">
            <label>Title<input id="ev-title" required maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label>Where (optional)<input id="ev-where" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} /></label>
            <label>Starts<input id="ev-start" type="datetime-local" required value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value, end: draft.end || toLocal(new Date(new Date(e.target.value).getTime() + 30 * 60_000)) })} /></label>
            <label>Ends<input id="ev-end" type="datetime-local" required value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></label>
          </div>
          <label>Invite (emails, optional; your calendar will email them)<input id="ev-people" value={draft.attendees} onChange={(e) => setDraft({ ...draft, attendees: e.target.value })} /></label>
          {clashes.length > 0 && (
            <div className="warn" role="alert">
              <strong>This overlaps:</strong> {clashes.map((c) => c.title + ' (' + fmt(c.start_at) + ')').join('; ')}
              <div className="row"><button type="button" onClick={() => createEvent(null, true)}>Add it anyway</button></div>
            </div>
          )}
          <div className="row"><button className="primary">Add to calendar</button><span className="muted small">Needs a calendar connected with “Allow replies and responses”.</span></div>
        </form>
      )}
      {events?.length === 0 && <p className="muted">No events this week. Connect Google Calendar or Microsoft Calendar under Accounts.</p>}

      <div className="cal-layout">
        <div className="week" role="grid" aria-label="Week">
          {days.map((d) => {
            const list = (events ?? []).filter((e) => sameDay(new Date(e.start_at), d));
            return (
              <div key={d.toISOString()} className="week-col" role="gridcell">
                <div className="week-day">
                  <span className="muted small">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                  <span className={`week-num ${sameDay(d, today) ? 'today' : ''}`}>{d.getDate()}</span>
                </div>
                {list.map((e) => (
                  <button key={e.id} className={`ev ${selected === e.id ? 'selected' : ''}`} aria-pressed={selected === e.id} onClick={() => { setSelected(e.id); setPending(null); }}>
                    <span className="small">{e.all_day ? 'All day' : clock(e.start_at)}</span>
                    <strong>{e.title}</strong>
                  </button>
                ))}
              </div>
            );
          })}
        </div>

        <aside className="ev-detail" aria-label="Event details">
          <span className="eyebrow">Selected</span>
          {!sel && <p className="muted">Choose an event to see its details.</p>}
          {sel && (
            <>
              <h3>{sel.title}</h3>
              <dl className="facts">
                <dt>When</dt><dd>{sel.all_day ? 'All day' : `${fmt(sel.start_at)} to ${clock(sel.end_at)}`}</dd>
                {sel.location && <><dt>Where</dt><dd>{sel.location}</dd></>}
                <dt>People</dt><dd>{sel.attendees.length > 0 ? `${sel.attendees.length} attendee${sel.attendees.length > 1 ? 's' : ''}` : 'Just you'}</dd>
              </dl>
              {sel.meeting_link && <a href={sel.meeting_link} target="_blank" rel="noopener noreferrer">Join meeting</a>}
              <div className="row">
                <button onClick={() => { setMoving({ start: toLocal(sel.start_at), end: toLocal(sel.end_at) }); setCancelling(false); }}>Reschedule</button>
                <button className="danger" onClick={() => { setCancelling(true); setMoving(null); }}>Cancel event</button>
              </div>
              {moving && (
                <div className="confirm">
                  <label>New start<input type="datetime-local" value={moving.start} onChange={(e) => setMoving({ ...moving, start: e.target.value })} /></label>
                  <label>New end<input type="datetime-local" value={moving.end} onChange={(e) => setMoving({ ...moving, end: e.target.value })} /></label>
                  <div className="row"><button className="primary" onClick={() => reschedule(false)}>Move</button><button onClick={() => reschedule(true)}>Move anyway</button><button onClick={() => setMoving(null)}>Close</button></div>
                </div>
              )}
              {cancelling && (
                <div className="confirm" role="alertdialog" aria-label="Confirm cancellation">
                  <p><strong>Cancel “{sel.title}”?</strong> Other attendees may be told by your calendar.</p>
                  <div className="row"><button className="danger" onClick={cancelEvent}>Cancel the event</button><button onClick={() => setCancelling(false)}>Keep it</button></div>
                </div>
              )}
              {canRespond(sel) ? (
                <div className="row">
                  {(Object.keys(RSVP_LABEL) as Rsvp[]).map((r) => <button key={r} onClick={() => setPending({ ev: sel, response: r })}>{RSVP_LABEL[r]}</button>)}
                </div>
              ) : <p className="muted small">Responses are off for this event. You can allow them under Accounts; you always confirm before one is sent.</p>}
              {pending?.ev.id === sel.id && (
                <div className="confirm" role="alertdialog" aria-label="Confirm response">
                  <p><strong>{RSVP_LABEL[pending.response]} “{sel.title}”?</strong> The organizer and other attendees may be told.</p>
                  <input aria-label="Optional note to the organizer" placeholder="Optional note" value={comment} maxLength={500} onChange={(ev) => setComment(ev.target.value)} />
                  <div className="row">
                    <button className="primary" onClick={respond}>Send response</button>
                    <button onClick={() => setPending(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      <h3 className="find-time">Find a time</h3>
      <p className="muted small">Free slots in your working hours (9–17, weekdays, your time zone) based on your own calendars. Nothing is sent or booked; copy a time into a reply.</p>
      <div className="row">
        <label>Length <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}</select></label>
        <button onClick={suggest}>Suggest times</button>
      </div>
      {slots?.length === 0 && <p className="muted">No free slot found in the next week.</p>}
      <ul className="plain-list">{slots?.map((s) => <li key={s.start}>{fmt(s.start)} – {clock(s.end)}</li>)}</ul>
    </section>
  );
}
