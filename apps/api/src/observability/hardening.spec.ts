import { INestApplication, Controller, Get, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { Db } from '../db/db.service';
import { sanitizeMailHtml, htmlToText } from '../connectors/text';
import { MetricsService } from './metrics.service';
import { MetricsController, RequestObservability } from './observability.module';

describe('mail HTML sanitizer (XSS corpus)', () => {
  // Classic and recent vectors, including the advisory classes fixed by sanitize-html 2.18: scheme checks on odd attributes,
  // SVG animation URI lists, and mutation XSS through textarea / noscript / math.
  const vectors = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="  JaVaScRiPt:alert(1)">x</a>',
    '<a href="jav&#x09;ascript:alert(1)">x</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">go</button></form>',
    '<svg><animate attributeName="href" values="javascript:alert(1)"/><a><text>x</text></a></svg>',
    '<svg onload=alert(1)>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<textarea></textarea/><img src=x onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<style>@import "https://evil.example/x.css";</style>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<base href="javascript:alert(1)//">',
    '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
    '<img src="https://tracker.example/pixel.gif">',
    '<link rel=stylesheet href="https://evil.example/x.css">',
    '<td background="javascript:alert(1)">x</td>',
    '<video poster="javascript:alert(1)"><source src="x"></video>',
  ];
  const BAD = /<\s*(script|svg|iframe|object|embed|style|form|button|textarea|noscript|math|meta|base|link|video)\b|\son\w+\s*=|javascript:|vbscript:|data:text|formaction|poster=|background=|<img[^>]+src="(?!data:image)/i;

  it.each(vectors)('neutralizes %s', (v) => {
    const out = sanitizeMailHtml(v);
    expect(out).not.toMatch(BAD);
  });

  it('keeps ordinary mail formatting and inline raster images, and forces safe link attributes', () => {
    const out = sanitizeMailHtml('<p>Hi <b>there</b> <a href="https://x.test/a">link</a></p><img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(out).toContain('<b>there</b>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('data:image/png;base64');
  });

  it('plain-text conversion never yields markup that is later rendered as HTML by this app', () => {
    expect(htmlToText('<p>a &lt;script&gt;x&lt;/script&gt;</p>')).toBe('a <script>x</script>'); // text only: the web client renders it in <pre> as text
  });
});

describe('request ids, access logs and the metrics endpoint', () => {
  let app: INestApplication;
  let url: string;
  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);

  @Controller('things')
  class ThingsController {
    @Get(':id') get() { return { ok: true }; }
  }

  @Module({ controllers: [ThingsController, MetricsController], providers: [MetricsService, RequestObservability, { provide: ENV, useValue: { METRICS_TOKEN: 'a-long-metrics-token' } }, { provide: Db, useValue: { system: async () => ({ rows: [{ channel: 'gmail', status: 'active', n: '2', oldest_sync_age_s: 90 }] }) } }] })
  class TestModule implements NestModule {
    configure(c: MiddlewareConsumer) { c.apply(RequestObservability).forRoutes('*'); }
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = mod.createNestApplication();
    await app.listen(0);
    url = (await app.getUrl()).replace('[::1]', 'localhost');
    process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  });
  afterAll(async () => { process.stdout.write = realWrite; await app.close(); });

  it('echoes a valid inbound request id, replaces a malformed one, and logs route patterns without ids or query strings', async () => {
    const good = await fetch(`${url}/things/7f2b?token=SECRET`, { headers: { 'x-request-id': 'req-abcdef123456' } });
    expect(good.headers.get('x-request-id')).toBe('req-abcdef123456');
    const bad = await fetch(`${url}/things/1`, { headers: { 'x-request-id': 'bad id with spaces\tand junk' } });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    await new Promise((r) => setTimeout(r, 20));
    const log = writes.join('');
    expect(log).toContain('"route":"/things/:id"');
    expect(log).toContain('"reqId":"req-abcdef123456"');
    expect(log).not.toContain('SECRET');
    expect(log).not.toContain('7f2b');
  });

  it('serves Prometheus metrics only with the bearer token, with low-cardinality labels', async () => {
    expect((await fetch(`${url}/metrics`)).status).toBe(401);
    expect((await fetch(`${url}/metrics`, { headers: { authorization: 'Bearer wrong-wrong-wrong-wrong' } })).status).toBe(401);
    const ok = await fetch(`${url}/metrics`, { headers: { authorization: 'Bearer a-long-metrics-token' } });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).toContain('inbox_http_request_duration_seconds_bucket');
    expect(text).toContain('route="/things/:id"');
    expect(text).not.toContain('7f2b');
    expect(text).toContain('inbox_accounts{channel="gmail",status="active"} 2');
    expect(text).toContain('inbox_oldest_sync_age_seconds 90');
  });
});

describe('metrics are off by default', () => {
  it('returns 404 when no token is configured', async () => {
    const mod = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [MetricsService, { provide: ENV, useValue: {} }, { provide: Db, useValue: {} }],
    }).compile();
    const app = mod.createNestApplication();
    await app.listen(0);
    const url = (await app.getUrl()).replace('[::1]', 'localhost');
    expect((await fetch(`${url}/metrics`)).status).toBe(404);
    await app.close();
  });
});
