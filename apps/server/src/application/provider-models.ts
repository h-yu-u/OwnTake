import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { resourceId } from '../../../../packages/domain/src/validation.ts';
import { normalizeBaseUrl, strictRecord } from '../../../../packages/providers/src/profiles.ts';
import { fetchProviderModels } from '../../../../packages/providers/src/provider-models.ts';
import type { ApplicationContext } from './context.ts';

export async function discoverProviderModels({ providers }: Pick<ApplicationContext, 'providers'>, value: unknown) {
  const input = strictRecord(value, ['providerId', 'kind', 'baseUrl', 'key'], 'INVALID_PROVIDER_MODEL_REQUEST');
  invariant(typeof input.kind === 'string' && ['chat-completions', 'openai-images', 'ark-video', 'openai-speech'].includes(input.kind), 'INVALID_PROVIDER_MODEL_REQUEST', '连接类型无效。');
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  invariant(input.key === undefined || typeof input.key === 'string' && input.key.length <= 8192, 'INVALID_KEY', 'API Key 必须是有效文本。');
  let key = typeof input.key === 'string' ? input.key.trim() : '';
  if (input.providerId !== undefined) {
    const saved = providers.getProfile(resourceId(input.providerId));
    if (!key) {
      invariant(new URL(saved.profile.baseUrl).origin === new URL(baseUrl).origin, 'NEW_ORIGIN_KEY_REQUIRED', '服务来源已改变，请重新填写该服务的 Key；已保存密钥不会发送到新来源。', 409);
      key = providers.vault.get(saved.credentialRef);
    }
  }
  return fetchProviderModels(baseUrl, key);
}
