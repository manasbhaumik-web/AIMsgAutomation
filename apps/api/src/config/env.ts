import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Reverse proxies in front of the API (nginx = 1). Without it every client shares the proxy's address for rate limiting. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  PORT: z.coerce.number().default(3000),
  /** Database connections per API instance. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  WEB_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  MASTER_KEY: z.string().min(1, 'MASTER_KEY (base64, 32 bytes) is required'),
  /** Comma-separated older master keys, kept only while rotating: they can unwrap but never wrap. */
  MASTER_KEY_PREVIOUS: z.string().optional(),
  OIDC_REDIRECT_URIS: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  // Channel connections (separate from sign-in redirects)
  CONNECT_REDIRECT_URIS: z.string().default(''),
  /** Public HTTPS base of this API. Without it webhooks are not registered and sync relies on polling. */
  PUBLIC_API_URL: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  /** Verifies Events API requests. Without it Slack syncs by polling only. */
  SLACK_SIGNING_SECRET: z.string().optional(),
  WHATSAPP_APP_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  /** Facebook Login for Business configuration (Embedded Signup) that requests the WhatsApp permissions. */
  WHATSAPP_CONFIG_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  /** LinkedIn is a profile-only stub (no inbox API for ordinary apps). Off unless enabled. */
  LINKEDIN_ENABLED: z.enum(['true', 'false']).default('false'),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  /** Mobile push through Firebase Cloud Messaging (covers Android and, via APNs relay, iOS). Without both, push is off and the in-app feed still works. */
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Enables GET /api/v1/metrics (Prometheus) behind this bearer token. Unset = endpoint disabled. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Retention sweep ages in days. Message retention is per tenant (tenants.retention_days), set by the tenant admin. */
  RETAIN_SESSIONS_DAYS: z.coerce.number().int().min(1).default(7),
  RETAIN_NOTIFICATIONS_DAYS: z.coerce.number().int().min(7).default(90),
  RETAIN_WEBHOOK_INBOX_DAYS: z.coerce.number().int().min(1).default(7),
  RETAIN_DRAFTS_DAYS: z.coerce.number().int().min(1).default(30),
  RETAIN_AUDIT_DAYS: z.coerce.number().int().min(90).default(400),
  RETAIN_USAGE_DAYS: z.coerce.number().int().min(30).default(400),
  GOOGLE_PUBSUB_TOPIC: z.string().optional(),
  GOOGLE_PUBSUB_AUDIENCE: z.string().optional(),
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: z.string().optional(),
  /** Without Redis, jobs run in-process (fine for development, not for several instances). */
  REDIS_URL: z.string().optional(),
  WORKERS_ENABLED: z.enum(['true', 'false']).default('true'),
}).superRefine((e, ctx) => {
  if (e.NODE_ENV !== 'production') return;
  const bad = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  // Misconfigurations that would silently weaken the security model are refused at startup, not logged.
  if (/change-?me|example|secret|password/i.test(e.JWT_SECRET)) bad('JWT_SECRET', 'looks like a placeholder; generate a random value');
  if (new Set(e.JWT_SECRET).size < 10) bad('JWT_SECRET', 'is not random enough');
  if (!e.WEB_URL.startsWith('https://')) bad('WEB_URL', 'must be an https:// origin in production');
  if (/inbox_app_dev|inbox_owner_dev/.test(e.DATABASE_URL) || /inbox_owner_dev/.test(e.DATABASE_ADMIN_URL ?? '')) bad('DATABASE_URL', 'uses a development password');
  try {
    const app = new URL(e.DATABASE_URL).username;
    const owner = e.DATABASE_ADMIN_URL ? new URL(e.DATABASE_ADMIN_URL).username : null;
    if (owner && app === owner) bad('DATABASE_URL', 'must use the restricted runtime role, not the table owner (row-level security would not apply)');
  } catch {
    bad('DATABASE_URL', 'is not a valid URL');
  }
  if (e.PUBLIC_API_URL && !e.PUBLIC_API_URL.startsWith('https://')) bad('PUBLIC_API_URL', 'must be https:// so providers will deliver webhooks');
  if (e.WORKERS_ENABLED === 'true' && !e.REDIS_URL) bad('REDIS_URL', 'is required in production: the in-process queue loses jobs on restart and cannot be shared by instances');
});

export type Env = z.infer<typeof schema>;
export const ENV = Symbol('ENV');

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return parsed.data;
}
