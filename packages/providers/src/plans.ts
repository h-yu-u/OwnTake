import { invariant } from '../../contracts/src/errors.ts';
import type { CapabilityIssue, CompiledGenerationInput, GenerationPlan, PlanValidationResult, ProviderProfile } from '../../contracts/src/providers.ts';
import { strictRecord, validateProfile } from './profiles.ts';

export function parseGenerationPlan(value: unknown): GenerationPlan {
  const input = strictRecord(value, ['kind', 'inputMode', 'prompt', 'ratio', 'durationSec', 'referenceArtifactIds'], 'INVALID_PLAN');
  invariant(input.kind === 'image' || input.kind === 'video', 'INVALID_PLAN', '生成媒体类型无效。');
  invariant(typeof input.inputMode === 'string' && ['text', 'first_frame', 'first_last_frame', 'references'].includes(input.inputMode), 'INVALID_PLAN', '生成输入方式无效。');
  invariant(typeof input.prompt === 'string' && input.prompt.trim().length > 0 && input.prompt.length <= 20_000 && !input.prompt.includes('\0'), 'INVALID_PLAN', '生成提示词不能为空，且不能超过 20000 字符。');
  invariant(input.ratio === '16:9' || input.ratio === '9:16' || input.ratio === '1:1', 'INVALID_PLAN', '生成画幅无效。');
  invariant(Array.isArray(input.referenceArtifactIds) && input.referenceArtifactIds.length <= 16 && input.referenceArtifactIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)), 'INVALID_PLAN', '参考素材必须是已登记的素材标识，且不能超过 16 个。');
  invariant(new Set(input.referenceArtifactIds).size === input.referenceArtifactIds.length, 'INVALID_PLAN', '参考素材不能重复。');
  if (input.durationSec !== undefined) invariant(typeof input.durationSec === 'number' && Number.isFinite(input.durationSec) && input.durationSec > 0 && input.durationSec <= 600, 'INVALID_PLAN', '生成时长必须介于 0–600 秒。');
  return { kind: input.kind, inputMode: input.inputMode as GenerationPlan['inputMode'], prompt: input.prompt, ratio: input.ratio, ...(input.durationSec === undefined ? {} : { durationSec: input.durationSec as number }), referenceArtifactIds: [...input.referenceArtifactIds] as string[] };
}

/** No network, no input substitutions and no automatic downgrade of reference modes. */
export function validateAndCompile(value: ProviderProfile, rawPlan: GenerationPlan): PlanValidationResult {
  const profile = validateProfile(value), plan = parseGenerationPlan(rawPlan), issues: CapabilityIssue[] = [];
  const issue = (code: string, field: string, message: string): void => { issues.push({ code, field, message }); };
  if ((plan.kind === 'image' && profile.kind !== 'openai-images' && profile.kind !== 'openai-image-edits') || (plan.kind === 'video' && profile.kind !== 'ark-video')) issue('OUTPUT_KIND_UNSUPPORTED', 'kind', '所选连接不支持这类媒体输出，请选择对应适配器。');
  if (!profile.capabilities.inputModes.includes(plan.inputMode)) issue('INPUT_MODE_UNSUPPORTED', 'inputMode', `当前连接未声明 ${plan.inputMode} 能力；原始参考不会自动丢弃。`);
  if (!profile.capabilities.ratios.includes(plan.ratio)) issue('RATIO_UNSUPPORTED', 'ratio', '当前连接未声明此画幅，请选择支持的画幅或更换连接。');
  if (plan.kind === 'video' && (plan.durationSec === undefined || !profile.capabilities.durationsSec.includes(plan.durationSec))) issue('DURATION_UNSUPPORTED', 'durationSec', '视频时长必须匹配连接声明的时长选项。');
  if (plan.kind === 'image' && plan.durationSec !== undefined) issue('IMAGE_DURATION_UNSUPPORTED', 'durationSec', '图片生成没有视频时长；请显式修改计划。');
  const count = plan.referenceArtifactIds.length;
  if (count > profile.capabilities.maxReferences) issue('TOO_MANY_REFERENCES', 'referenceArtifactIds', `参考素材数量超过连接声明的上限 ${profile.capabilities.maxReferences}。`);
  const required = { text: 0, first_frame: 1, first_last_frame: 2, references: -1 }[plan.inputMode];
  if (required === -1 ? count === 0 : count !== required) issue('REFERENCE_COUNT_MISMATCH', 'referenceArtifactIds', required === -1 ? '参考模式至少需要一个素材。' : `此输入方式需要恰好 ${required} 个参考素材。`);
  if (issues.length) return { status: 'needs_replan', issues, requestedPlan: plan };
  let input: CompiledGenerationInput;
  switch (plan.inputMode) {
    case 'text': input = { mode: 'text' }; break;
    case 'first_frame': input = { mode: 'first_frame', firstFrameArtifactId: plan.referenceArtifactIds[0]! }; break;
    case 'first_last_frame': input = { mode: 'first_last_frame', firstFrameArtifactId: plan.referenceArtifactIds[0]!, lastFrameArtifactId: plan.referenceArtifactIds[1]! }; break;
    case 'references': input = { mode: 'references', referenceArtifactIds: [...plan.referenceArtifactIds] }; break;
  }
  return { status: 'valid', issues: [], compiled: { providerId: profile.id, providerKind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, plan, input } };
}
