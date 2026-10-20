import { FetchFn, ProviderAuthError, ProviderError } from './types';

/** Error messages carry host and status only: URLs and bodies can contain addresses or tokens. */
async function check(res: Response, url: string): Promise<Response> {
  if (res.status === 401) throw new ProviderAuthError();
  if (!res.ok) {
    throw new ProviderError(`${new URL(url).host} responded ${res.status}`, res.status, Number(res.headers.get('retry-after')) || undefined);
  }
  return res;
}

export async function getJson<T>(f: FetchFn, url: string, token: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await f(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...headers } });
  return (await check(res, url)).json() as Promise<T>;
}

export async function sendJson<T>(f: FetchFn, method: string, url: string, token: string, body?: unknown): Promise<T | null> {
  const res = await f(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await check(res, url);
  return res.status === 204 || res.headers.get('content-length') === '0' ? null : ((await res.json().catch(() => null)) as T | null);
}

/** Runs fn over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
