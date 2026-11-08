import type { FastifyError, FastifyRequest } from 'fastify';
import { AppError } from '../../../../../packages/contracts/src/errors.ts';

export interface ValidationPolicy {
  bodyCode?: string;
  /** JSON Pointer prefixes; * matches one array index or object key. */
  fields?: Record<string, string>;
  discriminator?: string;
  variants?: Record<string, Record<string, string>>;
}

declare module 'fastify' {
  interface FastifyContextConfig { validation?: ValidationPolicy }
}

const messages: Record<string, string> = {
  INVALID_INPUT: '请求字段类型、范围或必填项不合法',
  INVALID_ID: '资源标识不合法',
  INVALID_TIMELINE: '时间线、字幕或音轨字段不合法',
  INVALID_STORYBOARD: '分镜数据包含无效、缺失或未允许的字段',
  INVALID_PROVIDER: '模型连接配置字段不合法',
  INVALID_OPENAI_CONNECTION: 'OpenAI 连接名称、模型或版本字段不合法',
  INVALID_OPENAI_MODEL_REQUEST: '读取 OpenAI 模型列表的字段不合法',
  INVALID_PLAN: '生成计划字段不合法',
  INVALID_KEY: 'API 密钥必须是文本',
  INVALID_CURRENCY: '请选择 USD 或 CNY',
  INVALID_REVIEW: '复核结论或覆盖范围无效',
  INVALID_LOCAL_RUNTIME: '本机运行时配置或输入字段不合法',
  INVALID_SPEECH_INPUT: '配音输入字段不合法',
};

function matches(prefix: string, path: string): boolean {
  const wanted = prefix.split('/'), actual = path.split('/');
  return wanted.length <= actual.length && wanted.every((part, index) => part === '*' || part === actual[index]);
}

/** Preserve public domain error families without putting custom keywords in AJV. */
export function validationError(error: FastifyError, request: FastifyRequest): AppError {
  if (error.validationContext === 'params') return new AppError('INVALID_ID', messages.INVALID_ID);
  const policy = request.routeOptions.config.validation;
  const issue = error.validation?.[0];
  let path = issue?.instancePath ?? '';
  if (issue?.keyword === 'required' && typeof issue.params.missingProperty === 'string') path += `/${issue.params.missingProperty}`;
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : undefined;
  const discriminator = policy?.discriminator ? body?.[policy.discriminator] : undefined;
  const variant = typeof discriminator === 'string' ? policy?.variants?.[discriminator] : undefined;
  const field = Object.entries({ ...policy?.fields, ...variant }).toSorted(([a], [b]) => b.length - a.length).find(([prefix]) => matches(prefix, path));
  // Legacy record() rejects a non-object body before feature-specific validation.
  const code = issue?.keyword === 'type' && !path ? 'INVALID_INPUT' : field?.[1] ?? policy?.bodyCode ?? 'INVALID_INPUT';
  return new AppError(code, messages[code] ?? messages.INVALID_INPUT);
}
