import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from './api';

interface Provider { id: string; name: string; kind: string; enabled: boolean; has_key: boolean; adapterAvailable: boolean }
interface Tool { id: string; name: string; configured: boolean; missing: string[]; redirectUrl: string; note: string }
interface Turn { role: 'user' | 'assistant'; content: string; meta?: string; error?: boolean }
interface ChatReply { ok: boolean; text?: string; error?: string; tokensIn?: number; tokensOut?: number; latencyMs?: number }

/** Admin test console: which tools have credentials, and a throwaway chat to try a provider and model. */
export function AdminTest() {
  return (
    <div>
      <Tools />
      <TestChat />
    </div>
  );
}

function Tools() {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api<Tool[]>('/admin/tools').then(setTools).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  return (
    <section>
      <h2>Tools</h2>
      <p className="muted">
        Tool credentials are read from the server's <code>.env</code> when the API starts, so they are shown here but not editable.
        Add the missing keys, restart the API, then press Refresh. Values are never shown.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="tool-grid">
        {tools?.map((t) => (
          <div key={t.id} className="tool-card">
            <div className="between">
              <strong>{t.name}</strong>
              <span className={`pill ${t.configured ? 'active' : 'warn'}`}>{t.configured ? 'Configured' : 'Not set up'}</span>
            </div>
            <span className="muted small">{t.note}</span>
            {t.missing.length > 0 && <code className="small">{t.missing.join(', ')}</code>}
          </div>
        ))}
      </div>
      {tools && <p className="muted small">Register <code>{tools[0]?.redirectUrl}</code> with each provider.</p>}
      <div className="row"><button onClick={load}>Refresh</button></div>
    </section>
  );
}

function TestChat() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [system, setSystem] = useState('');
  const [temperature, setTemperature] = useState(0.3);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Provider[]>('/admin/llm/providers').then((p) => {
      const usable = p.filter((x) => x.adapterAvailable && x.has_key && x.enabled);
      setProviders(usable);
      if (usable[0]) setProviderId(usable[0].id);
    }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [turns, busy]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !providerId || !model.trim()) return;
    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setInput('');
    setBusy(true);
    try {
      const messages = next.filter((t) => !t.error).map(({ role, content }) => ({ role, content }));
      const r = await api<ChatReply>(`/admin/llm/providers/${providerId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ model: model.trim(), system: system.trim() || undefined, temperature, messages }),
      });
      setTurns([...next, r.ok
        ? { role: 'assistant', content: r.text ?? '', meta: `${r.latencyMs} ms · ${r.tokensIn ?? 0} in / ${r.tokensOut ?? 0} out` }
        : { role: 'assistant', content: r.error ?? 'Request failed', error: true }]);
    } catch (err) {
      setTurns([...next, { role: 'assistant', content: (err as Error).message, error: true }]);
    } finally { setBusy(false); }
  }

  return (
    <section>
      <h2>Test chat</h2>
      <p className="muted">
        Talk to a model directly to check a provider key. Nothing here touches mail or user data, and the conversation is kept
        only in this page: it is sent with each turn and is not stored by the server.
      </p>
      {error && <p className="error">{error}</p>}
      {providers.length === 0 && !error && <p className="muted">Add a provider with a key on the providers tab first.</p>}
      <div className="card inline">
        <label>Provider
          <select id="t-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.kind})</option>)}
          </select>
        </label>
        <label>Model<input id="t-model" placeholder="e.g. gemini-3.8-flash" value={model} onChange={(e) => setModel(e.target.value)} /></label>
        <label>Temperature<input id="t-temp" type="number" step="0.1" min={0} max={2} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} /></label>
        <label>System prompt (optional)<input id="t-system" value={system} onChange={(e) => setSystem(e.target.value)} /></label>
      </div>
      <div className="card wide chat">
        <div role="log" aria-live="polite" className="chat-log">
          {turns.length === 0 && <p className="muted">Send a message to start.</p>}
          {turns.map((t, i) => (
            <div key={i} className={`turn ${t.role}`}>
              <span className="muted small">{t.role === 'user' ? 'You' : 'Model'}{t.meta ? ` · ${t.meta}` : ''}</span>
              <div className={`bubble${t.error ? ' err' : ''}`}>{t.content}</div>
            </div>
          ))}
          {busy && <p className="muted">Waiting for the model…</p>}
          <div ref={end} />
        </div>
        <form onSubmit={send} className="chat-form">
          <input id="t-input" style={{ flex: 1 }} placeholder="Type a message" value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <button className="primary" disabled={busy || !input.trim() || !providerId || !model.trim()}>Send</button>
          <button type="button" onClick={() => setTurns([])} disabled={busy || turns.length === 0}>Clear</button>
        </form>
        {!model.trim() && <p className="muted">Enter a model name to enable Send.</p>}
      </div>
    </section>
  );
}
