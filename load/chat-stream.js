// Concurrent assistant conversations (Server-Sent Events). Needs AI routes configured (use a stub or a cheap model).
// Measures time to the first byte and that every stream finishes with a done event.
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE, auth, login } from './common.js';

const firstByte = new Trend('chat_first_byte', true);

export const options = {
  scenarios: { chat: { executor: 'constant-vus', vus: Number(__ENV.CHAT_VUS || 20), duration: '3m' } },
  thresholds: { chat_first_byte: ['p(95)<3000'], checks: ['rate>0.98'] },
};

export default function () {
  const me = login(__VU);
  const p = auth(me.token);
  http.put(`${BASE}/me/consents`, JSON.stringify({ aiProcessing: true }), p);
  const conv = http.post(`${BASE}/chat/conversations`, '{}', p).json('id');
  const r = http.post(`${BASE}/chat/conversations/${conv}/messages`, JSON.stringify({ content: 'What needs my reply this week?' }), { ...p, timeout: '60s' });
  firstByte.add(r.timings.waiting);
  check(r, { 'stream ok': (x) => x.status === 200, 'has done event': (x) => String(x.body).includes('event: done') });
}
