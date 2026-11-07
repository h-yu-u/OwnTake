import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { GenerationCancellationResult, GenerationPollResult, GenerationReferenceData, GenerationRequest, GenerationRequestOptions, GenerationSubmissionResult } from '../../contracts/src/generation-provider.ts';
import type { GenerationPlan, ProviderProfile } from '../../contracts/src/providers.ts';
import { ProviderCallError } from './errors.ts';
import { generationJsonRequest, submissionUnknown } from './generation-http.ts';
import { MAX_GENERATION_REQUEST_BYTES, MAX_IMAGE_RESPONSE_BYTES, MAX_INLINE_IMAGE_BYTES, MAX_REFERENCE_IMAGE_BYTES, validateGenerationShape } from './generation-validation.ts';
import { validateProfile } from './profiles.ts';

export { validateGeneration } from './generation-validation.ts';
const videoEndpoint = '/contents/generations/tasks';
const imageSizes = { '16:9': '1536x864', '9:16': '864x1536', '1:1': '1024x1024' } as const;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodeBase64(value: unknown, maximum: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= maximum && bytes.toString('base64') === value ? bytes : null;
}

function referenceDataUrl(value: unknown): string {
  invariant(typeof value === 'string', 'INVALID_REFERENCE_DATA', '参考素材必须是已读取的图片 data URL。');
  const match = /^data:image\/(jpeg|png|webp|bmp|tiff|gif);base64,/.exec(value);
  invariant(match && decodeBase64(value.slice(match[0].length), MAX_REFERENCE_IMAGE_BYTES) !== null, 'INVALID_REFERENCE_DATA', '参考图片编码或大小无效；单张上限为 16 MiB，不接受外部 URL 或文件路径。');
  return value;
}

/** Pure compilation. Call validateGeneration with registered metadata before reserving a request. */
export function compileGenerationRequest(profileValue: ProviderProfile, planValue: GenerationPlan, referenceData: GenerationReferenceData): GenerationRequest {
  const profile = validateProfile(profileValue);
  const validation = validateGenerationShape(profile, planValue);
  if (validation.status !== 'valid') throw new AppError('GENERATION_NEEDS_REPLAN', '生成计划与适配器或连接能力不兼容，请先修改计划。', 409, { issues: validation.issues });
  const plan = validation.compiled.plan;
  invariant(referenceData !== null && typeof referenceData === 'object' && !Array.isArray(referenceData), 'INVALID_REFERENCE_DATA', '参考素材数据必须是对象。');
  invariant(Object.keys(referenceData).length === plan.referenceArtifactIds.length && Object.keys(referenceData).every(id => plan.referenceArtifactIds.includes(id)) && plan.referenceArtifactIds.every(id => Object.hasOwn(referenceData, id)), 'INVALID_REFERENCE_DATA', '参考素材数据必须恰好对应已审阅的素材标识。');
  let referenceBytes = 0;
  for (const id of plan.referenceArtifactIds) {
    invariant(typeof referenceData[id] === 'string', 'INVALID_REFERENCE_DATA', '参考素材必须使用图片 data URL。');
    referenceBytes += Buffer.byteLength(referenceData[id]!);
    invariant(referenceBytes <= MAX_GENERATION_REQUEST_BYTES, 'GENERATION_REQUEST_TOO_LARGE', '参考图片编码已超过 32 MiB 请求上限。');
  }
  let request: GenerationRequest;
  if (profile.kind === 'openai-images') {
    request = { endpoint: '/images/generations', body: { model: profile.model, prompt: plan.prompt, n: 1, output_format: 'png', size: imageSizes[plan.ratio] } };
  } else if (profile.kind === 'openai-image-edits') {
    invariant(plan.referenceArtifactIds.length >= 1 && plan.inputMode === 'references',
      'EDIT_REFERENCES_REQUIRED', '图片编辑至少需要一张已确认的静态参考图片');
    const images = plan.referenceArtifactIds.map(id => {
      const dataUrl = referenceDataUrl(referenceData[id]);
      invariant(/^data:image\/(?:png|jpeg|webp);base64,/.test(dataUrl),
        'EDIT_REFERENCE_FORMAT', '图片编辑只接受 PNG、JPEG 或 WebP 参考图');
      return { image_url: dataUrl };
    });
    request = { endpoint: '/images/edits', body: {
      model: profile.model, prompt: plan.prompt, n: 1, output_format: 'png',
      size: imageSizes[plan.ratio], images,
    } };
  } else {
    const content: Record<string, unknown>[] = [{ type: 'text', text: plan.prompt }];
    plan.referenceArtifactIds.forEach((id, index) => {
      const role = plan.inputMode === 'first_last_frame' ? (index === 0 ? 'first_frame' : 'last_frame') : plan.inputMode === 'first_frame' ? 'first_frame' : 'reference_image';
      content.push({ type: 'image_url', image_url: { url: referenceDataUrl(referenceData[id]) }, role });
    });
    request = { endpoint: videoEndpoint, body: { model: profile.model, content, ratio: plan.ratio, duration: plan.durationSec } };
  }
  invariant(Buffer.byteLength(JSON.stringify(request.body)) <= MAX_GENERATION_REQUEST_BYTES, 'GENERATION_REQUEST_TOO_LARGE', '图片编码后的生成请求超过 32 MiB。');
  return request;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalid(code = 'PROVIDER_INVALID_RESPONSE'): ProviderCallError {
  return new ProviderCallError('invalid_response', code, '生成服务返回的数据无效；不会重新提交生成请求。');
}

function taskId(value: unknown): string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value), 'INVALID_REMOTE_TASK_ID', '远端任务标识无效。');
  return value;
}

