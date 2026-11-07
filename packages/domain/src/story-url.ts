import { AppError, invariant } from '../../contracts/src/errors.ts';
/** Canonicalize provenance identifiers; this never fetches a user-supplied URL. */
export function canonicalStoryUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError('INVALID_INPUT', '来源链接无效', 400); }
  invariant(url.protocol === 'https:' && !url.username && !url.password && value.length <= 2048,
    'INVALID_INPUT', '来源链接须为 HTTPS');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|share_|source$|from$|tracking_)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
