import { useEffect, useState } from 'react';
import { api } from './api';
import { Activity } from './Activity';
import { Approvals } from './Approvals';
import { Reports } from './Reports';
import { Workflows } from './Workflows';

type Tab = 'approvals' | 'workflows' | 'reports' | 'activity';

/** Everything that acts for you, in one place: what is waiting, the rules, the files, and the record. */
export function Automations({ initial = 'workflows' }: { initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    api<{ id: string }[]>('/approvals?status=pending').then((r) => setPending(r.length)).catch(() => undefined);
  }, [tab]);

  return (
    <div className="auto-shell">
      <nav className="tabs sub" aria-label="Automations">
        {([['approvals', 'Approvals'], ['workflows', 'Workflows'], ['reports', 'Reports'], ['activity', 'Activity']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            {label}{id === 'approvals' && pending > 0 && <span className="badge">{pending}</span>}
          </button>
        ))}
      </nav>
      {tab === 'approvals' && <Approvals onChange={setPending} />}
      {tab === 'workflows' && <Workflows onGoApprovals={() => setTab('approvals')} />}
      {tab === 'reports' && <Reports />}
      {tab === 'activity' && <Activity />}
    </div>
  );
}
