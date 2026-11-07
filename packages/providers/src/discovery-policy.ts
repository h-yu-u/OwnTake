/** Fixed upstream host prevents a search keyword from becoming an arbitrary proxy URL. */
export const DISCOVERY_POLICY = {
  origin: 'https://developer.zhihu.com',
  zhihuPath: '/api/v1/content/zhihu_search',
  webPath: '/api/v1/content/global_search',
  maxResults: 10,
  maxQueryChars: 100,
  maxResponseBytes: 1024 * 1024,
  timeoutMs: 12_000,
  maxSnippetChars: 1000,
  maxTitleChars: 300,
  maxAuthorChars: 200,
  maxUrlChars: 2048,
} as const;
