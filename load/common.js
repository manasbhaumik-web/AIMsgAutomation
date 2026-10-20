import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE = __ENV.BASE_URL || 'http://localhost:3000/api/v1';
export const PASSWORD = __ENV.LOAD_PASSWORD || 'LoadTest-Pass-123';
export const USERS = Number(__ENV.LOAD_USERS || 200);

/** Each virtual user signs in as its own seeded user, so cross-user caching or leakage would show up as errors. */
export function login(vu) {
  const email = `loaduser${(vu - 1) % USERS}@load.test`;
  const r = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: PASSWORD, deviceName: 'k6' }), { headers: { 'content-type': 'application/json' }, tags: { name: 'login' } });
  if (!check(r, { 'login ok': (x) => x.status === 200 })) fail(`login failed for ${email}: ${r.status}`);
  return { token: r.json('accessToken'), email };
}

export const auth = (token) => ({ headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
