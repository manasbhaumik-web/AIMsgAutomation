import { FormEvent, useEffect, useState } from 'react';
import { Session, api, getSession, login, logout, oidcFinish, oidcStart, register, restore } from './api';
import { Admin } from './Admin';
import { Automations } from './Automations';
import { Preferences } from './Preferences';
import { Teams } from './Teams';
import { Calendar } from './Calendar';
import { Connections } from './Connections';
import { Inbox } from './Inbox';
import { Assistant } from './Assistant';
import { Today } from './Today';
import { AiConsent } from './AiConsent';
import { NotificationSettings, NotificationsBell } from './Notifications';

type Page = 'inbox' | 'today' | 'assistant' | 'calendar' | 'automations' | 'teams' | 'accounts' | 'admin';
const LABEL: Record<Page, string> = { inbox: 'Inbox', today: 'Today', assistant: 'Assistant', calendar: 'Calendar', automations: 'Automations', teams: 'Teams', accounts: 'Accounts', admin: 'Admin' };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<Page>('inbox');
  const [notice, setNotice] = useState('');
  const [openThread, setOpenThread] = useState<string | null>(null);
  const showThread = (id: string) => { setOpenThread(id); setPage('inbox'); setNotice(''); };

  useEffect(() => {
    (async () => {
      if (location.pathname === '/connect/callback') {
        // Returning from a Google/Microsoft consent screen: finish linking the account.
        const p = new URLSearchParams(location.search);
        const code = p.get('code');
        const state = p.get('state');
        const denied = p.get('error');
        history.replaceState(null, '', '/');
        const s = await restore();
        setSession(s);
        if (s) {
          setPage('accounts');
          if (denied || !code || !state) setNotice(denied ? 'The provider reported: access was not granted.' : 'The connection response was incomplete.');
          else {
            try { await api('/accounts/callback', { method: 'POST', body: JSON.stringify({ code, state }) }); setNotice('Account connected. Your recent mail and events are importing.'); }
            catch (e) { setNotice((e as Error).message); }
          }
        }
      } else if (location.pathname === '/auth/callback') {
        const p = new URLSearchParams(location.search);
        const code = p.get('code');
        const state = p.get('state');
        history.replaceState(null, '', '/');
        if (code && state) {
          try {
            setSession(await oidcFinish(code, state));
          } catch (e) {
            alert((e as Error).message);
          }
        }
      } else {
        setSession(await restore());
      }
      setReady(true);
    })();
  }, []);

  if (!ready) return <main className="center">Loading…</main>;
  if (!session) return <SignIn onDone={setSession} />;
  return (
    <>
      <header className="bar">
        <span className="brand"><span className="logo" aria-hidden="true"><MailIcon /></span><strong>Unified Inbox</strong></span>
        <nav className="tabs nav" aria-label="Main">
          {(['inbox', 'today', 'assistant', 'calendar', 'automations', 'teams', 'accounts', ...(getSession()?.user.role === 'admin' ? ['admin'] : [])] as Page[]).map((p) => (
            <button key={p} className={p === page ? 'active' : ''} aria-current={p === page ? 'page' : undefined} onClick={() => { setPage(p); setNotice(''); }}>{LABEL[p]}</button>
          ))}
        </nav>
        <NotificationsBell onOpenThread={showThread} />
        <span className="who">
          <span className="muted">{session.user.email}</span>
          <button onClick={async () => { await logout(); setSession(null); }}>Sign out</button>
        </span>
      </header>
      <main className={page === 'inbox' || page === 'admin' ? 'full' : ''}>
        {notice && <p role="status" className="notice">{notice}</p>}
        {page === 'inbox' && <Inbox openThreadId={openThread} onOpened={() => setOpenThread(null)} />}
        {page === 'today' && <Today onOpenThread={showThread} />}
        {page === 'assistant' && <Assistant onOpenThread={showThread} />}
        {page === 'calendar' && <Calendar />}
        {page === 'automations' && <Automations />}
        {page === 'teams' && <Teams />}
        {page === 'accounts' && (<><AiConsent /><div style={{ height: 16 }} /><Connections /><div style={{ height: 16 }} /><NotificationSettings /><div style={{ height: 16 }} /><Preferences /></>)}
        {page === 'admin' && <Admin />}
      </main>
    </>
  );
}

function SignIn({ onDone }: { onDone: (s: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      onDone(mode === 'login' ? await login(email, password) : await register(email, password, name));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function sso(p: 'google' | 'microsoft') {
    try {
      await oidcStart(p);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="signin">
      <section className="signin-about" aria-label="About">
        <span className="brand"><span className="logo" aria-hidden="true"><MailIcon /></span><strong>Unified Inbox</strong></span>
        <div className="signin-copy">
          <h1>All your messages, one calm place.</h1>
          <p>Email, calendar and chat in one inbox, with summaries and reply drafts you review before anything is sent.</p>
          <ul>
            <li>Gmail, Outlook, Teams, Slack and WhatsApp together</li>
            <li>Summaries, topics and action items on every thread</li>
            <li>Nothing is ever sent without your confirmation</li>
          </ul>
        </div>
        <small className="muted">Your data stays yours: AI is off until you turn it on.</small>
      </section>
      <main className="signin-form">
      <form className="signin-card" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
        {mode === 'register' && (
          <label>Name<input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
        )}
        <label>Email<input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>
          Password
          <input id="password" type="password" required minLength={mode === 'register' ? 12 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {mode === 'register' && <small className="muted">At least 12 characters.</small>}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <div className="row">
          <button type="button" onClick={() => sso('google')}>Continue with Google</button>
          <button type="button" onClick={() => sso('microsoft')}>Continue with Microsoft</button>
        </div>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Need an account? Create one' : 'Have an account? Sign in'}
        </button>
      </form>
      </main>
    </div>
  );
}

function MailIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 1 9 6 9-6" /></svg>
  );
}
