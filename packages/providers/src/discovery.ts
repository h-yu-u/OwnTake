import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { DiscoveryResult, DiscoverySource } from '../../contracts/src/discovery.ts';
import { text } from '../../domain/src/validation.ts';
import { canonicalStoryUrl } from '../../domain/src/story-url.ts';
import { DISCOVERY_POLICY } from './discovery-policy.ts';

type FetchLike = typeof fetch;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
}
function field(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/<[^>]{0,200}>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
}
export function parseDiscovery(platform: DiscoverySource, value: unknown): DiscoveryResult[] {
  const root = object(value), data = object(root?.Data);
  if (root?.Code !== 0 || !data || !Array.isArray(data.Items)) throw new AppError('DISCOVERY_BAD_RESPONSE', '搜索服务返回了无法识别的结果', 502);
  const found = new Map<string, DiscoveryResult>();
  for (const raw of data.Items.slice(0, DISCOVERY_POLICY.maxResults)) {
    const item = object(raw);
    if (!item) continue;
    const title = field(item.Title, DISCOVERY_POLICY.maxTitleChars);
    const author = field(item.AuthorName, DISCOVERY_POLICY.maxAuthorChars);
    const snippet = field(item.ContentText, DISCOVERY_POLICY.maxSnippetChars);
    const contentType = field(item.ContentType, 80);
    let url: string;
    try { url = canonicalStoryUrl(field(item.Url, DISCOVERY_POLICY.maxUrlChars)); }
    catch { continue; }
    const host = new URL(url).hostname.toLowerCase();
    if (platform === 'xiaohongshu' && host !== 'xiaohongshu.com' && !host.endsWith('.xiaohongshu.com')) continue;
    if (platform === 'zhihu' && host !== 'zhihu.com' && !host.endsWith('.zhihu.com')) continue;
    if (!title || found.has(url)) continue;
    found.set(url, { platform, title, url, author, snippet, contentType });
  }
  return [...found.values()];
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('DISCOVERY_BAD_RESPONSE', '搜索服务没有返回结果', 502);
  const parts: Uint8Array[] = [], max = DISCOVERY_POLICY.maxResponseBytes;
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) throw new AppError('DISCOVERY_RESPONSE_TOO_LARGE', '搜索响应超过限制', 502);
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const combined = new Uint8Array(bytes); let offset = 0;
    for (const part of parts) { combined.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder().decode(combined));
  } catch { throw new AppError('DISCOVERY_BAD_RESPONSE', '搜索响应 JSON 无效', 502); }
}

export class StoryDiscovery {
  private readonly getSecret: () => string;
  private readonly request: FetchLike;
  private readonly now: () => number;
  constructor(getSecret: () => string = () => process.env.OWNTAKE_ZHIHU_ACCESS_SECRET ?? '',
    request: FetchLike = fetch, now: () => number = Date.now) {
    this.getSecret = getSecret; this.request = request; this.now = now;
  }
  configured(): boolean { return this.getSecret().length > 0; }
  async search(platform: DiscoverySource, query: string): Promise<DiscoveryResult[]> {
    invariant(platform === 'zhihu' || platform === 'xiaohongshu', 'INVALID_INPUT', '不支持的检索来源');
    const q = text(query, '搜索词', DISCOVERY_POLICY.maxQueryChars);
    const secret = this.getSecret();
    if (!secret) throw new AppError('DISCOVERY_NOT_CONFIGURED', '需要在本机设置 OWNTAKE_ZHIHU_ACCESS_SECRET，才能调用官方搜索 API', 412);
    const url = new URL(platform === 'zhihu' ? DISCOVERY_POLICY.zhihuPath : DISCOVERY_POLICY.webPath, DISCOVERY_POLICY.origin);
    url.searchParams.set('Query', q);
    url.searchParams.set('Count', String(DISCOVERY_POLICY.maxResults));
    if (platform === 'xiaohongshu') url.searchParams.set('Filter', 'host=="xiaohongshu.com"');
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'GET',
        signal: AbortSignal.timeout(DISCOVERY_POLICY.timeoutMs),
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${secret}`,
          'X-Request-Timestamp': String(Math.floor(this.now() / 1000)),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
    } catch { throw new AppError('DISCOVERY_UNAVAILABLE', '搜索服务不可用，请确认网络与官方凭据', 502); }
    if (!response.ok) throw new AppError('DISCOVERY_UPSTREAM_ERROR', '搜索服务拒绝请求，请检查额度、访问权限或服务状态', response.status === 429 ? 429 : 502);
    return parseDiscovery(platform, await boundedJson(response));
  }
}
