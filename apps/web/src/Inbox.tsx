import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { Account, CHANNEL_LABEL } from './Connections';
import { ReplyPanel } from './Reply';

interface Party { name?: string; email?: string; handle?: string }
interface Topic { id: string; name: string }
type Priority = 'urgent' | 'needs_reply' | 'fyi' | 'low';
interface ThreadRow { id: string; account_id: string; channel: string; subject: string | null; last_message_at: string; message_count: number; unread: number; last_sender: Party | null; snippet: string | null; priority: Priority | null; topics: Topic[] }
interface Msg { id: string; sender: Party | null; recipients: { to?: Party[]; cc?: Party[] }; body_text: string; body_html_sanitized: string | null; attachments_meta: { name: string; size: number }[]; timestamp: string; direction: string; is_read: boolean }
interface ActionItem { id: string; text: string; due_at: string | null; status: 'open' | 'done' }
interface ThreadDetail { id: string; subject: string | null; priority: Priority | null; topics: Topic[]; action_items: ActionItem[]; messages: Msg[] }
interface InboxData { channels: { channel: string; unread: number; accounts: Account[] }[] }

const who = (p: Party | null | undefined) => p?.name || p?.email || p?.handle || 'Unknown';
const MESSAGING = ['gmail', 'outlook', 'slack', 'teams', 'whatsapp'];
const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', needs_reply: 'Needs reply', fyi: 'FYI', low: 'Low' };

