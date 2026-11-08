import { ProviderCallError } from './errors.ts';

const maxErrorBytes = 16 * 1024;
const explanations: Record<string, string> = {
  invalid_api_key: 'API Key 无效、已撤销或已过期，请在连接设置中更新',
  insufficient_quota: 'API 余额或额度不足，请在供应商控制台核对充值与用量限制',
  organization_spend_limit_exceeded: '组织已达到支出上限，请在供应商控制台调整限额',
  project_spend_limit_exceeded: '项目已达到支出上限，请在供应商控制台调整限额',
  organization_usage_limit_exceeded: '组织已达到供应商用量上限，请申请调整',
  model_not_found: '模型不存在或当前账号无权使用，请核对模型 ID 与项目权限',
  permission_denied: '当前账号或 Key 无权执行此操作，请检查权限',
  unsupported_country_region_territory: '当前访问地区不受供应商支持',
  rate_limit_exceeded: '请求频率或 token 用量触及限流，请稍后再手动发起新请求',
  unsupported_parameter: '接口不支持请求中的某个参数，需要调整接口适配',
  unsupported_value: '接口不支持请求中的某个参数值，需要调整接口适配',
  invalid_json_schema: '结构化输出的 JSON Schema 不被接口接受，需要调整接口适配',
  context_length_exceeded: '输入与输出上限超过模型上下文限制，请减少镜头或描述',
};
const parameters = new Set(['model', 'messages', 'tools', 'tool_choice', 'response_format', 'response_format.json_schema',
  'response_format.json_schema.schema', 'max_completion_tokens', 'reasoning_effort', 'temperature', 'n', 'stream', 'store']);
const connectionErrors: Record<string, string> = {
  ENOTFOUND: '无法解析供应商域名', EAI_AGAIN: '供应商域名解析暂时失败',
  ECONNRESET: '与供应商的连接被重置', ECONNREFUSED: '与供应商的连接被拒绝',
  ETIMEDOUT: '与供应商的网络连接超时', ENETUNREACH: '无法连接网络', EHOSTUNREACH: '无法连接供应商主机',
  UND_ERR_CONNECT_TIMEOUT: '连接供应商超时', UND_ERR_SOCKET: '与供应商的连接意外关闭',
  CERT_HAS_EXPIRED: '供应商连接的 TLS 证书已过期',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证供应商连接的 TLS 证书',
  SELF_SIGNED_CERT_IN_CHAIN: '供应商连接的 TLS 证书链不受信任',
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Network exception messages can contain URLs or credentials; retain known codes only. */
export function describeConnectionFailure(value: unknown): string {
  const error = object(value), cause = object(error.cause);
  const code = [cause.code, error.code].find(value => typeof value === 'string' && Object.hasOwn(connectionErrors, value)) as string | undefined;
  return code ? `${connectionErrors[code]}（${code}）` : '生成请求的连接中断或响应读取失败';
}

/** Copy no supplier text or arbitrary identifiers, even if they contain a prompt or key. */
export function describeHttpRejection(status: number, body: unknown): string {
  const error = object(object(body).error);
  const code = [error.code, error.type].find(value => typeof value === 'string' && Object.hasOwn(explanations, value)) as string | undefined;
  const parameter = typeof error.param === 'string' && parameters.has(error.param) ? error.param : undefined;
  const fallback = status === 401 ? '身份认证失败，请检查连接中的 API Key'
    : status === 403 ? '访问被拒绝，请检查账号、Key 权限与访问地区'
    : status === 404 ? '模型或接口不存在，请核对模型 ID 与服务地址'
    : status === 429 ? '供应商返回限流或额度限制，未取得具体原因，请核对账号控制台'
    : status === 400 || status === 422 ? '请求参数被拒绝，请检查模型与接口的兼容性'
    : '接口拒绝请求，请检查连接与账号权限';
  return `模型服务拒绝请求（HTTP ${status}${code ? ` · ${code}` : ''}${parameter ? ` · ${parameter}` : ''}）：${code ? explanations[code] : fallback}。不会自动重试，费用仍需核对。`;
}

/** Best-effort diagnostics: a broken/slow error body cannot erase the known HTTP status. */
export async function providerHttpError(response: Response, controller: AbortController): Promise<ProviderCallError> {
  const status = response.status;
  if (status >= 500 || status === 408) {
    controller.abort();
    return new ProviderCallError('submission_unknown', 'PROVIDER_SUBMISSION_UNKNOWN', `模型服务返回 HTTP ${status}，无法据此确认未处理请求；请核对，不会自动重发。`, 502, status);
  }
  let body: unknown;
  const declared = Number(response.headers.get('content-length'));
  const timeout = setTimeout(() => controller.abort(), 1000);
  timeout.unref();
  try {
    if (response.body && (!Number.isFinite(declared) || declared <= maxErrorBytes)) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxErrorBytes) throw new Error('Error response exceeds diagnostic limit');
          chunks.push(value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { reader.releaseLock(); }
    }
  } catch { /* Keep only the known status when diagnostics are unavailable. */ }
  finally { clearTimeout(timeout); controller.abort(); }
  return new ProviderCallError('http_rejected', 'PROVIDER_HTTP_REJECTED', describeHttpRejection(status, body), 502, status);
}
