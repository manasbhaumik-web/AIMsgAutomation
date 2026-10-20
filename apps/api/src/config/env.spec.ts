import { loadEnv } from './env';

const good = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://inbox_app:Zk3pQ9vLmN2xR7tY@db:5432/inbox',
  DATABASE_ADMIN_URL: 'postgres://inbox_owner:Hq8wB4nVcD6sF1jA@db:5432/inbox',
  JWT_SECRET: 'q7Hk2VnX9pLw4RtB8mZc1YfG6sJd3AeU',
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  WEB_URL: 'https://inbox.example.org',
  PUBLIC_API_URL: 'https://inbox.example.org',
  REDIS_URL: 'redis://:pw@redis:6379',
} as NodeJS.ProcessEnv;
const bad = (over: Record<string, string | undefined>) => () => loadEnv({ ...good, ...over } as NodeJS.ProcessEnv);

describe('production configuration is validated at startup', () => {
  it('accepts a sound configuration', () => {
    expect(loadEnv(good).TRUST_PROXY).toBe(0);
  });
  it('refuses placeholder or weak secrets', () => {
    expect(bad({ JWT_SECRET: 'change-me-change-me-change-me-change-me' })).toThrow(/JWT_SECRET/);
    expect(bad({ JWT_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow(/JWT_SECRET/);
  });
  it('refuses to run the API as the table owner, which would switch row-level security off in effect', () => {
    expect(bad({ DATABASE_URL: good.DATABASE_ADMIN_URL })).toThrow(/restricted runtime role/);
  });
  it('refuses development database passwords, plain-http origins and a missing queue', () => {
    expect(bad({ DATABASE_URL: 'postgres://inbox_app:inbox_app_dev@db:5432/inbox' })).toThrow(/development password/);
    expect(bad({ WEB_URL: 'http://inbox.example.org' })).toThrow(/https/);
    expect(bad({ PUBLIC_API_URL: 'http://inbox.example.org' })).toThrow(/https/);
    expect(bad({ REDIS_URL: undefined })).toThrow(/REDIS_URL/);
  });
  it('does not apply those rules in development or test', () => {
    expect(() => loadEnv({ ...good, NODE_ENV: 'development', JWT_SECRET: 'change-me-change-me-change-me-change-me', WEB_URL: 'http://localhost:5173', REDIS_URL: undefined } as NodeJS.ProcessEnv)).not.toThrow();
  });
  it('clamps retention to safe minimums', () => {
    expect(bad({ RETAIN_AUDIT_DAYS: '10' })).toThrow();
    expect(loadEnv({ ...good, RETAIN_AUDIT_DAYS: '730' }).RETAIN_AUDIT_DAYS).toBe(730);
  });
});
