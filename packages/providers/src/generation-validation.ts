import type { Artifact } from '../../contracts/src/index.ts';
import type { CapabilityIssue, GenerationPlan, PlanValidationResult, ProviderProfile } from '../../contracts/src/providers.ts';
import { validateAndCompile } from './plans.ts';

export const MAX_GENERATION_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_RESPONSE_BYTES = Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 1024 * 1024;

/** Protocol-level checks are separate from a model's user-declared capability list. */
export function validateGenerationShape(profile: ProviderProfile, plan: GenerationPlan): PlanValidationResult {
  const base = validateAndCompile(profile, plan);
  const issues: CapabilityIssue[] = base.status === 'needs_replan' ? [...base.issues] : [];
  const issue = (code: string, field: string, message: string): void => { issues.push({ code, field, message }); };
  if (profile.kind === 'openai-images') {
    if (plan.inputMode !== 'text') issue('IMAGE_TEXT_ONLY', 'inputMode', '当前图片适配器仅实现文生图；参考图输入需要单独的图片编辑适配器。');
    if (/^dall-e(?:-|$)/i.test(profile.model)) issue('IMAGE_PROTOCOL_UNSUPPORTED', 'model', '当前适配器使用 GPT Image 的 PNG/base64 协议，不支持旧版 DALL·E 参数合同。');
    if (/^gpt-image-1(?:[.-]|$)/i.test(profile.model) && plan.ratio !== '1:1') issue('IMAGE_SIZE_UNSUPPORTED', 'ratio', '此旧版图片模型不支持精确的 16:9/9:16 尺寸；请声明并选择 1:1，或更换支持此尺寸的模型。');
  }
  if (profile.kind === 'openai-image-edits') {
    if (/^gpt-image-1(?:[.-]|$)/i.test(profile.model) && plan.ratio !== '1:1')
      issue('EDIT_SIZE_UNSUPPORTED','ratio','GPT Image 1.x 编辑接口不支持严格 16:9/9:16 输出，请改用 GPT Image 2.x 或 1:1。');
    if (plan.kind !== 'image' || plan.inputMode !== 'references' || plan.referenceArtifactIds.length===0)
      issue('EDIT_REFERENCES_REQUIRED', 'inputMode', '参考图编辑适配器要求至少一张参考图片，不能按纯文字生成。');
  }
  if (profile.kind === 'ark-video') {
    if (!Number.isSafeInteger(plan.durationSec) || plan.durationSec! < 2 || plan.durationSec! > 30) issue('ARK_DURATION_INVALID', 'durationSec', '此适配器要求 2–30 秒的明确整数时长，并须在连接能力清单中；不使用自动时长。');
    // Ark also parses --parameters inside text. They must not override the reviewed plan.
    if (/(?:^|\s)--[a-z][a-z0-9_]*(?:\b|$)/i.test(plan.prompt)) issue('ARK_PROMPT_PARAMETERS_UNSUPPORTED', 'prompt', '请将画幅和时长保留在计划字段中；提示词不接受 --参数形式，以免覆盖已审阅的生成配置。');
  }
  if (issues.length) return { status: 'needs_replan', issues, requestedPlan: base.status === 'valid' ? base.compiled.plan : base.requestedPlan };
  return base;
}

function imageFormat(artifact: Artifact): string | null {
  const formats = [artifact.media.codec, artifact.media.format].filter((value): value is string => typeof value === 'string');
  for (const raw of formats) {
    for (const part of raw.toLowerCase().split(',')) {
      const value = part.replace(/_pipe$/, '');
      if (value === 'mjpeg' || value === 'jpg' || value === 'jpeg') return 'jpeg';
      if (['png', 'webp', 'bmp', 'tiff', 'gif'].includes(value)) return value;
    }
  }
  return null;
}

export function validateGeneration(profile: ProviderProfile, plan: GenerationPlan, referenceArtifacts: Artifact[]): PlanValidationResult {
  const base = validateGenerationShape(profile, plan);
  const issues: CapabilityIssue[] = base.status === 'needs_replan' ? [...base.issues] : [];
  const issue = (code: string, message: string): void => { issues.push({ code, field: 'referenceArtifactIds', message }); };
  const requested = base.status === 'valid' ? base.compiled.plan : base.requestedPlan;
  if (!Array.isArray(referenceArtifacts)) {
    issue('REFERENCE_METADATA_MISSING', '参考素材元数据必须是列表。');
    return { status: 'needs_replan', issues, requestedPlan: requested };
  }
  const byId = new Map(referenceArtifacts.map(artifact => [artifact.id, artifact]));
  if (byId.size !== referenceArtifacts.length) issue('REFERENCE_METADATA_AMBIGUOUS', '参考素材元数据存在重复标识。');
  let estimatedRequestBytes = Buffer.byteLength(JSON.stringify(requested)) + 4096;
  for (const id of requested.referenceArtifactIds) {
    const artifact = byId.get(id);
    if (!artifact) { issue('REFERENCE_METADATA_MISSING', '参考素材不存在或尚未登记。'); continue; }
    if (profile.kind !== 'ark-video' && profile.kind !== 'openai-image-edits') continue;
    if (artifact.kind !== 'image' || artifact.media.kind !== 'image') { issue('ARK_IMAGE_REFERENCE_REQUIRED', '当前 Ark 适配器只发送图片参考；不把视频或音频自动转换为图片。'); continue; }
    const { width, height } = artifact.media;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! < 300 || width! > 6000 || height! < 300 || height! > 6000 || width! / height! < 0.4 || width! / height! > 2.5) issue('ARK_REFERENCE_DIMENSIONS', '参考图片宽高必须为 300–6000 像素，宽高比介于 0.4 和 2.5。');
    const format = imageFormat(artifact);
    if (profile.kind === 'openai-image-edits' && !['jpeg','png','webp'].includes(format ?? ''))
      issue('EDIT_REFERENCE_FORMAT', '图片编辑只支持 JPEG、PNG 或 WebP 格式的参考图。');
    else if (!format) issue('ARK_REFERENCE_FORMAT', '参考图片格式须为 JPEG、PNG、WebP、BMP、TIFF 或 GIF。');
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 || artifact.sizeBytes > MAX_REFERENCE_IMAGE_BYTES) issue('ARK_REFERENCE_TOO_LARGE', 'OwnTake 的单张参考图片上限为 16 MiB。');
    else estimatedRequestBytes += Math.ceil(artifact.sizeBytes / 3) * 4 + 256;
  }
  if (estimatedRequestBytes > MAX_GENERATION_REQUEST_BYTES) issue('GENERATION_REQUEST_TOO_LARGE', '参考图片编码后的生成请求超过 OwnTake 的 32 MiB 上限。');
  if (issues.length) return { status: 'needs_replan', issues, requestedPlan: requested };
  return base;
}
