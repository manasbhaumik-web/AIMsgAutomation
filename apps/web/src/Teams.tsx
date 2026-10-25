import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, getSession } from './api';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
interface TeamRow { id: string; name: string; role: Role; members: number }
interface Member { user_id: string; role: Role; name: string | null; email: string; joined_at: string }
interface Invite { id: string; email: string; role: string; expires_at: string }
interface TeamDetail { id: string; name: string; role: Role; members: Member[]; invites: Invite[] }
interface MyInvite { id: string; team_name: string; role: string; invited_by_name: string | null; expires_at: string }
interface Template { id: string; name: string; description: string | null; definition: { trigger: { type: string }; actions: { type: string }[]; autonomy: string } }
interface WorkflowRow { id: string; name: string; description: string | null; autonomy: string; trigger: unknown; conditions: unknown; actions: unknown; policy: unknown }

const ROLE_HELP: Record<Role, string> = { owner: 'Manages everything, including deleting the team', admin: 'Manages members and shared templates', member: 'Uses shared templates', viewer: 'Can see the team and its templates' };
const isAdmin = (r: Role) => r === 'owner' || r === 'admin';

/** Teams share people and workflow templates, not messages. Nobody can read another member's mail, drafts, approvals or reports. */
export function Teams() {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [invites, setInvites] = useState<MyInvite[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api<TeamRow[]>('/teams').then(setTeams).catch((e) => setError(e.message));
    api<MyInvite[]>('/team-invites').then(setInvites).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try { const t = await api<TeamDetail>('/teams', { method: 'POST', body: JSON.stringify({ name }) }); setName(''); setOpen(t.id); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <section aria-label="Teams">
      <header className="page-head"><h2>Teams</h2><p className="muted">Share workflow templates and roles with colleagues. Your messages, drafts and reports stay private to you.</p></header>
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p role="status" className="notice">{msg}</p>}

      {invites.length > 0 && (
        <div className="card wide" aria-label="Invitations">
          <strong>Invitations for you</strong>
          {invites.map((i) => (
            <div key={i.id} className="between">
              <span>Join <strong>{i.team_name}</strong> as {i.role}{i.invited_by_name ? `, invited by ${i.invited_by_name}` : ''}</span>
              <span className="row">
                <button className="primary" onClick={async () => { await api(`/team-invites/${i.id}/accept`, { method: 'POST' }); setMsg(`You joined ${i.team_name}.`); load(); }}>Accept</button>
                <button onClick={async () => { await api(`/team-invites/${i.id}/decline`, { method: 'POST' }); load(); }}>Decline</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <form className="card wide row-form" onSubmit={create}>
        <label>New team<input id="team-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales" /></label>
        <button className="primary">Create team</button>
      </form>

      {teams?.length === 0 && <div className="empty"><strong>No teams yet</strong><p className="muted">Create one above, or accept an invitation.</p></div>}
      <div className="stack">
        {teams?.map((t) => (
          <article key={t.id} className="card wide">
            <div className="between">
              <div><strong>{t.name}</strong> <span className="pill">{t.role}</span> <span className="muted small">{t.members} {t.members === 1 ? 'person' : 'people'}</span></div>
              <button onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'Close' : 'Open'}</button>
            </div>
            {open === t.id && <TeamPanel id={t.id} onChanged={load} onGone={() => { setOpen(null); load(); }} />}
          </article>
        ))}
      </div>
    </section>
  );
}

function TeamPanel({ id, onChanged, onGone }: { id: string; onChanged: () => void; onGone: () => void }) {
  const [t, setT] = useState<TeamDetail | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [mine, setMine] = useState<WorkflowRow[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const selfId = getSession()?.user.id ?? '';

  const load = useCallback(() => {
    api<TeamDetail>(`/teams/${id}`).then(setT).catch((e) => setError(e.message));
    api<Template[]>(`/teams/${id}/templates`).then(setTemplates).catch(() => undefined);
    api<WorkflowRow[]>('/workflows').then(setMine).catch(() => undefined);
  }, [id]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); load(); onChanged(); } catch (e) { setError((e as Error).message); }
  };

  if (!t) return error ? <p className="error" role="alert">{error}</p> : null;
  const admin = isAdmin(t.role);

  return (
    <div className="team-panel">
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p role="status" className="ok">{msg}</p>}
      <p className="muted small">{ROLE_HELP[t.role]}. You are {t.role === 'admin' || t.role === 'owner' ? 'an' : 'a'} {t.role}.</p>

      <h4>People</h4>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
        <tbody>
          {t.members.map((m) => (
            <tr key={m.user_id}>
              <td>{m.name ?? '—'}{m.user_id === selfId && <span className="muted small"> (you)</span>}</td><td>{m.email}</td>
              <td>
                {m.role !== 'owner' && admin && m.user_id !== selfId ? (
                  <select aria-label={`Role of ${m.email}`} value={m.role} onChange={(e) => run(() => api(`/teams/${id}/members/${m.user_id}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }))}>
                    {(t.role === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer']).concat(t.role !== 'owner' && m.role === 'admin' ? ['admin'] : []).map((r) => <option key={r}>{r}</option>)}
                  </select>
                ) : <span className="pill">{m.role}</span>}
              </td>
              <td>
                {m.role !== 'owner' && (m.user_id === selfId || admin) && (
                  <button className="danger" onClick={() => run(() => api(`/teams/${id}/members/${m.user_id}`, { method: 'DELETE' }), undefined).then(() => { if (m.user_id === selfId) onGone(); })}>{m.user_id === selfId ? 'Leave' : 'Remove'}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {admin && (
        <>
          <form className="row-form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/teams/${id}/invites`, { method: 'POST', body: JSON.stringify({ email, role }) }), 'Invitation created. They will see it under Teams when they sign in.').then(() => setEmail('')); }}>
            <label>Invite by email<input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label>Role<select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member' | 'viewer')}>{(t.role === 'owner' ? ['member', 'viewer', 'admin'] : ['member', 'viewer']).map((r) => <option key={r}>{r}</option>)}</select></label>
            <button className="primary">Invite</button>
          </form>
          {t.invites.length > 0 && (
            <ul className="plain-list">
              {t.invites.map((i) => <li key={i.id}>{i.email} as {i.role} <span className="muted small">· expires {new Date(i.expires_at).toLocaleDateString()}</span> <button className="link" onClick={() => run(() => api(`/teams/${id}/invites/${i.id}`, { method: 'DELETE' }))}>Withdraw</button></li>)}
            </ul>
          )}
        </>
      )}

      <h4>Shared workflow templates</h4>
      {templates.length === 0 && <p className="muted">No templates yet.{admin ? ' Share one of your workflows below.' : ''}</p>}
      <div className="stack">
        {templates.map((tp) => (
          <div key={tp.id} className="card wide">
            <div className="between">
              <div><strong>{tp.name}</strong> <span className="pill">{tp.definition.autonomy}</span><div className="muted small">{tp.description || `${tp.definition.trigger.type.replace('_', ' ')} → ${tp.definition.actions.map((a) => a.type.replace('_', ' ')).join(', ')}`}</div></div>
              <span className="row">
                <button className="primary" onClick={() => run(() => api(`/workflow-templates/${tp.id}/install`, { method: 'POST' }), 'Installed as one of your workflows, switched off. Review it under Workflows.')}>Install</button>
                {admin && <button className="danger" onClick={() => run(() => api(`/teams/${id}/templates/${tp.id}`, { method: 'DELETE' }))}>Remove</button>}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="muted small">Installing copies the template into your own workflows, switched off. “Auto” is never copied: you choose how much it may do on your own accounts.</p>

      {admin && mine.length > 0 && (
        <form className="row-form" onSubmit={(e) => {
          e.preventDefault();
          const w = mine.find((x) => x.id === pick);
          if (!w) return;
          void run(() => api(`/teams/${id}/templates`, { method: 'POST', body: JSON.stringify({ name: w.name, description: w.description, definition: { autonomy: w.autonomy, trigger: w.trigger, conditions: w.conditions, actions: w.actions, policy: w.policy } }) }), 'Shared with the team.');
        }}>
          <label>Share one of my workflows<select id="tpl-pick" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose…</option>{mine.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          <button className="primary" disabled={!pick}>Share as template</button>
        </form>
      )}

      {admin && (
        <div className="danger-zone">
          {t.role === 'owner' && <button className="danger" onClick={() => { if (confirm('Delete this team? Members keep the workflows they installed.')) void run(() => api(`/teams/${id}`, { method: 'DELETE' })).then(onGone); }}>Delete team</button>}
        </div>
      )}
    </div>
  );
}
