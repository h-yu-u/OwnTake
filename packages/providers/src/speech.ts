import { invariant } from '../../contracts/src/errors.ts';
import type { ProviderProfile } from '../../contracts/src/providers.ts';
import type { SpeechInput, SpeechResult } from '../../contracts/src/studio-provider.ts';
import { invalidResponse } from './errors.ts';
import { boundedText, strictRecord, validateProfile } from './profiles.ts';
import { postStudioBytesOnce } from './studio-http.ts';

function speechText(value: unknown, maximum: number, empty = false): string {
  invariant(typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'INVALID_SPEECH_INPUT', '配音文本或指令无效或超过长度限制。');
  const text = value.trim();
  invariant(empty || text.length > 0, 'INVALID_SPEECH_INPUT', '配音文本不能为空。');
  return text;
}

/** Validates and copies only the explicit fields; a model name never implies capabilities. */
export function validateSpeechInput(value: ProviderProfile, raw: unknown): SpeechInput {
  const profile = validateProfile(value);
  invariant(profile.kind === 'openai-speech', 'PROVIDER_KIND_UNSUPPORTED', '配音需要 Speech 连接。');
  const capability = profile.capabilities.speech;
  invariant(capability && profile.capabilities.inputModes.includes('text'), 'PROVIDER_CAPABILITY_UNSUPPORTED', '连接未声明配音文本能力。');
  const input = strictRecord(raw, ['text', 'voice', 'speed', 'instructions'], 'INVALID_SPEECH_INPUT');
  invariant(['text', 'voice', 'speed', 'instructions'].every(key => Object.hasOwn(input, key)), 'INVALID_SPEECH_INPUT', '配音输入缺少必填字段。');
  const text = speechText(input.text, capability.maxInputChars);
  const voice = boundedText(input.voice, 128, 'INVALID_SPEECH_INPUT');
  invariant(capability.voices.includes(voice), 'PROVIDER_CAPABILITY_UNSUPPORTED', '所选声音不在连接声明的声音清单中。');
  invariant(typeof input.speed === 'number' && Number.isFinite(input.speed) && input.speed >= capability.minSpeed && input.speed <= capability.maxSpeed, 'INVALID_SPEECH_INPUT', '语速超出连接声明的范围。');
  const instructions = input.instructions === null ? null : speechText(input.instructions, 4096, true) || null;
  invariant(instructions === null || capability.supportsInstructions, 'PROVIDER_CAPABILITY_UNSUPPORTED', '所选连接未声明配音指令能力。');
  return { text, voice, speed: input.speed, instructions };
}

export function compileSpeechRequest(value: ProviderProfile, raw: unknown): { endpoint: '/audio/speech'; body: Record<string, unknown> } {
  const profile = validateProfile(value), input = validateSpeechInput(profile, raw);
  return { endpoint: '/audio/speech', body: { model: profile.model, input: input.text, voice: input.voice, response_format: 'wav', speed: input.speed, ...(input.instructions === null ? {} : { instructions: input.instructions }) } };
}

/** Container checks only; the host still probes duration/codec before publishing an Artifact. */
function checkWav(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = (): never => { throw invalidResponse('PROVIDER_INVALID_AUDIO'); };
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') invalid();
  const declared = buffer.readUInt32LE(4);
  // Streaming WAV commonly has unknown-length RIFF/data placeholders, even after EOF.
  if (declared !== 0xffffffff && declared + 8 !== buffer.length) invalid();
  let offset = 12, hasFormat = false, hasSamples = false;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) invalid();
    const name = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (name === 'data' && length === 0xffffffff) {
      if (!hasFormat || offset === buffer.length) invalid();
      hasSamples = true; offset = buffer.length; break;
    }
    if (offset + length > buffer.length) invalid();
    if (name === 'fmt ') {
      if (hasFormat || length < 16 || buffer.readUInt16LE(offset) === 0 || buffer.readUInt16LE(offset + 2) === 0 || buffer.readUInt32LE(offset + 4) === 0 || buffer.readUInt16LE(offset + 12) === 0) invalid();
      hasFormat = true;
    }
    if (name === 'data') {
      if (!hasFormat || !length) invalid();
      hasSamples = true;
    }
    offset += length + (length % 2);
  }
  if (offset !== buffer.length || !hasFormat || !hasSamples) invalid();
}

/** One synchronous POST; recovery and durable receipt storage belong to the host. */
export async function submitSpeech(profile: ProviderProfile, key: string, input: SpeechInput, options: { signal?: AbortSignal } = {}): Promise<SpeechResult> {
  const validated = validateProfile(profile), request = compileSpeechRequest(validated, input);
  const bytes = await postStudioBytesOnce(validated, key, request.endpoint, request.body, { signal: options.signal, response: 'wav' });
  checkWav(bytes);
  return { bytes, mime: 'audio/wav' };
}
