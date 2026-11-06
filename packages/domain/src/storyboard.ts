import { invariant } from '../../contracts/src/errors.ts';
import type { DraftOperation, ShotFields } from '../../contracts/src/storyboard.ts';

export const MAX_STORYBOARD_SHOTS = 100;
export const MAX_DRAFT_OPERATIONS = 100;
const fieldKeys = ['title', 'purpose', 'description', 'action', 'durationMs', 'caption', 'mode', 'referenceArtifactIds'] as const;

function strictObject(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_STORYBOARD', '分镜数据必须是 JSON 对象。');
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, 'INVALID_STORYBOARD', '分镜数据只能包含普通 JSON 对象。');
  const body = value as Record<string, unknown>;
  invariant(Reflect.ownKeys(body).every(key => typeof key === 'string' && allowed.includes(key)), 'INVALID_STORYBOARD', '分镜数据包含未允许的字段或命令。');
  invariant(required.every(key => Object.hasOwn(body, key)), 'INVALID_STORYBOARD', '分镜数据缺少必填字段。');
  return body;
}

function id(value: unknown): string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'INVALID_STORYBOARD', '分镜或素材标识无效。');
  return value;
}

function text(value: unknown, name: string, maximum: number, allowEmpty = true): string {
  invariant(typeof value === 'string' && value.length <= maximum && !value.includes('\0'), 'INVALID_STORYBOARD', `${name}过长或不是有效文本。`);
  const result = value.trim();
  invariant(allowEmpty || result.length > 0, 'INVALID_STORYBOARD', `${name}不能为空。`);
  return result;
}

/** Whitelists and copies a complete field replacement; model output cannot carry tool commands. */
export function parseShotFields(value: unknown): ShotFields {
  const body = strictObject(value, fieldKeys);
  invariant(typeof body.durationMs === 'number' && Number.isSafeInteger(body.durationMs) && body.durationMs >= 100 && body.durationMs <= 600_000, 'INVALID_STORYBOARD', '镜头时长须为 100–600000 毫秒的整数。');
  invariant(body.mode === 'import' || body.mode === 'generate_image' || body.mode === 'generate_video', 'INVALID_STORYBOARD', '素材方式无效。');
  invariant(Array.isArray(body.referenceArtifactIds) && body.referenceArtifactIds.length <= 20, 'INVALID_STORYBOARD', '每镜最多关联 20 个参考素材。');
  const references = body.referenceArtifactIds.map(id);
  invariant(new Set(references).size === references.length, 'INVALID_STORYBOARD', '参考素材不能重复。');
  return {
    title: text(body.title, '镜头标题', 200, false),
    purpose: text(body.purpose, '叙事目的', 4000),
    description: text(body.description, '画面描述', 12000),
    action: text(body.action, '动作描述', 8000),
    durationMs: body.durationMs,
    caption: text(body.caption, '字幕', 10000),
    mode: body.mode,
    referenceArtifactIds: references,
  };
}

export function parseDraftOperations(value: unknown): DraftOperation[] {
  invariant(Array.isArray(value) && value.length > 0 && value.length <= MAX_DRAFT_OPERATIONS, 'INVALID_STORYBOARD', '草稿须包含 1–100 个有界操作。');
  const operationIds = new Set<string>();
  const touchedShots = new Set<string>();
  return value.map(raw => {
    const body = strictObject(raw, ['id', 'kind', 'shotId', 'fields'], ['id', 'kind']);
    const operationId = id(body.id);
    invariant(!operationIds.has(operationId), 'INVALID_STORYBOARD', '草稿操作标识不能重复。');
    operationIds.add(operationId);
    if (body.kind === 'add') {
      strictObject(raw, ['id', 'kind', 'fields']);
      return { id: operationId, kind: 'add', fields: parseShotFields(body.fields) };
    }
    invariant(body.kind === 'update' || body.kind === 'delete', 'INVALID_STORYBOARD', '草稿只能新增、修改或归档镜头。');
    strictObject(raw, body.kind === 'update' ? ['id', 'kind', 'shotId', 'fields'] : ['id', 'kind', 'shotId']);
    const shotId = id(body.shotId);
    invariant(!touchedShots.has(shotId), 'INVALID_STORYBOARD', '一份草稿不能多次修改或归档同一镜头。');
    touchedShots.add(shotId);
    return body.kind === 'update'
      ? { id: operationId, kind: 'update', shotId, fields: parseShotFields(body.fields) }
      : { id: operationId, kind: 'delete', shotId };
  });
}

/** Keep visual generation, captions and edit timing on independent dependency revisions. */
export function classifyShotChanges(previous: ShotFields, next: ShotFields): { visual: boolean; caption: boolean; edit: boolean } {
  return {
    visual: previous.purpose !== next.purpose || previous.description !== next.description || previous.action !== next.action || previous.mode !== next.mode || JSON.stringify(previous.referenceArtifactIds) !== JSON.stringify(next.referenceArtifactIds),
    caption: previous.caption !== next.caption,
    edit: previous.title !== next.title || previous.durationMs !== next.durationMs,
  };
}