export async function submitGeneration(profileValue: ProviderProfile, key: string, plan: GenerationPlan, referenceData: GenerationReferenceData, options: GenerationRequestOptions = {}): Promise<GenerationSubmissionResult> {
  const profile = validateProfile(profileValue);
  const request = compileGenerationRequest(profile, plan, referenceData);
  const remote = profile.kind === 'ark-video';
  const value = await generationJsonRequest(profile, key, request.endpoint, { method: 'POST', phase: 'submit', body: request.body, signal: options.signal, maxResponseBytes: remote ? 1024 * 1024 : MAX_IMAGE_RESPONSE_BYTES, unknownOnInvalidResponse: remote });
  const response = record(value);
  if (remote) {
    const id = response?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || (key.length > 0 && id.includes(key))) throw submissionUnknown();
    return { kind: 'remote', remoteTaskId: id };
  }
  if (!response || !Array.isArray(response.data) || response.data.length !== 1) throw invalid();
  const bytes = decodeBase64(record(response.data[0])?.b64_json, MAX_INLINE_IMAGE_BYTES);
  if (!bytes || bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature) || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) throw invalid('PROVIDER_INVALID_IMAGE');
  return { kind: 'inline', bytes, mime: 'image/png' };
}

function videoProfile(value: ProviderProfile): ProviderProfile {
  const profile = validateProfile(value);
  invariant(profile.kind === 'ark-video', 'GENERATION_OPERATION_UNSUPPORTED', '此连接不支持异步视频任务查询或取消。');
  return profile;
}

function outputUrl(value: unknown, profile: ProviderProfile): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw invalid('PROVIDER_INVALID_OUTPUT_URL');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('PROVIDER_INVALID_OUTPUT_URL'); }
  const localFixture = ['localhost', '127.0.0.1'].includes(new URL(profile.baseUrl).hostname) && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && localFixture) || url.username || url.password || url.hash || /[\u0000-\u0020\u007f]/.test(value)) throw invalid('PROVIDER_INVALID_OUTPUT_URL');
  return value;
}

export async function pollGeneration(profileValue: ProviderProfile, key: string, remoteTaskId: string, options: GenerationRequestOptions = {}): Promise<GenerationPollResult> {
  const profile = videoProfile(profileValue);
  const id = taskId(remoteTaskId);
  const value = await generationJsonRequest(profile, key, `${videoEndpoint}/${id}`, { method: 'GET', phase: 'poll', signal: options.signal, maxResponseBytes: 1024 * 1024 });
  const response = record(value);
  if (!response || response.id !== id || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(String(response.status))) throw invalid('PROVIDER_INVALID_TASK_STATUS');
  const status = response.status as GenerationPollResult['status'];
  if (status === 'succeeded') return { status, outputUrl: outputUrl(record(response.content)?.video_url, profile) };
  if (status === 'failed' || status === 'expired') return { status, errorCode: status === 'failed' ? 'PROVIDER_GENERATION_FAILED' : 'PROVIDER_GENERATION_EXPIRED' };
  return { status };
}

export async function cancelGeneration(profileValue: ProviderProfile, key: string, remoteTaskId: string, options: GenerationRequestOptions = {}): Promise<GenerationCancellationResult> {
  const profile = videoProfile(profileValue);
  const id = taskId(remoteTaskId);
  // Ark's same DELETE also deletes completed records. A preceding GET cannot prevent
  // queued -> succeeded between requests, and the API has no conditional-state guard.
  // Preserve the result instead of issuing a potentially destructive cancellation.
  await pollGeneration(profile, key, id, options);
  return { acknowledged: false };
}
