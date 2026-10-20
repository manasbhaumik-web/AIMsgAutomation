import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. Labels are small fixed sets (route patterns, channel names, task names, outcomes); nothing
 * user-supplied (ids, addresses, subjects, query strings) is ever used as a label value.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly http = new Histogram({
    name: 'inbox_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30], registers: [this.registry],
  });
  readonly jobs = new Counter({ name: 'inbox_jobs_total', help: 'Background jobs by outcome', labelNames: ['job', 'result'] as const, registers: [this.registry] });
  readonly jobSeconds = new Histogram({ name: 'inbox_job_duration_seconds', help: 'Background job duration', labelNames: ['job'] as const, buckets: [0.1, 0.5, 1, 5, 15, 60, 300], registers: [this.registry] });
  readonly llmCalls = new Counter({ name: 'inbox_llm_calls_total', help: 'LLM gateway calls', labelNames: ['task', 'provider', 'ok'] as const, registers: [this.registry] });
  readonly llmTokens = new Counter({ name: 'inbox_llm_tokens_total', help: 'LLM tokens', labelNames: ['task', 'provider', 'direction'] as const, registers: [this.registry] });
  readonly llmSeconds = new Histogram({ name: 'inbox_llm_latency_seconds', help: 'LLM call latency', labelNames: ['task', 'provider'] as const, buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60], registers: [this.registry] });
  readonly sends = new Counter({ name: 'inbox_replies_total', help: 'Confirmed reply sends by channel and outcome', labelNames: ['channel', 'result'] as const, registers: [this.registry] });
  readonly webhooks = new Counter({ name: 'inbox_webhooks_total', help: 'Webhook requests by channel and outcome (rejected = failed verification)', labelNames: ['channel', 'result'] as const, registers: [this.registry] });
  readonly purged = new Counter({ name: 'inbox_retention_deleted_total', help: 'Rows deleted by the retention sweep', labelNames: ['kind'] as const, registers: [this.registry] });
  readonly accounts = new Gauge({ name: 'inbox_accounts', help: 'Connected accounts by channel and status', labelNames: ['channel', 'status'] as const, registers: [this.registry] });
  readonly syncLag = new Gauge({ name: 'inbox_oldest_sync_age_seconds', help: 'Age of the least recently synced active account', registers: [this.registry] });
  readonly queueDepth = new Gauge({ name: 'inbox_queue_jobs', help: 'Queued jobs by state (BullMQ only)', labelNames: ['state'] as const, registers: [this.registry] });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'inbox_node_' });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
