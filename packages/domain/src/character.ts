import { invariant } from '../../contracts/src/errors.ts';
import type { CharacterInput } from '../../contracts/src/character.ts';
import { record, text } from './validation.ts';
export function parseCharacter(value: unknown): CharacterInput {
  const input = record(value);
  invariant(Object.keys(input).every(key => ['name','biography','appearance','style','voicePreset'].includes(key)), 'INVALID_INPUT', '人物资料包含未允许字段');
  return {
    name: text(input.name, '人物名称', 120),
    biography: text(input.biography ?? '', '人物经历', 4000, true),
    appearance: text(input.appearance ?? '', '人物外貌', 2000, true),
    style: text(input.style ?? '', '视觉风格', 600, true),
    voicePreset: text(input.voicePreset ?? '', '声音预设', 200, true),
  };
}
