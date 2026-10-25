import { FormEvent, useEffect, useState } from 'react';
import { api } from './api';

type Channel = 'gmail' | 'outlook' | 'slack' | 'teams' | 'whatsapp';
const CHANNELS: Channel[] = ['gmail', 'outlook', 'slack', 'teams', 'whatsapp'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Profile {
  businessRole: string | null;
  businessGoals: string | null;
  tone: string;
  language: string;
  signature: string | null;
  timezone: string;
  workDays: number[];
  workStart: number;
  workEnd: number;
  autoRepliesEnabled: boolean;
  escalationRules: { urgentSenders: string[]; keywords: string[]; notifyOutsideHours: boolean };
  responsePolicies: Partial<Record<Channel, { allowAuto: boolean; maxPerDay: number }>>;
  reportPrefs: { defaultFormat: 'pdf' | 'docx' | 'xlsx'; rangeDays: number };
}

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };
const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/** How the person works and writes. Drafts use it; workflows use the working hours and the automatic-reply switches. */
export function Preferences() {
  const [p, setP] = useState<Profile | null>(null);
  const [senders, setSenders] = useState('');
  const [keywords, setKeywords] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Profile>('/me/profile').then((r) => { setP(r); setSenders(r.escalationRules.urgentSenders.join(', ')); setKeywords(r.escalationRules.keywords.join(', ')); }).catch((e) => setError(e.message));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!p) return;
    setSaving(true); setMsg(''); setError('');
    try {
      const body = { ...p, businessRole: p.businessRole || null, businessGoals: p.businessGoals || null, signature: p.signature || null, escalationRules: { ...p.escalationRules, urgentSenders: list(senders), keywords: list(keywords) } };
      setP(await api<Profile>('/me/profile', { method: 'PUT', body: JSON.stringify(body) }));
      setMsg('Preferences saved.');
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }

  if (!p) return error ? <p className="error" role="alert">{error}</p> : null;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP({ ...p, [k]: v });
  const policy = (c: Channel) => p.responsePolicies[c] ?? { allowAuto: false, maxPerDay: 10 };
  const setPolicy = (c: Channel, v: Partial<{ allowAuto: boolean; maxPerDay: number }>) => set('responsePolicies', { ...p.responsePolicies, [c]: { ...policy(c), ...v } });

  return (
    <form className="card wide prefs" onSubmit={save} aria-label="Preferences">
      <div className="between"><strong>Preferences</strong><span className="muted small">Used for reply drafts, working hours and automation</span></div>

      <fieldset>
        <legend>About you</legend>
        <div className="grid2">
          <label>Your role<input id="pf-role" value={p.businessRole ?? ''} maxLength={120} placeholder="e.g. Founder, Sales lead" onChange={(e) => set('businessRole', e.target.value)} /></label>
          <label>Language for drafts<input id="pf-lang" value={p.language} placeholder="en, pt-BR, fr" onChange={(e) => set('language', e.target.value)} /></label>
          <label>Tone<input id="pf-tone" value={p.tone} maxLength={80} placeholder="e.g. warm and concise" onChange={(e) => set('tone', e.target.value)} /></label>
          <label>Time zone<input id="pf-tz" value={p.timezone} onChange={(e) => set('timezone', e.target.value)} /><button type="button" className="link" onClick={() => set('timezone', browserTz())}>Use this device's</button></label>
        </div>
        <label>Business goals<textarea id="pf-goals" rows={2} maxLength={1000} value={p.businessGoals ?? ''} onChange={(e) => set('businessGoals', e.target.value)} /></label>
        <label>Signature (added to drafts)<textarea id="pf-sig" rows={2} maxLength={500} value={p.signature ?? ''} onChange={(e) => set('signature', e.target.value)} /></label>
      </fieldset>

      <fieldset>
        <legend>Working hours</legend>
        <div className="row">
          {DAYS.map((d, i) => (
            <label key={d} className="inline-check"><input type="checkbox" checked={p.workDays.includes(i)} onChange={(e) => set('workDays', e.target.checked ? [...p.workDays, i].sort() : p.workDays.filter((x) => x !== i))} />{d}</label>
          ))}
        </div>
        <div className="grid2">
          <label>Starts at (hour)<input id="pf-start" type="number" min={0} max={23} value={p.workStart} onChange={(e) => set('workStart', Number(e.target.value))} /></label>
          <label>Ends at (hour)<input id="pf-end" type="number" min={1} max={24} value={p.workEnd} onChange={(e) => set('workEnd', Number(e.target.value))} /></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Automatic replies</legend>
        <label className="inline-check strong">
          <input id="pf-auto" type="checkbox" checked={p.autoRepliesEnabled} onChange={(e) => set('autoRepliesEnabled', e.target.checked)} />
          Allow workflows to send replies without asking me
        </label>
        <p className="muted small">Off by default. Even when on, a workflow must be set to “auto”, the channel must be allowed below, urgent conversations always wait for you, and the server must allow it too. Anything that does not meet every limit goes to your approvals instead.</p>
        <div className="policy-grid" aria-label="Per-channel automatic replies">
          {CHANNELS.map((c) => (
            <div key={c} className="policy-row">
              <label className="inline-check"><input type="checkbox" checked={policy(c).allowAuto} disabled={!p.autoRepliesEnabled} onChange={(e) => setPolicy(c, { allowAuto: e.target.checked })} />{c}</label>
              <label className="small">Most per day<input type="number" min={0} max={100} value={policy(c).maxPerDay} disabled={!p.autoRepliesEnabled || !policy(c).allowAuto} onChange={(e) => setPolicy(c, { maxPerDay: Number(e.target.value) })} /></label>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>When to involve me</legend>
        <label>Senders that are always important<textarea rows={2} value={senders} placeholder="dana@client.com, boss@company.com" onChange={(e) => setSenders(e.target.value)} /></label>
        <label>Words that make a message important<textarea rows={2} value={keywords} placeholder="refund, outage, contract" onChange={(e) => setKeywords(e.target.value)} /></label>
        <label className="inline-check"><input type="checkbox" checked={p.escalationRules.notifyOutsideHours} onChange={(e) => set('escalationRules', { ...p.escalationRules, notifyOutsideHours: e.target.checked })} />Notify me about these even outside working hours</label>
      </fieldset>

      <fieldset>
        <legend>Reports</legend>
        <div className="grid2">
          <label>Default format
            <select value={p.reportPrefs.defaultFormat} onChange={(e) => set('reportPrefs', { ...p.reportPrefs, defaultFormat: e.target.value as 'pdf' | 'docx' | 'xlsx' })}>
              <option value="pdf">PDF</option><option value="docx">Word</option><option value="xlsx">Excel</option>
            </select>
          </label>
          <label>Default range (days)<input type="number" min={1} max={90} value={p.reportPrefs.rangeDays} onChange={(e) => set('reportPrefs', { ...p.reportPrefs, rangeDays: Number(e.target.value) })} /></label>
        </div>
      </fieldset>

      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p role="status" className="ok">{msg}</p>}
      <div className="row"><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save preferences'}</button></div>
    </form>
  );
}