export function Inbox({ openThreadId, onOpened }: { openThreadId?: string | null; onOpened?: () => void }) {
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [scope, setScope] = useState<{ channel?: string; accountId?: string }>({});
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [priority, setPriority] = useState<Priority | ''>('');
  const [topicId, setTopicId] = useState('');
  const [topics, setTopics] = useState<(Topic & { threads: number })[]>([]);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const loadInbox = useCallback(() => { api<InboxData>('/inbox').then(setInbox).catch((e) => setError(e.message)); }, []);
  const query = useCallback((before?: string) => {
    const q = new URLSearchParams();
    if (scope.accountId) q.set('accountId', scope.accountId);
    else if (scope.channel) q.set('channel', scope.channel);
    if (unreadOnly) q.set('unreadOnly', 'true');
    if (priority) q.set('priority', priority);
    if (topicId) q.set('topicId', topicId);
    if (before) q.set('before', before);
    return `/inbox/threads?${q}`;
  }, [scope, unreadOnly, priority, topicId]);

  const loadThreads = useCallback(() => {
    api<{ threads: ThreadRow[]; nextBefore: string | null }>(query()).then((r) => { setThreads(r.threads); setNext(r.nextBefore); }).catch((e) => setError(e.message));
  }, [query]);

  useEffect(loadInbox, [loadInbox]);
  useEffect(loadThreads, [loadThreads]);
  useEffect(() => { api<(Topic & { threads: number })[]>('/topics').then(setTopics).catch(() => undefined); }, [threads.length]);
  // Light polling so new mail and AI results appear without a manual refresh; push delivery arrives with the realtime phase.
  useEffect(() => { const t = setInterval(() => { loadInbox(); loadThreads(); }, 30_000); return () => clearInterval(t); }, [loadInbox, loadThreads]);

  const openById = useCallback(async (id: string, unread = 0) => {
    try {
      setOpen(await api<ThreadDetail>(`/threads/${id}`));
      if (unread > 0) { await api(`/threads/${id}/read`, { method: 'POST', body: JSON.stringify({ read: true }) }); loadInbox(); loadThreads(); }
    } catch (e) { setError((e as Error).message); }
  }, [loadInbox, loadThreads]);

  useEffect(() => { if (openThreadId) { void openById(openThreadId, 1); onOpened?.(); } }, [openThreadId, openById, onOpened]);

  const mailChannels = inbox?.channels.filter((c) => MESSAGING.includes(c.channel)) ?? [];
  const totalUnread = mailChannels.reduce((n, c) => n + c.unread, 0);
  const views: { id: string; label: string; count?: number; active: boolean; pick: () => void }[] = [
    { id: 'all', label: 'All messages', active: !priority && !unreadOnly, pick: () => { setPriority(''); setUnreadOnly(false); setScope({}); } },
    { id: 'needs_reply', label: 'Needs reply', active: priority === 'needs_reply', pick: () => { setPriority('needs_reply'); setUnreadOnly(false); } },
    { id: 'urgent', label: 'Urgent', active: priority === 'urgent', pick: () => { setPriority('urgent'); setUnreadOnly(false); } },
    { id: 'unread', label: 'Unread', count: totalUnread, active: unreadOnly && !priority, pick: () => { setPriority(''); setUnreadOnly(true); } },
    { id: 'fyi', label: 'FYI', active: priority === 'fyi', pick: () => { setPriority('fyi'); setUnreadOnly(false); } },
  ];
  const title = views.find((v) => v.active)?.label ?? 'Filtered messages';
  const needle = search.trim().toLowerCase();
  const shown = needle ? threads.filter((t) => `${who(t.last_sender)} ${t.subject ?? ''} ${t.snippet ?? ''}`.toLowerCase().includes(needle)) : threads;

  return (
    <div className="inbox">
      <aside className="side" aria-label="Views and filters">
        <div className="side-group">
          {views.map((v) => (
            <button key={v.id} className={v.active ? 'active' : ''} aria-current={v.active ? 'true' : undefined} onClick={v.pick}>
              <span>{v.label}</span>{v.count ? <span className="badge">{v.count}</span> : null}
            </button>
          ))}
        </div>
        {mailChannels.length > 0 && (
          <div className="side-group">
            <span className="eyebrow">Connected</span>
            {mailChannels.map((c) => (
              <div key={c.channel}>
                <button className={scope.channel === c.channel && !scope.accountId ? 'active' : ''} onClick={() => setScope(scope.channel === c.channel ? {} : { channel: c.channel })}>
                  <span className="dot" aria-hidden="true" /><span>{CHANNEL_LABEL[c.channel]}</span>{c.unread > 0 && <span className="badge">{c.unread}</span>}
                </button>
                {c.accounts.length > 1 && c.accounts.map((a) => (
                  <button key={a.id} className={`sub ${scope.accountId === a.id ? 'active' : ''}`} onClick={() => setScope({ accountId: a.id })}>
                    <span>{a.external_id}</span>{a.unread > 0 && <span className="badge">{a.unread}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {topics.length > 0 && (
          <div className="side-group">
            <span className="eyebrow">Topics</span>
            <div className="topic-chips">
              {topics.map((t) => (
                <button key={t.id} className={`topic-chip ${topicId === t.id ? 'active' : ''}`} aria-pressed={topicId === t.id} onClick={() => setTopicId(topicId === t.id ? '' : t.id)}>{t.name}</button>
              ))}
            </div>
          </div>
        )}
      </aside>

      <section className="list" aria-label="Threads">
        <div className="list-head">
          <h1>{title}</h1>
          <span className="muted small">{shown.length} {shown.length === 1 ? 'conversation' : 'conversations'}</span>
        </div>
        <div className="list-search">
          <label className="sr-only" htmlFor="list-q">Search this list</label>
          <input id="list-q" type="search" placeholder="Search this list" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {error && <p className="error pad" role="alert">{error}</p>}
        {inbox && mailChannels.length === 0 && (
          <div className="empty">
            <strong>No mailbox connected</strong>
            <p className="muted">Connect Gmail, Outlook, Slack or Teams under Accounts. The last 14 days are imported first.</p>
          </div>
        )}
        {shown.map((t) => (
          <button key={t.id} className={`row-item ${t.unread ? 'unread' : ''} ${open?.id === t.id ? 'selected' : ''}`} onClick={() => openById(t.id, t.unread)}>
            <span className="between"><strong>{who(t.last_sender)}</strong><time className="muted small">{new Date(t.last_message_at).toLocaleDateString()}</time></span>
            <span className="subject">{t.subject || '(no subject)'} {t.message_count > 1 && <span className="muted small">({t.message_count})</span>}</span>
            <span className="muted small clip">{t.snippet}</span>
            <span className="chips">
              <span className="chip tag">{CHANNEL_LABEL[t.channel] ?? t.channel}</span>
              {t.priority && (t.priority === 'urgent' || t.priority === 'needs_reply') && <span className={`chip ${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>}
              {t.topics.map((tp) => <span key={tp.id} className="chip">{tp.name}</span>)}
            </span>
          </button>
        ))}
        {mailChannels.length > 0 && shown.length === 0 && <p className="muted pad">{unreadOnly || priority || topicId || needle ? 'No conversations match these filters.' : 'Nothing here yet. The first import can take a minute.'}</p>}
        {next && <button className="more" onClick={async () => { const r = await api<{ threads: ThreadRow[]; nextBefore: string | null }>(query(next)); setThreads((p) => [...p, ...r.threads]); setNext(r.nextBefore); }}>Load older</button>}
      </section>

      <section className="reader" aria-label="Message">
        {!open && (
          <div className="empty center-empty">
            <strong>Select a conversation</strong>
            <p className="muted">Its summary, action items and a reply draft appear here.</p>
          </div>
        )}
        {open && <Reader key={open.id} thread={open} onChanged={() => openById(open.id)} />}
      </section>
    </div>
  );
}

function Reader({ thread, onChanged }: { thread: ThreadDetail; onChanged: () => void }) {
  const [summary, setSummary] = useState<{ text: string; cached: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function summarize(refresh = false) {
    setBusy(true); setNote('');
    try { setSummary(await api('/summaries', { method: 'POST', body: JSON.stringify({ scope: 'thread', threadId: thread.id, refresh }) })); }
    catch (e) { setNote(e instanceof ApiError && e.code === 'ai_consent_required' ? 'Turn on AI features under Accounts to summarize.' : (e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <header className="reader-head">
        <div className="chips">
          {thread.priority && <span className={`chip ${thread.priority}`}>{PRIORITY_LABEL[thread.priority]}</span>}
          {thread.topics.map((t) => <span key={t.id} className="chip">{t.name}</span>)}
          <span className="muted small">{thread.messages.length} {thread.messages.length === 1 ? 'message' : 'messages'}</span>
        </div>
        <h2>{thread.subject || '(no subject)'}</h2>
      </header>
      <div className="row" style={{ margin: '10px 0' }}>
        <button disabled={busy} onClick={() => summarize(false)}>{busy ? 'Summarizing…' : summary ? 'Summarize again' : 'Summarize'}</button>
        {summary && <button disabled={busy} onClick={() => summarize(true)}>Regenerate</button>}
      </div>
      {note && <p className="error" role="alert">{note}</p>}
      {summary && <div className="summary" aria-label="Summary"><span className="summary-head">Summary</span>{summary.text}</div>}
      {thread.action_items.length > 0 && (
        <ul className="actions" aria-label="Action items">
          <li className="eyebrow">Action items</li>
          {thread.action_items.map((a) => (
            <li key={a.id}>
              <label className="inline-check">
                <input type="checkbox" checked={a.status === 'done'} onChange={async (e) => { await api(`/action-items/${a.id}`, { method: 'PATCH', body: JSON.stringify({ done: e.target.checked }) }); onChanged(); }} />
                <span className={a.status === 'done' ? 'done' : ''}>{a.text}</span>
              </label>
              {a.due_at && <span className="muted small"> · due {new Date(a.due_at).toLocaleDateString()}</span>}
            </li>
          ))}
        </ul>
      )}
      {thread.messages.map((m) => <MessageView key={m.id} m={m} />)}
      <ReplyPanel threadId={thread.id} onSent={onChanged} />
    </>
  );
}

function MessageView({ m }: { m: Msg }) {
  const [showHtml, setShowHtml] = useState(!!m.body_html_sanitized);
  return (
    <article className="msg">
      <header className="msg-head">
        <span className="avatar" aria-hidden="true">{who(m.sender).slice(0, 1).toUpperCase()}</span>
        <div>
        <strong>{who(m.sender)}</strong> <span className="muted small">&lt;{m.sender?.email ?? m.sender?.handle}&gt;</span>
        <div className="muted small">To {m.recipients.to?.map(who).join(', ') || 'undisclosed'} · {new Date(m.timestamp).toLocaleString()}{m.direction === 'outbound' && ' · sent'}</div>
        </div>
      </header>
      {showHtml && m.body_html_sanitized ? <HtmlBody html={m.body_html_sanitized} /> : <pre className="plain">{m.body_text}</pre>}
      {m.body_html_sanitized && <button className="link" onClick={() => setShowHtml(!showHtml)}>{showHtml ? 'Show plain text' : 'Show formatted'}</button>}
      {m.attachments_meta.length > 0 && <div className="muted small">Attachments: {m.attachments_meta.map((a) => a.name).join(', ')}</div>}
    </article>
  );
}

/** Mail HTML is already sanitized server-side. The sandboxed frame without scripts and a deny-all CSP is a second layer. */
function HtmlBody({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const doc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#222;word-wrap:break-word}img{max-width:100%}blockquote{margin:0 0 0 8px;padding-left:8px;border-left:3px solid #ccc;color:#555}</style>${html}`;
  return (
    <iframe
      ref={ref}
      title="Message body"
      className="mailframe"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      onLoad={() => { const d = ref.current?.contentDocument; if (d && ref.current) ref.current.style.height = `${d.documentElement.scrollHeight + 8}px`; }}
    />
  );
}
