/** Transport policy shared by the HTTP factory, plugins and contract tests. */
export const HTTP_POLICY = Object.freeze({
  apiPrefix: '/api',
  jsonBodyLimit: 1024 * 1024,
  requestTimeoutMs: 300_000,
  headersTimeoutMs: 15_000,
  requestIdHeader: 'x-request-id',
});

export const HTTP_CACHE = Object.freeze({
  api: 'no-store',
  media: 'private, max-age=3600',
  staticAssets: 'public, max-age=3600',
  staticHtml: 'no-cache',
});
