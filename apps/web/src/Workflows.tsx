import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from './api';

type Autonomy = 'suggest' | 'ask' | 'auto';
type Channel = 'gmail' | 'outlook' | 'slack' | 'teams' | 'whatsapp';
const CHANNELS: Channel[] = ['gmail', 'outlook', 'slack', 'teams', 'whatsapp'];
interface Cond { field: 'channel' | 'sender' | 'subject' | 'body' | 'priority' | 'topic'; op: 'is' | 'contains'; value: string }
interface Workflow {
  id: string; name: string; description: string | null; enabled: boolean; autonomy: Autonomy;
  trigger: { type: 'message_received' | 'schedule' | 'manual'; every?: 'day' | 'week'; hour?: number; weekday?: number; timezone?: string };
  conditions: Cond[]; actions: WorkflowAction[];
  policy: { dailyCap: number; allowedChannels: Channel[]; blockPriorities: string[]; onlyInWorkingHours: boolean; allowedSenderDomains: string[] };
  last_run_at: string | null;
}
interface WorkflowAction { type: string; instructions?: string; title?: string; startInHours?: number; durationMin?: number; attendees?: string[]; kind?: Form['reportKind']; format?: Form['reportFormat']; rangeDays?: number }
interface Step { action: string; status: 'ok' | 'skipped' | 'waiting' | 'failed'; message: string }
interface Run { id: string; status: string; manual: boolean; steps: Step[]; error: string | null; started_at: string }
interface ThreadRow { id: string; subject: string | null; channel: string; last_sender: { name?: string; email?: string } | null }

interface Form {
  name: string; description: string; enabled: boolean; autonomy: Autonomy;
  trigger: 'message_received' | 'schedule' | 'manual'; every: 'day' | 'week'; hour: number; weekday: number; timezone: string;
  conditions: Cond[];
  draft: boolean; draftInstructions: string; send: boolean;
  event: boolean; eventTitle: string; eventStartIn: number; eventDuration: number; eventAttendees: string;
  report: boolean; reportKind: 'inbox' | 'actions' | 'calendar' | 'weekly'; reportFormat: 'pdf' | 'docx' | 'xlsx'; reportRange: number;
  channels: Channel[]; dailyCap: number; blockUrgent: boolean; onlyWorkingHours: boolean; domains: string;
}

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };
const blank = (): Form => ({
  name: '', description: '', enabled: false, autonomy: 'ask', trigger: 'message_received', every: 'day', hour: 8, weekday: 1, timezone: tz(), conditions: [],
  draft: true, draftInstructions: '', send: true, event: false, eventTitle: 'Follow up: {{subject}}', eventStartIn: 24, eventDuration: 30, eventAttendees: '',
  report: false, reportKind: 'weekly', reportFormat: 'pdf', reportRange: 7, channels: [], dailyCap: 5, blockUrgent: true, onlyWorkingHours: true, domains: '',
});

const PRESETS: { label: string; help: string; make: () => Partial<Form> }[] = [
  { label: 'Reply to clients, ask me first', help: 'Writes a draft for each new message and waits for your approval.', make: () => ({ name: 'Reply to clients', autonomy: 'ask', trigger: 'message_received', draft: true, send: true }) },
  { label: 'Draft replies to urgent mail', help: 'Only leaves a draft in the conversation. Nothing is queued or sent.', make: () => ({ name: 'Draft urgent replies', autonomy: 'suggest', trigger: 'message_received', conditions: [{ field: 'priority', op: 'is', value: 'urgent' }], draft: true, send: false }) },
  { label: 'Weekly summary report', help: 'Builds a PDF every Monday morning.', make: () => ({ name: 'Weekly summary', trigger: 'schedule', every: 'week', weekday: 1, hour: 8, draft: false, send: false, report: true, reportKind: 'weekly', reportFormat: 'pdf', reportRange: 7 }) },
  { label: 'Follow-up event from a message', help: 'Proposes a calendar event; you approve it first.', make: () => ({ name: 'Follow-up event', trigger: 'manual', draft: false, send: false, event: true }) },
];

