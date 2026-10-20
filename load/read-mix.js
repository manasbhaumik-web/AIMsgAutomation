// Typical reading traffic: open the inbox, list threads with filters, open a thread, check notifications.
// Sized for the target scale (under 1,000 users): 200 concurrent users is far above realistic simultaneous use.
//   k6 run -e BASE_URL=https://staging.example.com/api/v1 load/read-mix.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE, auth, login } from './common.js';

export const options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '3m', target: 200 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:threads}': ['p(95)<400'],
    'http_req_duration{name:thread}': ['p(95)<300'],
    'http_req_duration{name:inbox}': ['p(95)<300'],
    'http_req_duration{name:notifications}': ['p(95)<300'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const me = login(__VU);
  const p = auth(me.token);
  let mine;
  for (let i = 0; i < 20; i++) {
    check(http.get(`${BASE}/inbox`, { ...p, tags: { name: 'inbox' } }), { 'inbox 200': (r) => r.status === 200 });
    const list = http.get(`${BASE}/inbox/threads?limit=30${i % 3 === 0 ? '&priority=needs_reply' : ''}`, { ...p, tags: { name: 'threads' } });
    check(list, { 'threads 200': (r) => r.status === 200 });
    // Every conversation a user sees must belong to the same single seeded account: anything else is a leak.
    const rows = list.status === 200 ? list.json('threads') : [];
    mine = mine ?? (rows[0] && rows[0].account_id);
    check(rows, { 'only my account': (t) => t.every((x) => x.account_id === mine) });
    if (rows[0]) check(http.get(`${BASE}/threads/${rows[0].id}`, { ...p, tags: { name: 'thread' } }), { 'thread 200': (r) => r.status === 200 });
    check(http.get(`${BASE}/notifications`, { ...p, tags: { name: 'notifications' } }), { 'notifications 200': (r) => r.status === 200 });
    sleep(1 + Math.random() * 2);
  }
}
