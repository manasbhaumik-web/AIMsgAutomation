import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from './api';

interface Provider { id: string; name: string; kind: string; base_url: string | null; enabled: boolean; has_key: boolean; adapterAvailable: boolean }
interface Route { task: string; provider_id: string; model: string; temperature: number; max_tokens: number; fallback_provider_id: string | null; fallback_model: string | null }
interface Prompt { id: string; task: string; version: number; body: string; active: boolean }
interface UsageRow { day: string; task: string; model: string; calls: number; tokens_in: string; tokens_out: string; failures: number }

const TASKS = ['classify', 'topic-tag', 'summarize', 'digest', 'chat', 'draft-reply', 'embed'];
const KINDS = ['anthropic', 'openai', 'google', 'xai', 'azure-openai', 'ollama'];
type Tab = 'providers' | 'routes' | 'prompts' | 'usage';

export function Admin() {
  const [tab, setTab] = useState<Tab>('providers');
  return (
    <div>
      <nav className="tabs">
        {(['providers', 'routes', 'prompts', 'usage'] as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      {tab === 'providers' && <Providers />}
      {tab === 'routes' && <Routes />}
      {tab === 'prompts' && <Prompts />}
      {tab === 'usage' && <Usage />}
    </div>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    api<T>(path).then(setData).catch((e) => setError(e.message));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function Providers() {
  const { data, error, reload } = useLoad<Provider[]>('/admin/llm/providers');
  const [f, setF] = useState({ name: '', kind: 'anthropic', baseUrl: '', apiKey: '' });
  const [msg, setMsg] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    try {
      await api('/admin/llm/providers', { method: 'POST', body: JSON.stringify({ name: f.name, kind: f.kind, baseUrl: f.baseUrl || null, apiKey: f.apiKey }) });
      setF({ ...f, name: '', apiKey: '' });
      reload();
    } catch (err) { setMsg((err as Error).message); }
  }
  async function test(p: Provider) {
    const model = prompt('Model name to test with');
    if (!model) return;
    try {
      const r = await api<{ ok: boolean; latencyMs?: number; error?: string }>(`/admin/llm/providers/${p.id}/test`, { method: 'POST', body: JSON.stringify({ model }) });
      setMsg(r.ok ? `${p.name}: OK in ${r.latencyMs} ms` : `${p.name}: ${r.error}`);
    } catch (err) { setMsg((err as Error).message); }
  }
  async function rotate(p: Provider) {
    const apiKey = prompt(`New API key for ${p.name}`);
    if (apiKey) { await api(`/admin/llm/providers/${p.id}`, { method: 'PATCH', body: JSON.stringify({ apiKey }) }); reload(); }
  }

  return (
    <section>
      <h2>LLM providers</h2>
      <p className="muted">Keys are encrypted on save and never shown again. Only providers with an available adapter can be routed.</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Name</th><th>Kind</th><th>Key</th><th>Adapter</th><th>Enabled</th><th /></tr></thead>
        <tbody>
          {data?.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td><td>{p.kind}</td><td>{p.has_key ? 'stored' : 'none'}</td>
              <td>{p.adapterAvailable ? 'ready' : 'planned'}</td>
              <td><input type="checkbox" aria-label={`Enable ${p.name}`} checked={p.enabled} onChange={async (e) => { await api(`/admin/llm/providers/${p.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) }); reload(); }} /></td>
              <td className="row"><button onClick={() => test(p)} disabled={!p.adapterAvailable}>Test</button><button onClick={() => rotate(p)}>Rotate key</button></td>
            </tr>
          ))}
          {data?.length === 0 && <tr><td colSpan={6} className="muted">No providers yet. Add one below.</td></tr>}
        </tbody>
      </table>
      <form className="card inline" onSubmit={add}>
        <label>Name<input id="p-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Kind<select id="p-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
        <label>Base URL (optional)<input id="p-base" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="https://api.anthropic.com" /></label>
        <label>API key<input id="p-key" type="password" required minLength={8} value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} autoComplete="off" /></label>
        <button className="primary">Add provider</button>
      </form>
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}

function Routes() {
  const providers = useLoad<Provider[]>('/admin/llm/providers');
  const routes = useLoad<Route[]>('/admin/llm/routes');
  const [task, setTask] = useState('summarize');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [msg, setMsg] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    try {
      await api(`/admin/llm/routes/${task}`, { method: 'PUT', body: JSON.stringify({ providerId, model, temperature, maxTokens }) });
      routes.reload();
      setMsg('Saved');
    } catch (err) { setMsg((err as Error).message); }
  }

  return (
    <section>
      <h2>Task routing</h2>
      <table>
        <thead><tr><th>Task</th><th>Provider</th><th>Model</th><th>Temp</th><th>Max tokens</th></tr></thead>
        <tbody>
          {TASKS.map((t) => {
            const r = routes.data?.find((x) => x.task === t);
            return <tr key={t}><td>{t}</td><td>{r ? providers.data?.find((p) => p.id === r.provider_id)?.name : <span className="muted">not set</span>}</td><td>{r?.model}</td><td>{r?.temperature}</td><td>{r?.max_tokens}</td></tr>;
          })}
        </tbody>
      </table>
      <form className="card inline" onSubmit={save}>
        <label>Task<select id="r-task" value={task} onChange={(e) => setTask(e.target.value)}>{TASKS.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>Provider
          <select id="r-provider" required value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="" disabled>Choose…</option>
            {providers.data?.filter((p) => p.adapterAvailable).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Model<input id="r-model" required value={model} onChange={(e) => setModel(e.target.value)} /></label>
        <label>Temperature<input id="r-temp" type="number" step="0.1" min={0} max={2} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} /></label>
        <label>Max tokens<input id="r-max" type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} /></label>
        <button className="primary">Save route</button>
      </form>
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}

function Prompts() {
  const [task, setTask] = useState('summarize');
  const { data, reload } = useLoad<Prompt[]>(`/admin/prompts?task=${task}`);
  const [system, setSystem] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/admin/prompts', { method: 'POST', body: JSON.stringify({ task, system: system || null, body }) });
      setBody(''); reload();
    } catch (err) { setMsg((err as Error).message); }
  }

  return (
    <section>
      <h2>Prompt templates</h2>
      <label>Task<select id="pr-task" value={task} onChange={(e) => setTask(e.target.value)}>{TASKS.map((t) => <option key={t}>{t}</option>)}</select></label>
      <table>
        <thead><tr><th>Version</th><th>Prompt</th><th>Status</th><th /></tr></thead>
        <tbody>
          {data?.map((p) => (
            <tr key={p.id}>
              <td>v{p.version}</td><td className="clip">{p.body}</td><td>{p.active ? 'active' : ''}</td>
              <td>{!p.active && <button onClick={async () => { await api(`/admin/prompts/${p.id}/activate`, { method: 'POST' }); reload(); }}>Activate</button>}</td>
            </tr>
          ))}
          {data?.length === 0 && <tr><td colSpan={4} className="muted">No versions yet.</td></tr>}
        </tbody>
      </table>
      <form className="card" onSubmit={create}>
        <label>System prompt (optional)<textarea id="pr-system" rows={2} value={system} onChange={(e) => setSystem(e.target.value)} /></label>
        <label>Template. Use {'{{variable}}'} placeholders.<textarea id="pr-body" required rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <button className="primary">Save as new version</button>
      </form>
      {msg && <p className="error">{msg}</p>}
    </section>
  );
}

function Usage() {
  const { data, error } = useLoad<UsageRow[]>('/admin/usage');
  return (
    <section>
      <h2>Usage, last 30 days</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Day</th><th>Task</th><th>Model</th><th>Calls</th><th>Tokens in</th><th>Tokens out</th><th>Failures</th></tr></thead>
        <tbody>
          {data?.map((r, i) => <tr key={i}><td>{r.day.slice(0, 10)}</td><td>{r.task}</td><td>{r.model}</td><td>{r.calls}</td><td>{r.tokens_in}</td><td>{r.tokens_out}</td><td>{r.failures}</td></tr>)}
          {data?.length === 0 && <tr><td colSpan={7} className="muted">No AI calls yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
