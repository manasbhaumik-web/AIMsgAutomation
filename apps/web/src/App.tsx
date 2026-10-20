import { FormEvent, useEffect, useState } from 'react';
import { Session, api, getSession, login, logout, oidcFinish, oidcStart, register, restore } from './api';
import { Admin } from './Admin';
import { Calendar } from './Calendar';
import { Connections } from './Connections';
import { Inbox } from './Inbox';
import { Assistant } from './Assistant';
import { Today } from './Today';
import { AiConsent } from './AiConsent';
import { NotificationSettings, NotificationsBell } from './Notifications';

type Page = 'inbox' | 'today' | 'assistant' | 'calendar' | 'accounts' | 'admin';
const LABEL: Record<Page, string> = { inbox: 'Inbox', today: 'Today', assistant: 'Assistant', calendar: 'Calendar', accounts: 'Accounts', admin: 'Admin' };

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
        <strong>Unified Inbox</strong>
        <nav className="tabs nav">
          {(['inbox', 'today', 'assistant', 'calendar', 'accounts', ...(getSession()?.user.role === 'admin' ? ['admin'] : [])] as Page[]).map((p) => (
            <button key={p} className={p === page ? 'active' : ''} onClick={() => { setPage(p); setNotice(''); }}>{LABEL[p]}</button>
          ))}
        </nav>
        <NotificationsBell onOpenThread={showThread} />
        <span className="muted">{session.user.email}</span>
        <button onClick={async () => { await logout(); setSession(null); }}>Sign out</button>
      </header>
      <main className={page === 'inbox' ? 'full' : ''}>
        {notice && <p role="status" className="notice">{notice}</p>}
        {page === 'inbox' && <Inbox openThreadId={openThread} onOpened={() => setOpenThread(null)} />}
        {page === 'today' && <Today onOpenThread={showThread} />}
        {page === 'assistant' && <Assistant onOpenThread={showThread} />}
        {page === 'calendar' && <Calendar />}
        {page === 'accounts' && (<><AiConsent /><div style={{ height: 16 }} /><Connections /><div style={{ height: 16 }} /><NotificationSettings /></>)}
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
    <main className="center">
      <form className="card" onSubmit={submit}>
        <h1>{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
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
  );
}
