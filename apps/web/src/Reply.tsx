import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { CHANNEL_LABEL } from './Connections';

interface Party { name?: string; email?: string; handle?: string }
export interface Draft {
  id: string; threadId: string; channel: string; body: string; bodyHash: string; source: 'ai' | 'user'; status: string; error: string | null;
  stale: boolean; canSend: boolean; blockedReason: string | null; to: Party[]; accountLabel: string;
}

const label = (p: Party) => [p.name, p.email ?? p.handle].filter(Boolean).join(' · ') || 'Unknown';

/**
 * Reply box. The assistant can only fill the text area; nothing leaves until the person reads the exact text in the
 * confirmation step and presses "Send now". The server checks the hash of that text again.
 */
export function ReplyPanel({ threadId, onSent }: { threadId: string; onSent: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [guidance, setGuidance] = useState('');
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Draft | null>(null);
  const [ackNew, setAckNew] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ draft: Draft | null }>(`/threads/${threadId}/draft`);
      setDraft(r.draft); setText(r.draft?.body ?? ''); setOpen(!!r.draft);
    } catch (e) { setError((e as Error).message); }
  }, [threadId]);
  useEffect(() => { void load(); }, [load]);

  const fail = (e: unknown) => setError(e instanceof ApiError && e.code === 'ai_consent_required' ? 'Turn on AI features under Accounts to let the assistant draft replies.' : (e as Error).message);

  async function aiDraft() {
    setBusy('ai'); setError('');
    try { const r = await api<{ draft: Draft }>(`/threads/${threadId}/draft/ai`, { method: 'POST', body: JSON.stringify({ instructions: guidance || undefined }) }); setDraft(r.draft); setText(r.draft.body); setOpen(true); }
    catch (e) { fail(e); } finally { setBusy(''); }
  }
  async function save(): Promise<Draft | null> {
    try { const r = await api<{ draft: Draft }>(`/threads/${threadId}/draft`, { method: 'PUT', body: JSON.stringify({ body: text }) }); setDraft(r.draft); return r.draft; }
    catch (e) { fail(e); return null; }
  }
  async function startReview() {
    setBusy('save'); setError('');
    const d = await save();
    setBusy('');
    if (d) { setAckNew(false); setReview(d); }
  }
  async function discard() {
    try { await api(`/threads/${threadId}/draft`, { method: 'DELETE' }); setDraft(null); setText(''); setOpen(false); setReview(null); } catch (e) { fail(e); }
  }
  async function send() {
    if (!review) return;
    setBusy('send'); setError('');
    try {
      await api(`/drafts/${review.id}/send`, { method: 'POST', body: JSON.stringify({ confirm: true, bodyHash: review.bodyHash, acceptNewMessages: ackNew }) });
      setReview(null); setDraft(null); setText(''); setOpen(false); setSent(true); onSent();
    } catch (e) { fail(e); setReview(null); void load(); } finally { setBusy(''); }
  }

  if (sent) return <p role="status" className="notice">Reply sent. <button className="link" onClick={() => setSent(false)}>Write another</button></p>;
  return (
    <section className="reply" aria-label="Reply">
      {error && <p className="error" role="alert">{error}</p>}
      {!open && (
        <div className="row">
          <button onClick={() => setOpen(true)}>Reply</button>
          <input aria-label="Guidance for the assistant" placeholder="Optional: what to say (e.g. decline politely)" value={guidance} onChange={(e) => setGuidance(e.target.value)} maxLength={500} />
          <button disabled={busy === 'ai'} onClick={aiDraft}>{busy === 'ai' ? 'Drafting…' : 'Draft with assistant'}</button>
        </div>
      )}
      {open && (
        <>
          {draft?.source === 'ai' && <p className="muted small">Written by the assistant. Check every detail before sending.</p>}
          {draft?.stale && <p className="error" role="alert">A newer message arrived after this draft was written.</p>}
          {draft && !draft.canSend && <p className="muted small">{draft.blockedReason}</p>}
          {draft?.status === 'failed' && <p className="error" role="alert">Not sent: {draft.error}</p>}
          <textarea aria-label="Reply text" rows={6} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%' }} />
          <div className="row">
            <button className="primary" disabled={!text.trim() || busy !== '' || (draft !== null && !draft.canSend)} onClick={startReview}>Review and send…</button>
            <button disabled={busy === 'ai'} onClick={aiDraft}>{draft?.source === 'ai' ? 'Redraft' : 'Draft with assistant'}</button>
            <button onClick={draft ? discard : () => setOpen(false)}>{draft ? 'Discard draft' : 'Cancel'}</button>
          </div>
        </>
      )}
      {review && (
        <div className="confirm" role="alertdialog" aria-label="Confirm sending" aria-describedby="confirm-text">
          <p><strong>Send this reply?</strong> It goes out now and cannot be recalled.</p>
          <dl className="facts">
            <dt>Channel</dt><dd>{CHANNEL_LABEL[review.channel] ?? review.channel} · {review.accountLabel}</dd>
            <dt>To</dt><dd>{review.to.map(label).join(', ') || 'unknown'}</dd>
          </dl>
          <pre id="confirm-text" className="plain">{review.body}</pre>
          {review.stale && <label className="inline-check"><input type="checkbox" checked={ackNew} onChange={(e) => setAckNew(e.target.checked)} /> I have read the newer message</label>}
          <div className="row">
            <button className="primary" disabled={busy === 'send' || (review.stale && !ackNew)} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send now'}</button>
            <button onClick={() => setReview(null)}>Back to editing</button>
          </div>
        </div>
      )}
    </section>
  );
}
