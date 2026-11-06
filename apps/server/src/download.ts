import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
function publicAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const value = address.toLowerCase(), parts = value.split(':');
    return /^[23]/.test(value) && !['2002:', '2001:db8:', '3ffe:', '3fff:'].some(prefix => value.startsWith(prefix)) && !(parts[0] === '2001' && Number.parseInt(parts[1] || '0', 16) < 0x200);
  }
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number) as [number,number,number,number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
async function target(raw: string, providerBaseUrl: string, signal: AbortSignal): Promise<{ url: URL; lookup: RequestOptions['lookup'] }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError('DOWNLOAD_URL_INVALID', '供应商结果地址不合法', 502); }
  const provider = new URL(providerBaseUrl);
  const local = ['localhost','127.0.0.1'].includes(provider.hostname) && url.origin === provider.origin;
  invariant(!url.username && !url.password && !url.hash && (url.protocol === 'https:' || local && url.protocol === 'http:'), 'DOWNLOAD_URL_INVALID', '结果下载只允许 HTTPS；本地模型只能返回同来源地址', 502);
  let addresses: { address: string; family: number }[];
  let stop: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => { stop = () => reject(new AppError('DOWNLOAD_INTERRUPTED', '下载已停止', 502)); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
  try { addresses = await Promise.race([lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true }), interrupted]); }
  catch { throw new AppError('DOWNLOAD_DNS_FAILED', '无法解析结果下载主机，请稍后重试原结果', 502); }
  finally { signal.removeEventListener('abort', stop); }
  invariant(addresses.length > 0 && (local || addresses.every(item => publicAddress(item.address))), 'DOWNLOAD_ADDRESS_BLOCKED', '远端结果不能指向私有网络或本机地址', 502);
  // Pin the checked DNS answer in the actual request; a second DNS lookup cannot rebind to a private host.
  const pinned: RequestOptions['lookup'] = (_hostname, options, callback) => {
    const first = addresses[0]!;
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  };
  return { url, lookup: pinned };
}
export async function downloadResult(raw: string, outputPath: string, options: { providerBaseUrl: string; signal?: AbortSignal; maxBytes?: number; timeoutMs?: number }): Promise<void> {
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, options.timeoutMs ?? 120000); timeout.unref();
  let complete = false;
  try {
    let next = raw;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const checked = await target(next, options.providerBaseUrl, controller.signal);
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const run = checked.url.protocol === 'https:' ? httpsRequest : httpRequest;
        const request = run(checked.url, { method: 'GET', lookup: checked.lookup, signal: controller.signal, headers: { Accept: 'image/*,video/*,audio/*' } }, resolve);
        request.on('error', () => reject(new AppError('DOWNLOAD_INTERRUPTED', '结果下载中断，请重试原结果；不会重新生成', 502))); request.end();
      });
      if ([301,302,303,307,308].includes(response.statusCode ?? 0)) {
        response.resume(); const location = response.headers.location;
        invariant(location && redirects < 3, 'DOWNLOAD_REDIRECT_FAILED', '结果地址重定向无效或次数过多', 502); next = new URL(location, checked.url).href; continue;
      }
      invariant(response.statusCode === 200, 'DOWNLOAD_HTTP_ERROR', `下载服务返回 HTTP ${response.statusCode ?? 0}；请刷新原任务的结果地址`, 502);
      const maxBytes = options.maxBytes ?? 256 * 1024 * 1024, declared = Number(response.headers['content-length'] ?? 0);
      invariant(declared <= maxBytes, 'DOWNLOAD_TOO_LARGE', '生成媒体超过 256 MiB 下载上限', 413);
      let bytes = 0;
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > maxBytes ? new AppError('DOWNLOAD_TOO_LARGE', '生成媒体超过下载上限', 413) : null, chunk); } });
      await pipeline(response, limiter, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      invariant(bytes > 0, 'EMPTY_RESULT', '供应商返回了空文件', 502); complete = true; return;
    }
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError('DOWNLOAD_INTERRUPTED', '结果未完整下载，请重试原结果；不会重新生成', 502); }
  finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); controller.abort(); if (!complete) await rm(outputPath, { force: true }).catch(() => undefined); }
}