function toBody(f: Form) {
  const message = f.trigger !== 'schedule';
  const actions: Record<string, unknown>[] = [];
  if (message && f.draft) actions.push({ type: 'draft_reply', ...(f.draftInstructions.trim() ? { instructions: f.draftInstructions.trim() } : {}) });
  if (message && f.send) actions.push({ type: 'send_reply' });
  if (f.event) actions.push({ type: 'create_event', title: f.eventTitle, startInHours: f.eventStartIn, durationMin: f.eventDuration, attendees: f.eventAttendees.split(/[,\s]+/).filter(Boolean) });
  if (f.report) actions.push({ type: 'generate_report', kind: f.reportKind, format: f.reportFormat, rangeDays: f.reportRange });
  return {
    name: f.name.trim(), description: f.description.trim() || null, enabled: f.enabled, autonomy: f.autonomy,
    trigger: f.trigger === 'schedule' ? { type: 'schedule', every: f.every, hour: f.hour, ...(f.every === 'week' ? { weekday: f.weekday } : {}), timezone: f.timezone } : { type: f.trigger },
    conditions: f.trigger === 'message_received' ? f.conditions.filter((c) => c.value.trim()) : [],
    actions,
    policy: { dailyCap: f.dailyCap, allowedChannels: f.channels, blockPriorities: f.blockUrgent ? ['urgent'] : [], onlyInWorkingHours: f.onlyWorkingHours, allowedSenderDomains: f.domains.split(/[,\s]+/).filter(Boolean) },
  };
}

