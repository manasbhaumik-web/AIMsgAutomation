import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import { MetricsService } from './metrics.service';

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Dashboards and alerts that reference a metric that no longer exists fail silently in production, so check them here. */
describe('operations files stay in sync with the code', () => {
  const known = new Set<string>();

  beforeAll(async () => {
    const m = new MetricsService();
    m.accounts.set({ channel: 'gmail', status: 'active' }, 1);
    for (const x of await m.registry.getMetricsAsJSON()) known.add(x.name);
  });

  const referenced = (text: string) =>
    [...new Set([...text.matchAll(/\binbox_[a-z0-9_]+/g)].map((x) => x[0].replace(/_(bucket|count|sum)$/, '')))];

  it('alert rules only use metrics the API exports', () => {
    const missing = referenced(read('ops/alerts.yml')).filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });

  it('the Grafana dashboard only uses metrics the API exports', () => {
    const missing = referenced(read('ops/grafana/dashboards/inbox-overview.json')).filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });

  it('the ops and deploy YAML files parse, and the production stack never runs the API as the database owner', () => {
    for (const f of ['ops/prometheus.yml', 'ops/alerts.yml', 'ops/grafana/provisioning/datasources/prometheus.yml', 'ops/grafana/provisioning/dashboards/inbox.yml']) expect(() => parse(read(f))).not.toThrow();
    const compose = parse(read('deploy/docker-compose.prod.yml')) as { services: Record<string, { environment?: Record<string, string>; ports?: string[]; read_only?: boolean; cap_drop?: string[] }> };
    expect(compose.services.api.environment!.DATABASE_URL).toContain('inbox_app:');
    expect(compose.services.api.environment!.DATABASE_URL).not.toContain('inbox_owner');
    for (const s of ['api', 'web']) {
      expect(compose.services[s].read_only).toBe(true);
      expect(compose.services[s].cap_drop).toEqual(['ALL']);
    }
    // Only the web tier is published; Postgres and Redis are never exposed.
    expect(compose.services.postgres.ports).toBeUndefined();
    expect(compose.services.redis.ports).toBeUndefined();
    expect(compose.services.api.ports).toBeUndefined();
  });

  it('CI, release and dependency-update workflows are valid YAML and keep permissions minimal', () => {
    for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/dependabot.yml']) expect(() => parse(read(f))).not.toThrow();
    const ci = parse(read('.github/workflows/ci.yml')) as { permissions: Record<string, string>; jobs: Record<string, unknown> };
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(ci.jobs)).toEqual(expect.arrayContaining(['test', 'supply-chain', 'images']));
    const release = parse(read('.github/workflows/release.yml')) as { on: { push: { tags: string[] } } };
    expect(release.on.push.tags).toEqual(['v*.*.*']); // releases happen on tags only, never on a branch push
  });

  it('every alert has a severity and a summary', () => {
    const doc = parse(read('ops/alerts.yml')) as { groups: { rules: { alert: string; labels: { severity: string }; annotations: { summary: string } }[] }[] };
    const rules = doc.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThanOrEqual(8);
    for (const r of rules) {
      expect(r.labels.severity).toMatch(/^(page|warn|info)$/);
      expect(r.annotations.summary.length).toBeGreaterThan(10);
    }
  });

  it('the dashboard JSON is well formed', () => {
    const d = JSON.parse(read('ops/grafana/dashboards/inbox-overview.json')) as { panels: { targets: { expr: string }[] }[] };
    expect(d.panels.length).toBeGreaterThanOrEqual(12);
    for (const p of d.panels) expect(p.targets[0].expr.length).toBeGreaterThan(5);
  });
});
