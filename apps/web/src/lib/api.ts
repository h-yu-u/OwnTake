import type { ApiError, AppSettings, Artifact, Health, Job, Project, ProjectSnapshot, Ratio, Timeline, TimelineDraft } from '../types.ts';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  constructor(message: string, code = 'NETWORK_ERROR', status = 0, details?: unknown) {
    super(message); this.name = 'ApiRequestError'; this.code = code; this.status = status; this.details = details;
  }
}

let csrfToken = '';
let sessionPromise: Promise<void> | null = null;

export async function openSession(force = false): Promise<void> {
  if (!force && csrfToken) return;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new ApiRequestError('无法建立本地会话，请确认服务已启动。', 'SESSION_ERROR', response.status);
    const session = await response.json() as { csrfToken?: string };
    if (!session.csrfToken) throw new ApiRequestError('本地服务未返回有效会话。', 'SESSION_ERROR');
    csrfToken = session.csrfToken;
  })();
  try { await sessionPromise; }
  finally { sessionPromise = null; }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  await openSession();
  const headers = new Headers(options.headers);
  if (options.method && !['GET', 'HEAD'].includes(options.method)) headers.set('X-CSRF-Token', csrfToken);
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' }); }
  catch { throw new ApiRequestError('无法连接本地服务。请检查服务状态，再刷新任务记录。'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiError | null;
    if (response.status === 401 || response.status === 403) csrfToken = '';
    throw new ApiRequestError(body?.error?.message || `请求失败（${response.status}）`, body?.error?.code || 'HTTP_ERROR', response.status, body?.error?.details);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function json<T>(path: string, method: string, body: unknown): Promise<T> {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export const api = {
  projects: () => request<Project[]>('/projects'),
  createProject: (input: { name: string; brief: string; ratio: Ratio }) => json<Project>('/projects', 'POST', input),
  updateProject: (id: string, input: { name: string; brief: string; ratio: Ratio; expectedRevision: number }) => json<Project>(`/projects/${encodeURIComponent(id)}`, 'PUT', input),
  project: (id: string) => request<ProjectSnapshot>(`/projects/${encodeURIComponent(id)}`),
  importAsset: (projectId: string, file: File) => request<Artifact>(`/projects/${encodeURIComponent(projectId)}/assets?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  }),
  restoreAsset: (id: string, file: File) => request<void>(`/artifacts/${encodeURIComponent(id)}/restore?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  }),
  saveTimeline: (projectId: string, input: TimelineDraft, expectedVersion: number) => json<Timeline>(`/projects/${encodeURIComponent(projectId)}/timeline`, 'PUT', { ...input, expectedVersion }),
  export: (projectId: string, timelineId: string, clientRequestId: string) => json<Job>(`/projects/${encodeURIComponent(projectId)}/exports`, 'POST', { timelineId, clientRequestId }),
  cancelJob: (id: string) => json<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, 'POST', {}),
  health: () => request<Health>('/health'),
  settings: () => request<AppSettings>('/settings'),
  saveSettings: (input: AppSettings) => json<AppSettings>('/settings', 'PUT', input),
};

export function artifactUrl(id: string): string { return `/api/artifacts/${encodeURIComponent(id)}/content`; }
export function thumbnailUrl(id: string): string { return `/api/artifacts/${encodeURIComponent(id)}/thumbnail`; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
