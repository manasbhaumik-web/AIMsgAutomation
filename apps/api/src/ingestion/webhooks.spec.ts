import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { SlackConnector } from '../connectors/slack.connector';
import { ConnectorRegistry } from '../connectors/registry';
import { WhatsAppConnector } from '../connectors/whatsapp.connector';
import { CryptoService } from '../crypto/crypto.service';
import { Db } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { MetricsService } from '../observability/metrics.service';
import { SubscriptionService } from './subscription.service';
import { WebhooksController } from './webhooks.controller';

/** Real HTTP: proves signatures are checked over the exact bytes received (Nest must keep the raw body). */
describe('webhook endpoints over HTTP', () => {
  let app: INestApplication;
  let url: string;
  const queued: string[] = [];
  const stored: string[] = [];
  const registry = new ConnectorRegistry({} as never);

  beforeAll(async () => {
    registry.register(new SlackConnector({ clientId: 'c', clientSecret: 's', signingSecret: 'sk' }));
    registry.register(new WhatsAppConnector({ appId: 'a', appSecret: 'ws', configId: 'c', verifyToken: 'vt', version: 'v21.0' }));
    const db = {
      system: async (fn: (c: { query: (sql: string, p: unknown[]) => Promise<{ rows: { id: string }[] }> }) => unknown) =>
        fn({ query: async (sql: string, p: unknown[]) => { if (sql.includes('sys_push_webhook_event')) stored.push(String(p[0])); return { rows: sql.includes('sys_find') ? [{ id: 'acct-1' }] : [] }; } }),
    };
    const mod = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: ConnectorRegistry, useValue: registry },
        { provide: Db, useValue: db },
        { provide: JobsService, useValue: { enqueueSync: async (id: string) => { queued.push(id); } } },
        { provide: SubscriptionService, useValue: { verifyClientState: () => false } },
        { provide: MetricsService, useValue: new MetricsService() },
        { provide: CryptoService, useValue: { encrypt: (s: string) => Buffer.from(s) } },
      ],
    }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.listen(0);
    url = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());
  beforeEach(() => { queued.length = 0; stored.length = 0; });

  // Deliberately not JSON.stringify output: spacing and key order that a re-serializer would change.
  const rawSlack = '{ "type": "event_callback",\n  "team_id": "T1", "event": {"type": "message"} }';
  const slackHeaders = (raw: string, ts = String(Math.floor(Date.now() / 1000))) => ({
    'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', 'sk').update(`v0:${ts}:${raw}`).digest('hex')}`,
  });

  it('accepts a Slack request signed over the exact bytes, even when they are not canonical JSON', async () => {
    const res = await fetch(`${url}/webhooks/slack`, { method: 'POST', headers: slackHeaders(rawSlack), body: rawSlack });
    expect(res.status).toBe(200);
    expect(queued).toEqual(['acct-1']);
  });

  it('rejects a Slack body changed after signing', async () => {
    const res = await fetch(`${url}/webhooks/slack`, { method: 'POST', headers: slackHeaders(rawSlack), body: rawSlack.replace('T1', 'T2') });
    expect(res.status).toBe(401);
    expect(queued).toEqual([]);
  });

  it('answers the Slack URL verification as plain text', async () => {
    const raw = '{"type":"url_verification","challenge":"xyz"}';
    const res = await fetch(`${url}/webhooks/slack`, { method: 'POST', headers: slackHeaders(raw), body: raw });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('xyz');
  });

  it('stores WhatsApp content before answering and rejects an unsigned or wrongly signed POST', async () => {
    const raw = '{ "object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"PN1"},"messages":[{"id":"w1","from":"1","timestamp":"1","type":"text","text":{"body":"hi"}}]}}]}] }';
    const sig = `sha256=${createHmac('sha256', 'ws').update(raw).digest('hex')}`;
    const ok = await fetch(`${url}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
    expect(ok.status).toBe(200);
    expect(stored).toEqual(['acct-1']);
    expect(queued).toEqual(['acct-1']);
    stored.length = 0;
    expect((await fetch(`${url}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status).toBe(401);
    expect((await fetch(`${url}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: raw })).status).toBe(401);
    expect(stored).toEqual([]);
  });

  it('serves the Meta handshake only for the right verify token', async () => {
    const good = await fetch(`${url}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
    expect(good.status).toBe(200);
    expect(await good.text()).toBe('42');
    expect((await fetch(`${url}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=42`)).status).toBe(403);
  });
});
