// Signed Slack webhooks arriving in bursts, plus forged ones. Measures verification and enqueue cost, and that forgeries are rejected fast.
// SLACK_SIGNING_SECRET must match the server. LOAD_TEAM may be any team id: unknown teams are accepted and dropped.
//   k6 run -e BASE_URL=... -e SLACK_SIGNING_SECRET=... load/webhook-burst.js
import crypto from 'k6/crypto';
import http from 'k6/http';
import { check } from 'k6';
import { BASE } from './common.js';

const SECRET = __ENV.SLACK_SIGNING_SECRET || 'slack-secret';

export const options = {
  scenarios: {
    burst: { executor: 'ramping-arrival-rate', startRate: 5, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 200, stages: [{ duration: '30s', target: 50 }, { duration: '1m', target: 100 }, { duration: '30s', target: 5 }] },
  },
  thresholds: { 'http_req_duration': ['p(95)<250'], checks: ['rate>0.99'] },
};

export default function () {
  const body = JSON.stringify({ type: 'event_callback', team_id: __ENV.LOAD_TEAM || 'TLOAD', event: { type: 'message' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.hmac('sha256', SECRET, `v0:${ts}:${body}`, 'hex');
  const headers = { 'content-type': 'application/json', 'x-slack-request-timestamp': ts };
  check(http.post(`${BASE}/webhooks/slack`, body, { headers: { ...headers, 'x-slack-signature': sig } }), { accepted: (r) => r.status === 200 });
  const forged = http.post(`${BASE}/webhooks/slack`, body, { headers: { ...headers, 'x-slack-signature': 'v0=00' }, responseCallback: http.expectedStatuses(401) });
  check(forged, { 'forged request rejected': (r) => r.status === 401 });
}
