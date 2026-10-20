import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { parse } from 'yaml';
import { IS_PUBLIC } from '../auth/guards';

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];
const HTTP = ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head'];
const SRC = resolve(__dirname, '..');

interface Route { key: string; isPublic: boolean }

/** Every route the controllers really expose, read from Nest's own metadata. */
function codeRoutes(): Route[] {
  const out: Route[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.controller\.ts$/.test(f)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(p) as Record<string, unknown>;
        for (const C of Object.values(mod)) {
          if (typeof C !== 'function') continue;
          const base = Reflect.getMetadata(PATH_METADATA, C) as string | undefined;
          if (base === undefined) continue;
          const classPublic = Reflect.getMetadata(IS_PUBLIC, C) === true;
          for (const name of Object.getOwnPropertyNames(C.prototype)) {
            const h = C.prototype[name] as object;
            const m = Reflect.getMetadata(METHOD_METADATA, h) as number | undefined;
            if (m === undefined) continue;
            const sub = (Reflect.getMetadata(PATH_METADATA, h) as string) ?? '';
            const path = `/${[base, sub].filter((x) => x && x !== '/').join('/')}`.replace(/\/+/g, '/').replace(/:([A-Za-z]+)/g, '{$1}');
            out.push({ key: `${HTTP[m]} ${path}`, isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, h) === true });
          }
        }
      }
    }
  };
  walk(SRC);
  return out;
}

const spec = parse(readFileSync(resolve(__dirname, '../../openapi/openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, { security?: unknown[]; responses?: Record<string, unknown>; operationId?: string; parameters?: { name: string; in: string }[] }>>;
  components: { schemas: Record<string, unknown> };
};

const specRoutes = Object.entries(spec.paths).flatMap(([path, ops]) =>
  Object.entries(ops).filter(([m]) => METHODS.includes(m)).map(([m, op]) => ({ key: `${m} ${path}`, isPublic: Array.isArray(op.security) && op.security.length === 0, op, path })),
);

describe('OpenAPI contract matches the code', () => {
  const code = codeRoutes().filter((r) => !r.key.includes('/webhooks/'));

  it('actually found the routes (guards against a vacuous pass)', () => {
    expect(code.length).toBeGreaterThan(60);
    expect(code.filter((r) => r.isPublic).length).toBeGreaterThanOrEqual(7);
    expect(specRoutes.length).toBe(code.length);
  });

  it('documents every client-facing route', () => {
    const documented = new Set(specRoutes.map((r) => r.key));
    expect(code.filter((r) => !documented.has(r.key)).map((r) => r.key)).toEqual([]);
  });

  it('documents no route that does not exist', () => {
    const real = new Set(code.map((r) => r.key));
    expect(specRoutes.filter((r) => !real.has(r.key)).map((r) => r.key)).toEqual([]);
  });

  it('marks exactly the @Public routes as unauthenticated, and everything else as requiring a bearer token', () => {
    const pub = (list: { key: string; isPublic: boolean }[]) => list.filter((r) => r.isPublic).map((r) => r.key).sort();
    expect(pub(specRoutes)).toEqual(pub(code));
  });

  it('declares every path parameter and has a response for every operation', () => {
    for (const r of specRoutes) {
      const inPath = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = (r.op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
      const viaRef = JSON.stringify(r.op).includes('#/components/parameters/Id');
      for (const p of inPath) expect(declared.includes(p) || (p === 'id' && viaRef)).toBe(true);
      expect(Object.keys(r.op.responses ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('resolves every $ref', () => {
    const text = readFileSync(resolve(__dirname, '../../openapi/openapi.yaml'), 'utf8');
    const refs = [...text.matchAll(/'#\/components\/(\w+)\/(\w+)'/g)];
    const doc = spec as unknown as { components: Record<string, Record<string, unknown>> };
    for (const [, section, name] of refs) expect(doc.components[section]?.[name]).toBeDefined();
  });
});
