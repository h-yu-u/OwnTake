import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/storage/src/store.ts';
import { StoryRepository } from '../packages/storage/src/story-repository.ts';
import { AppError } from '../packages/contracts/src/errors.ts';
import { buildApp } from '../apps/server/src/app.ts';

const original = {
  title: '深夜出租车', genre: '悬疑', summary: '一个司机遇到来自未来的乘客',
  tags: ['反转','都市'], beats: ['深夜上车','未来预告','悬念揭晓'],
  source: { platform: 'original' as const, url: '', title: '', author: '', rights: 'original' as const },
};
function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'owntake-story-'));
  const store = new Store({ dataDir: join(root,'data'), projectsDir: join(root,'projects') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, stories: new StoryRepository(store) };
}

test('stories preserve immutable versions, reject stale editors and link a frozen story to a project', t => {
  const { store, stories } = fixture(t);
  const item = stories.create(original);
  assert.equal(item.revision, 1);
  assert.equal(stories.list('出租车').length, 1);
  assert.equal(stories.list('不存在').length, 0);
  const changed = stories.update(item.id, { ...original, title: '午夜末班车', beats: ['开始','结束'] }, 1);
  assert.equal(changed.revision, 2);
  assert.equal(stories.versions(item.id)[0]?.title, original.title);
  assert.equal(stories.version(item.id, 2).beats.length, 2);
  assert.throws(() => stories.update(item.id, original, 1), (error: unknown) => error instanceof AppError && error.code === 'REVISION_CONFLICT');
  const script = stories.saveScript(item.id, 2, '场景一：深夜\n司机：你是谁？');
  stories.saveScript(item.id, 2, '场景二：结局');
  assert.equal(stories.script(item.id, 1).text, script.text);
  const { project, link } = stories.createProject(item.id, 2, script.version, '9:16');
  assert.equal(link.scriptVersion, 1);
  assert.equal(store.getProject(project.id).ratio, '9:16');
  assert.match(project.brief, /场景一/);
  assert.deepEqual(stories.links(item.id)[0], link);
});

test('unlicensed external stories can be saved as inspiration but not silently adapted', t => {
  const { stories } = fixture(t);
  const input = { ...original, source: { platform: 'zhihu', url: 'https://www.zhihu.com/question/123', title: '原帖', author: '作者', rights: 'inspiration_only' } };
  const item = stories.create(input);
  assert.throws(() => stories.createProject(item.id, 1, null, '16:9'), (error: unknown) => error instanceof AppError && error.code === 'STORY_RIGHTS_REQUIRED');
  assert.throws(() => stories.create({ ...input, source: { ...input.source, url: 'http://unsafe.invalid' } }), /来源仅接受安全的 HTTPS 链接/);
});

test('Fastify story routes require a session and CSRF and reject injected invalid versions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'owntake-story-api-'));
  const app = await buildApp({ dataDir: join(root,'data'), projectsDir: join(root,'projects'), port: 0 });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const denied = await app.inject({ method: 'GET', url: '/api/stories' });
  assert.equal(denied.statusCode, 401);
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  const cookie = session.headers['set-cookie'] as string;
  const token = session.json<{csrfToken: string}>().csrfToken;
  const created = await app.inject({ method: 'POST', url:'/api/stories', headers: { cookie, 'x-csrf-token': token }, payload: original });
  assert.equal(created.statusCode, 201, created.body);
  const storyId = created.json<{id:string}>().id;
  const invalid = await app.inject({ method:'POST',url:`/api/stories/${storyId}/scripts`,headers:{cookie,'x-csrf-token':token},payload:{ sourceVersion: 99,text:'something' }});
  assert.equal(invalid.statusCode, 404, invalid.body);
  const found = await app.inject({ method:'GET',url:'/api/stories',headers:{cookie} });
  assert.equal(found.json<unknown[]>().length,1);
});
