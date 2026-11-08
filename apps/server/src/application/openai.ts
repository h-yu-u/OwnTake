import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { resourceId } from '../../../../packages/domain/src/validation.ts';
import { strictRecord } from '../../../../packages/providers/src/profiles.ts';
import { fetchOpenAIModels } from '../../../../packages/providers/src/openai-models-client.ts';
import type { ApplicationContext } from './context.ts';

/** Resolve credentials inside the local core. A discovery request never mutates saved configuration. */
export async function discoverOpenAIModels({ openaiConnections }: Pick<ApplicationContext, 'openaiConnections'>, value: unknown) {
  const input = strictRecord(value, ['connectionId', 'key'], 'INVALID_OPENAI_MODEL_REQUEST');
  invariant(input.key === undefined || typeof input.key === 'string' && input.key.length <= 8192, 'INVALID_KEY', 'API Key 必须是有效文本。');
  const connectionId = input.connectionId === undefined ? undefined : resourceId(input.connectionId);
  const typedKey = typeof input.key === 'string' ? input.key.trim() : '';
  const key = typedKey || (connectionId ? openaiConnections.credentialForDiscovery(connectionId) : '');
  invariant(key, 'CREDENTIAL_REQUIRED', '请先填写 OpenAI API Key，或使用已保存密钥的连接。', 409);
  return fetchOpenAIModels(key);
}