function fromWorkflow(w: Workflow): Form {
  const a = (t: string) => w.actions.find((x) => x.type === t);
  const ev = a('create_event'), rp = a('generate_report'), dr = a('draft_reply');
  return {
    ...blank(), name: w.name, description: w.description ?? '', enabled: w.enabled, autonomy: w.autonomy, trigger: w.trigger.type,
    every: w.trigger.every ?? 'day', hour: w.trigger.hour ?? 8, weekday: w.trigger.weekday ?? 1, timezone: w.trigger.timezone ?? tz(), conditions: w.conditions,
    draft: !!dr, draftInstructions: dr?.instructions ?? '', send: !!a('send_reply'),
    event: !!ev, eventTitle: ev?.title ?? 'Follow up: {{subject}}', eventStartIn: ev?.startInHours ?? 24, eventDuration: ev?.durationMin ?? 30, eventAttendees: (ev?.attendees ?? []).join(', '),
    report: !!rp, reportKind: rp?.kind ?? 'weekly', reportFormat: rp?.format ?? 'pdf', reportRange: rp?.rangeDays ?? 7,
    channels: w.policy.allowedChannels, dailyCap: w.policy.dailyCap, blockUrgent: w.policy.blockPriorities.includes('urgent'), onlyWorkingHours: w.policy.onlyInWorkingHours, domains: w.policy.allowedSenderDomains.join(', '),
  };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const triggerText = (t: Workflow['trigger']) => t.type === 'message_received' ? 'When a new message arrives' : t.type === 'manual' ? 'When you press Run now' : `${t.every === 'week' ? `Every ${WEEKDAYS[t.weekday ?? 1]}` : 'Every day'} at ${String(t.hour ?? 0).padStart(2, '0')}:00 (${t.timezone})`;
const actionText = (a: Workflow['actions'][number]) => a.type === 'draft_reply' ? 'write a draft' : a.type === 'send_reply' ? 'send it' : a.type === 'create_event' ? `propose the event “${a.title}”` : `build a ${String(a.format).toUpperCase()} ${a.kind} report`;
const AUTONOMY: Record<Autonomy, { label: string; help: string }> = {
  suggest: { label: 'Suggest only', help: 'Writes the draft and stops. You send it yourself.' },
  ask: { label: 'Ask me first', help: 'Everything waits in your approvals. You see the exact text before anything is sent.' },
  auto: { label: 'Send automatically within limits', help: 'Sends by itself only when every limit below is met; anything else goes to your approvals.' },
};
const STATUS_PILL: Record<string, string> = { done: 'active', waiting_approval: '', failed: 'error', running: '' };
const STATUS_TEXT: Record<string, string> = { done: 'Done', waiting_approval: 'Waiting for approval', failed: 'Stopped', running: 'Running' };

export function Workflows({ onGoApprovals }: { onGoApprovals?: () => void }) {
  const [items, setItems] = useState<Workflow[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => { api<Workflow[]>('/workflows').then(setItems).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);

  async function toggle(w: Workflow) {
    setError('');
    try { await api(`/workflows/${w.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: !w.enabled }) }); load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <section aria-label="Workflows">
      <header className="page-head"><h2>Workflows</h2><p className="muted">Rules that act on your messages and schedule. A new workflow is switched off, asks before sending, and only looks at mail that arrives after you turn it on.</p></header>
      <DemoPanel onChange={load} />
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p role="status" className="notice">{msg}</p>}

      {editing ? (
        <Builder initial={editing.form} id={editing.id} onCancel={() => setEditing(null)} onSaved={(m) => { setEditing(null); setMsg(m); load(); }} />
      ) : (
        <>
          <div className="row"><button className="primary" onClick={() => setEditing({ id: null, form: blank() })}>New workflow</button></div>
          {items?.length === 0 && (
            <div className="empty"><strong>No workflows yet</strong><p className="muted">Start from a template below, or build your own.</p></div>
          )}
          {items?.length === 0 && (
            <div className="preset-grid">
              {PRESETS.map((p) => (
                <button key={p.label} className="preset" onClick={() => setEditing({ id: null, form: { ...blank(), ...p.make() } })}><strong>{p.label}</strong><span className="muted small">{p.help}</span></button>
              ))}
            </div>
          )}
          <div className="stack">
            {items?.map((w) => <WorkflowCard key={w.id} w={w} onToggle={() => toggle(w)} onEdit={() => setEditing({ id: w.id, form: fromWorkflow(w) })} onChanged={load} onGoApprovals={onGoApprovals} />)}
          </div>
        </>
      )}
    </section>
  );
}

function WorkflowCard({ w, onToggle, onEdit, onChanged, onGoApprovals }: { w: Workflow; onToggle: () => void; onEdit: () => void; onChanged: () => void; onGoApprovals?: () => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [picking, setPicking] = useState(false);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [thread, setThread] = useState('');
  const [result, setResult] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const needsThread = w.actions.some((a) => a.type === 'draft_reply' || a.type === 'send_reply');

  const loadRuns = useCallback(() => { api<Run[]>(`/workflows/${w.id}/runs`).then(setRuns).catch(() => undefined); }, [w.id]);
  useEffect(() => { if (showRuns) loadRuns(); }, [showRuns, loadRuns]);

  async function runNow() {
    setError(''); setResult(null);
    try {
      if (needsThread && !thread) {
        const r = await api<{ threads: ThreadRow[] }>('/inbox/threads?limit=30');
        setThreads(r.threads); setPicking(true);
        if (r.threads[0]) setThread(r.threads[0].id);
        return;
      }
      const run = await api<Run>(`/workflows/${w.id}/run`, { method: 'POST', body: JSON.stringify(needsThread ? { threadId: thread } : {}) });
      setResult(run); setPicking(false); setThread(''); loadRuns(); onChanged();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <article className="card wide workflow">
      <div className="between">
        <div>
          <strong>{w.name}</strong> <span className={`pill ${w.enabled ? 'active' : ''}`}>{w.enabled ? 'On' : 'Off'}</span> <span className="pill">{AUTONOMY[w.autonomy].label}</span>
          {w.description && <div className="muted small">{w.description}</div>}
        </div>
        <label className="switch"><input type="checkbox" role="switch" checked={w.enabled} onChange={onToggle} aria-label={`${w.enabled ? 'Turn off' : 'Turn on'} ${w.name}`} /><span>{w.enabled ? 'On' : 'Off'}</span></label>
      </div>
      <p className="flow"><span>{triggerText(w.trigger)}</span>
        {w.conditions.length > 0 && <span> and {w.conditions.map((c) => `${c.field} ${c.op === 'is' ? 'is' : 'contains'} “${c.value}”`).join(' and ')}</span>}
        <span>, then {w.actions.map(actionText).join(', then ')}.</span></p>
      <div className="row">
        <button onClick={runNow}>Run now</button>
        <button onClick={onEdit}>Edit</button>
        <button onClick={() => setShowRuns(!showRuns)}>{showRuns ? 'Hide runs' : 'Show runs'}</button>
        <button className="danger" onClick={async () => { if (confirm(`Delete “${w.name}”?`)) { await api(`/workflows/${w.id}`, { method: 'DELETE' }); onChanged(); } }}>Delete</button>
        <span className="muted small">{w.last_run_at ? `Last ran ${new Date(w.last_run_at).toLocaleString()}` : 'Has not run yet'}</span>
      </div>
      {picking && (
        <div className="confirm">
          <label>Run on which conversation?
            <select id={`run-thread-${w.id}`} value={thread} onChange={(e) => setThread(e.target.value)}>
              {threads.map((t) => <option key={t.id} value={t.id}>{t.subject || '(no subject)'} — {t.last_sender?.name ?? t.last_sender?.email ?? t.channel}</option>)}
            </select>
          </label>
          {threads.length === 0 && <p className="muted">No conversations yet. Load the demo data above or connect a mailbox.</p>}
          <div className="row"><button className="primary" disabled={!thread} onClick={runNow}>Run</button><button onClick={() => setPicking(false)}>Cancel</button></div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {result && <RunView run={result} onGoApprovals={onGoApprovals} />}
      {showRuns && (
        <div className="runs">
          {runs?.length === 0 && <p className="muted small">No runs yet.</p>}
          {runs?.map((r) => <RunView key={r.id} run={r} onGoApprovals={onGoApprovals} />)}
        </div>
      )}
    </article>
  );
}

function RunView({ run, onGoApprovals }: { run: Run; onGoApprovals?: () => void }) {
  return (
    <div className="run">
      <div className="between"><span><span className={`pill ${STATUS_PILL[run.status] ?? ''}`}>{STATUS_TEXT[run.status] ?? run.status}</span> <span className="muted small">{run.manual ? 'Run by hand · ' : ''}{new Date(run.started_at).toLocaleString()}</span></span>
        {run.status === 'waiting_approval' && onGoApprovals && <button className="link" onClick={onGoApprovals}>Open approvals</button>}</div>
      <ol className="steps">{run.steps.map((s, i) => <li key={i} className={`step ${s.status}`}><span className="step-name">{s.action.replace('_', ' ')}</span> {s.message}</li>)}</ol>
    </div>
  );
}

function Builder({ initial, id, onCancel, onSaved }: { initial: Form; id: string | null; onCancel: () => void; onSaved: (message: string) => void }) {
  const [f, setF] = useState<Form>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const isMsg = f.trigger !== 'schedule';

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api(id ? `/workflows/${id}` : '/workflows', { method: id ? 'PUT' : 'POST', body: JSON.stringify(toBody(f)) });
      onSaved(id ? 'Workflow saved.' : 'Workflow created. It is off until you turn it on.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form className="card wide builder" onSubmit={save} aria-label="Workflow builder">
      <div className="between"><strong>{id ? 'Edit workflow' : 'New workflow'}</strong>
        {!id && <select aria-label="Start from a template" value="" onChange={(e) => { const p = PRESETS[Number(e.target.value)]; if (p) setF({ ...blank(), ...p.make() }); }}><option value="">Start from a template…</option>{PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}</select>}
      </div>
      <div className="grid2">
        <label>Name<input id="wf-name" required maxLength={120} value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>Description (optional)<input id="wf-desc" maxLength={500} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
      </div>

      <fieldset>
        <legend>1. When</legend>
        <div className="grid2">
          <label>Trigger
            <select id="wf-trigger" value={f.trigger} onChange={(e) => set('trigger', e.target.value as Form['trigger'])}>
              <option value="message_received">A new message arrives</option><option value="schedule">On a schedule</option><option value="manual">Only when I press Run now</option>
            </select>
          </label>
          {f.trigger === 'schedule' && (
            <div className="grid2">
              <label>How often<select value={f.every} onChange={(e) => set('every', e.target.value as 'day' | 'week')}><option value="day">Every day</option><option value="week">Every week</option></select></label>
              {f.every === 'week' && <label>On<select value={f.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
              <label>At hour<input type="number" min={0} max={23} value={f.hour} onChange={(e) => set('hour', Number(e.target.value))} /></label>
              <label>Time zone<input value={f.timezone} onChange={(e) => set('timezone', e.target.value)} /></label>
            </div>
          )}
        </div>
        {f.trigger === 'message_received' && (
          <div className="conds">
            <span className="muted small">Only when… (leave empty for every message)</span>
            {f.conditions.map((c, i) => (
              <div key={i} className="cond">
                <select aria-label="Field" value={c.field} onChange={(e) => set('conditions', f.conditions.map((x, j) => j === i ? { ...x, field: e.target.value as Cond['field'] } : x))}>
                  {['sender', 'subject', 'body', 'channel', 'priority', 'topic'].map((x) => <option key={x}>{x}</option>)}
                </select>
                <select aria-label="Match" value={c.op} onChange={(e) => set('conditions', f.conditions.map((x, j) => j === i ? { ...x, op: e.target.value as Cond['op'] } : x))}><option value="contains">contains</option><option value="is">is</option></select>
                <input aria-label="Value" value={c.value} placeholder={c.field === 'priority' ? 'urgent, needs_reply, fyi, low' : 'text'} onChange={(e) => set('conditions', f.conditions.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                <button type="button" aria-label="Remove condition" onClick={() => set('conditions', f.conditions.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button type="button" onClick={() => set('conditions', [...f.conditions, { field: 'sender', op: 'contains', value: '' }])}>Add a condition</button>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>2. Then</legend>
        {isMsg && (
          <>
            <label className="inline-check"><input id="wf-draft" type="checkbox" checked={f.draft} onChange={(e) => set('draft', e.target.checked)} />Write a reply draft with AI</label>
            {f.draft && <label>Guidance for the draft (optional)<input maxLength={500} value={f.draftInstructions} onChange={(e) => set('draftInstructions', e.target.value)} placeholder="e.g. keep it under three sentences" /></label>}
            <label className="inline-check"><input id="wf-send" type="checkbox" checked={f.send} onChange={(e) => set('send', e.target.checked)} />Send that reply (see “How much it may do” below)</label>
          </>
        )}
        <label className="inline-check"><input id="wf-event" type="checkbox" checked={f.event} onChange={(e) => set('event', e.target.checked)} />Propose a calendar event (always needs your approval)</label>
        {f.event && (
          <div className="grid2">
            <label>Title (use {'{{subject}}'} and {'{{sender}}'})<input value={f.eventTitle} onChange={(e) => set('eventTitle', e.target.value)} /></label>
            <label>Starts in (hours)<input type="number" min={0} value={f.eventStartIn} onChange={(e) => set('eventStartIn', Number(e.target.value))} /></label>
            <label>Length (minutes)<input type="number" min={15} max={480} value={f.eventDuration} onChange={(e) => set('eventDuration', Number(e.target.value))} /></label>
            <label>Invite (emails, optional)<input value={f.eventAttendees} onChange={(e) => set('eventAttendees', e.target.value)} /></label>
          </div>
        )}
        <label className="inline-check"><input id="wf-report" type="checkbox" checked={f.report} onChange={(e) => set('report', e.target.checked)} />Build a report</label>
        {f.report && (
          <div className="grid2">
            <label>Report<select value={f.reportKind} onChange={(e) => set('reportKind', e.target.value as Form['reportKind'])}><option value="weekly">Weekly summary</option><option value="inbox">Inbox</option><option value="actions">Action items</option><option value="calendar">Calendar</option></select></label>
            <label>Format<select value={f.reportFormat} onChange={(e) => set('reportFormat', e.target.value as Form['reportFormat'])}><option value="pdf">PDF</option><option value="docx">Word</option><option value="xlsx">Excel</option></select></label>
            <label>Days covered<input type="number" min={1} max={90} value={f.reportRange} onChange={(e) => set('reportRange', Number(e.target.value))} /></label>
          </div>
        )}
      </fieldset>

      {isMsg && f.send && (
        <fieldset>
          <legend>3. How much it may do</legend>
          <div className="autonomy">
            {(Object.keys(AUTONOMY) as Autonomy[]).map((a) => (
              <label key={a} className={`choice ${f.autonomy === a ? 'on' : ''}`}>
                <input type="radio" name="autonomy" checked={f.autonomy === a} onChange={() => set('autonomy', a)} /><span><strong>{AUTONOMY[a].label}</strong><span className="muted small"> {AUTONOMY[a].help}</span></span>
              </label>
            ))}
          </div>
          {f.autonomy === 'auto' && (
            <div className="limits">
              <p className="warn">Automatic sending also needs “Allow workflows to send replies without asking me” in Settings, the channel enabled there, and the server switch AUTO_SEND_ENABLED. If any is off, replies wait in your approvals instead.</p>
              <span className="muted small">Channels it may send on by itself</span>
              <div className="row">{CHANNELS.map((c) => <label key={c} className="inline-check"><input type="checkbox" checked={f.channels.includes(c)} onChange={(e) => set('channels', e.target.checked ? [...f.channels, c] : f.channels.filter((x) => x !== c))} />{c}</label>)}</div>
              <div className="grid2">
                <label>Most per 24 hours<input type="number" min={1} max={50} value={f.dailyCap} onChange={(e) => set('dailyCap', Number(e.target.value))} /></label>
                <label>Only to senders at these domains (optional)<input value={f.domains} placeholder="client.com, partner.org" onChange={(e) => set('domains', e.target.value)} /></label>
              </div>
              <label className="inline-check"><input type="checkbox" checked={f.blockUrgent} onChange={(e) => set('blockUrgent', e.target.checked)} />Urgent conversations always wait for me</label>
              <label className="inline-check"><input type="checkbox" checked={f.onlyWorkingHours} onChange={(e) => set('onlyWorkingHours', e.target.checked)} />Only during my working hours</label>
            </div>
          )}
        </fieldset>
      )}

      <label className="inline-check"><input id="wf-enabled" type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />Turn it on now (it will only look at mail that arrives from now on)</label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button className="primary" disabled={busy}>{busy ? 'Saving…' : id ? 'Save changes' : 'Create workflow'}</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

/** Development helper: appears only when the server runs in demo mode. Loads sample data and simulates incoming mail so a workflow can be tried end to end. */
function DemoPanel({ onChange }: { onChange: () => void }) {
  const [on, setOn] = useState(false);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [m, setM] = useState({ fromName: 'Alex Morgan', fromEmail: 'alex@acme.example', subject: 'Question about my order', body: 'Hi, could you send me an update on my order when you get a moment? Thanks.', priority: 'needs_reply' });

  useEffect(() => { api<{ enabled: boolean }>('/demo').then((r) => setOn(r.enabled)).catch(() => setOn(false)); }, []);
  if (!on) return null;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg('');
    try { await fn(); setMsg(ok); onChange(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="card wide demo" aria-label="Demo data">
      <div className="between"><div><strong>Demo mode</strong> <span className="pill">development only</span><div className="muted small">Sample mailbox and calendar. Nothing is read from or sent to a real account.</div></div><button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button></div>
      {open && (
        <>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => act(() => api('/demo/seed', { method: 'POST' }), 'Loaded 5 conversations and 4 events. Find them under Inbox and Calendar.')}>Load demo data</button>
            <button className="danger" disabled={busy} onClick={() => act(() => api('/demo', { method: 'DELETE' }), 'Demo data removed.')}>Remove demo data</button>
          </div>
          <form className="grid2" onSubmit={(e) => { e.preventDefault(); void act(() => api('/demo/inbound', { method: 'POST', body: JSON.stringify(m) }), 'A message arrived and your workflows ran on it. Check Approvals and the workflow’s runs.'); }}>
            <label>From (name)<input value={m.fromName} onChange={(e) => setM({ ...m, fromName: e.target.value })} /></label>
            <label>From (email)<input type="email" value={m.fromEmail} onChange={(e) => setM({ ...m, fromEmail: e.target.value })} /></label>
            <label>Subject<input value={m.subject} onChange={(e) => setM({ ...m, subject: e.target.value })} /></label>
            <label>Priority the AI would give it<select value={m.priority} onChange={(e) => setM({ ...m, priority: e.target.value })}><option value="needs_reply">needs reply</option><option value="urgent">urgent</option><option value="fyi">fyi</option><option value="low">low</option></select></label>
            <label className="wide-field">Message<textarea rows={2} value={m.body} onChange={(e) => setM({ ...m, body: e.target.value })} /></label>
            <div><button className="primary" disabled={busy}>Simulate an incoming message</button></div>
          </form>
        </>
      )}
      {msg && <p role="status" className="ok">{msg}</p>}
    </div>
  );
}
