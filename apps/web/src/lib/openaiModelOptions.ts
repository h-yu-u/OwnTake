import type { OpenAICapability, OpenAIListedModel, OpenAIModelCatalog } from '../types.ts';
import { OPENAI_MODEL_OPTIONS } from '../../../../packages/providers/src/openai-presets.ts';
import { classifyOpenAIModel } from '../../../../packages/providers/src/openai-model-catalog.ts';

type ModelOption = { label: string; value: string };
export type OpenAIModelOptionGroup = { type: 'group'; label: string; key: string; children: ModelOption[] };

function option(model: OpenAIListedModel): ModelOption {
  return { value: model.id, label: model.shutdownDate ? `${model.id} · 停服 ${model.shutdownDate}` : model.id };
}

/** Listing and name-based grouping do not establish execution capability. */
export function openAIModelOptions(capability: OpenAICapability, current: string, catalog: OpenAIModelCatalog | null): OpenAIModelOptionGroup[] {
  const groups: OpenAIModelOptionGroup[] = [];
  if (catalog) {
    const matching = catalog.models.filter(model => classifyOpenAIModel(model.id) === capability);
    const unknown = catalog.models.filter(model => classifyOpenAIModel(model.id) === 'unknown');
    if (matching.length) groups.push({ type: 'group', key: 'account', label: '账号模型', children: matching.map(option) });
    if (unknown.length) groups.push({ type: 'group', key: 'unknown', label: '其他账号模型（请确认用途）', children: unknown.map(option) });
  } else {
    groups.push({ type: 'group', key: 'presets', label: '官方预设（账号可用性未确认）', children: OPENAI_MODEL_OPTIONS[capability].map(id => ({ label: id, value: id })) });
  }
  if (current && !groups.some(group => group.children.some(model => model.value === current))) {
    const listed = catalog?.models.find(model => model.id === current);
    groups.unshift({ type: 'group', key: 'current', label: catalog && !listed ? '当前选择（账号目录未返回）' : '当前选择', children: [listed ? option(listed) : { label: current, value: current }] });
  }
  return groups;
}

export function openAIModelSelectionNote(capability: OpenAICapability, current: string, catalog: OpenAIModelCatalog | null): string {
  if (!catalog || !current) return '';
  if (!catalog.models.some(model => model.id === current)) return '当前选择未出现在账号目录中，已为你保留；请确认账号是否可用。';
  if (classifyOpenAIModel(current) !== capability) return '当前型号的用途需要你确认，目录读取不会验证接口兼容性。';
  return '';
}
