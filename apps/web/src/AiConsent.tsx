import { useEffect, useRef, useState } from 'react';
import { api } from './api';

interface AiSettings { aiProcessing: boolean }

/** Opt-in switch for AI features (GDPR/PDPA). Withdrawing erases everything the AI layer derived. */
export function AiConsent({ onChange }: { onChange?: (on: boolean) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const notify = useRef(onChange);
  notify.current = onChange;

  useEffect(() => {
    api<AiSettings>('/me/ai').then((s) => { setOn(s.aiProcessing); notify.current?.(s.aiProcessing); }).catch((e) => setError(e.message));
  }, []);

  async function set(value: boolean, eraseDerived = true) {
    setBusy(true); setError('');
    try {
      await api('/me/consents', { method: 'PUT', body: JSON.stringify({ aiProcessing: value, eraseDerived }) });
      setConfirmOff(false); setOn(value); notify.current?.(value);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (on === null) return error ? <p className="error" role="alert">{error}</p> : null;
  return (
    <section className="card wide" aria-label="AI features">
      <div className="between">
        <strong>AI features</strong>
        <span className={`pill ${on ? 'active' : ''}`}>{on ? 'On' : 'Off'}</span>
      </div>
      <p className="muted">
        Topics, priorities, summaries, the daily digest and the assistant send the text of your messages to the AI provider your administrator configured.
        Email addresses and phone numbers are masked first. Accounts with &ldquo;Allow AI features&rdquo; switched off are never included.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {!on && <div className="row"><button className="primary" disabled={busy} onClick={() => set(true)}>Turn on AI features</button></div>}
      {on && !confirmOff && <div className="row"><button disabled={busy} onClick={() => setConfirmOff(true)}>Turn off&hellip;</button></div>}
      {on && confirmOff && (
        <div className="confirm" role="alertdialog" aria-label="Confirm turning off AI">
          <p>Your mail and calendar stay. AI-generated topics, summaries, digests and assistant chats can be erased too.</p>
          <div className="row">
            <button className="danger" disabled={busy} onClick={() => set(false, true)}>Turn off and erase AI data</button>
            <button disabled={busy} onClick={() => set(false, false)}>Turn off, keep AI data</button>
            <button onClick={() => setConfirmOff(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Renders its children only while AI features are on; otherwise shows the opt-in card. */
export function ConsentGate({ children }: { children: React.ReactNode }) {
  const [on, setOn] = useState<boolean | null>(null);
  return (
    <>
      <AiConsent onChange={setOn} />
      {on === true && <div style={{ marginTop: 16 }}>{children}</div>}
    </>
  );
}
