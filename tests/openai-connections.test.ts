import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../packages/contracts/src/errors.ts';
import type { OpenAIConnectionInput, OpenAIConnectionSummary } from '../packages/contracts/src/openai.ts';
import type { ProviderProfile } from '../packages/contracts/src/providers.ts';
import type { ShotFields } from '../packages/contracts/src/storyboard.ts';
import { OPENAI_DEFAULT_MODELS } from '../packages/providers/src/openai-presets.ts';
import { Store, restoreBackup, SCHEMA_VERSION } from '../packages/storage/src/index.ts';
import type { StoreOptions } from '../packages/storage/src/store.ts';
import { StoryboardStore } from '../packages/storage/src/storyboard.ts';
import { ProviderRepository } from '../apps/server/src/provider-repository.ts';
import { OpenAIConnectionRepository } from '../apps/server/src/openai-connection-repository.ts';
import { GenerationRepository } from '../apps/server/src/generation-repository.ts';
import { RuntimeRepository } from '../apps/server/src/runtime-repository.ts';
import { StudioRepository } from '../apps/server/src/studio-repository.ts';

const originalKey = 'test-only-unified-openai-original';
const rotatedKey = 'test-only-unified-openai-rotated';
const input: OpenAIConnectionInput = { label: '我的 OpenAI', models: { ...OPENAI_DEFAULT_MODELS }, key: originalKey };
const reservation = { currency: 'USD' as const, amount: 0.1, singleLimit: 1, projectLimit: 10 };
const shotFields: ShotFields = {
  title: '雨夜来电', purpose: '建立悬念', description: '出租屋里亮着一盏台灯', action: '缓慢推进',
  durationMs: 5000, caption: '谁在敲门？', mode: 'generate_image', referenceArtifactIds: [],
};
const compatibleInput: Omit<ProviderProfile, 'id' | 'createdAt' | 'updatedAt'> = {
  label: '保留的兼容连接', kind: 'chat-completions', baseUrl: 'http://127.0.0.1:9401/v1',
  model: 'local-fixture-model', maxOutputTokens: 2048, timeoutMs: 1000,
  capabilities: { inputModes: ['text'], ratios: [], durationsSec: [], maxReferences: 0 },
};

function repositories(store: Store) {
  const board = new StoryboardStore(store), providers = new ProviderRepository(store, board);
  return {
    store, board, providers, connections: new OpenAIConnectionRepository(providers),
    generations: new GenerationRepository(store, board, providers),
    studio: new StudioRepository(store, board, providers, new RuntimeRepository(store)),
  };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'owntake-openai-'));
  const options = { dataDir: join(root, 'data'), projectsDir: join(root, 'projects') };
  const stores: Store[] = [];
  function open(target: StoreOptions = options) {
    const store = new Store(target); stores.push(store); return repositories(store);
  }
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, options, open, ...open() };
}

function vaultContents(store: Store): Record<string, string> {
  const path = join(store.dataDir, 'provider-credentials.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, string> : {};
}

function persistedConfiguration(store: Store) {
  return {
    accounts: store.db.prepare('SELECT * FROM openai_connections ORDER BY id').all(),
    profiles: store.db.prepare('SELECT * FROM provider_profiles ORDER BY id').all(),
    links: store.db.prepare('SELECT * FROM openai_connection_profiles ORDER BY connection_id,capability').all(),
  };
}

function sharedReference(providers: ProviderRepository, connection: OpenAIConnectionSummary): string {
  const references = Object.values(connection.profileIds).map(id => providers.getProfile(id).credentialRef);
  assert.equal(references.length, 3);
  assert.equal(new Set(references).size, 1, 'all execution profiles must share one immutable vault entry');
  assert.ok(references[0]);
  return references[0];
}

function noSecrets(value: unknown, ...keys: string[]): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const key of keys) assert.equal(serialized.includes(key), false, 'configuration and public data must not contain a key');
}

test('one OpenAI account provides three existing execution targets backed by one private key', t => {
  const f = fixture(t);
  const compatible = f.providers.saveProfile(compatibleInput);
  const connection = f.connections.save(input);
  assert.equal(connection.revision, 1);
  assert.equal(connection.hasKey, true);
  assert.equal(connection.verification, 'unverified');
  assert.deepEqual(connection.models, input.models);
  assert.deepEqual(f.connections.list(), [connection]);

  const profiles = f.providers.listProfiles().filter(profile => profile.connectionId === connection.id);
  assert.equal(profiles.length, 3);
  assert.deepEqual(profiles.map(profile => profile.kind).sort(), ['chat-completions', 'openai-images', 'openai-speech']);
  assert.ok(profiles.every(profile => profile.hasKey && profile.baseUrl === 'https://api.openai.com/v1'));
  const reference = sharedReference(f.providers, connection);
  assert.deepEqual(vaultContents(f.store), { [reference]: originalKey });
  if (process.platform !== 'win32') assert.equal(statSync(join(f.store.dataDir, 'provider-credentials.json')).mode & 0o777, 0o600);
  noSecrets([connection, profiles, persistedConfiguration(f.store)], originalKey);
  assert.equal(JSON.stringify([connection, profiles]).includes('credentialRef'), false);

  assert.deepEqual(f.providers.getProfile(compatible.id).profile, { ...compatibleInput, id: compatible.id, createdAt: compatible.createdAt, updatedAt: compatible.updatedAt });
  const edited = f.providers.saveProfile({ ...compatibleInput, label: '兼容连接仍可单独编辑' }, compatible.id);
  assert.equal(edited.label, '兼容连接仍可单独编辑');
  assert.equal(edited.connectionId, undefined);
  assert.throws(() => f.providers.saveProfile(compatibleInput, connection.profileIds.reasoning), { code: 'MANAGED_PROVIDER', status: 409 });
  assert.equal(sharedReference(f.providers, connection), reference);
});

test('one key rotation updates future targets while queued reasoning, image and speech tasks retain their original credentials', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-08T09:00:00.000Z') });
  const f = fixture(t), connection = f.connections.save(input);
  const reference = sharedReference(f.providers, connection);
  const project = f.store.createProject({ name: '借个声音', brief: '把雨夜配音的开场拆成六个镜头', ratio: '9:16' });
  const shot = f.board.addShot(project.id, shotFields, 0).shots[0]!;
  const originalProfiles = Object.fromEntries(Object.entries(connection.profileIds).map(([capability, id]) => [capability, f.providers.getProfile(id).profile]));
  const reasoningRequest = {
    providerId: connection.profileIds.reasoning, expectedProviderUpdatedAt: originalProfiles.reasoning!.updatedAt,
    clientRequestId: 'original-reasoning', expectedBoardRevision: f.board.snapshot(project.id).revision,
    expectedProjectRevision: project.revision, reservation,
  };
  const imageRequest = {
    providerId: connection.profileIds.image, expectedProviderUpdatedAt: originalProfiles.image!.updatedAt,
    clientRequestId: 'original-image', expectedShotRevision: shot.revision, reservation,
    plan: { kind: 'image', inputMode: 'text', prompt: '雨夜出租屋，暖色台灯', ratio: '9:16', referenceArtifactIds: [] },
  };
  const speechRequest = {
    kind: 'tts', targetId: connection.profileIds.speech, expectedTargetUpdatedAt: originalProfiles.speech!.updatedAt,
    clientRequestId: 'original-speech', reservation,
    input: { text: '谁在敲门？我来开。', voice: originalProfiles.speech!.capabilities.speech!.voices[0], speed: 1, instructions: null },
  };
  // Repository creation freezes real jobs without starting runners or making supplier requests.
  const call = f.providers.createReasoning(project.id, reasoningRequest);
  const generation = await f.generations.create(shot.id, imageRequest);
  const speech = f.studio.get(f.studio.create(project.id, speechRequest).id);
  assert.ok([call, generation, speech].every(record => record.status === 'queued' && record.credentialRef === reference));

  const updated = f.connections.save({ ...input, label: '已更新的 OpenAI', key: rotatedKey, expectedRevision: connection.revision }, connection.id);
  assert.equal(updated.revision, connection.revision + 1);
  assert.deepEqual(updated.profileIds, connection.profileIds, 'capability IDs are stable across account edits');
  assert.notEqual(updated.updatedAt, connection.updatedAt, 'same-millisecond edits must invalidate stale request reviews');
  const nextReference = sharedReference(f.providers, updated);
  assert.notEqual(nextReference, reference);
  assert.equal(f.providers.vault.get(reference), originalKey);
  assert.equal(f.providers.vault.get(nextReference), rotatedKey);
  assert.equal(Object.keys(vaultContents(f.store)).length, 2, 'a rotation stores one new key, not three');

  assert.deepEqual(f.providers.getCall(call.id), call);
  assert.deepEqual(f.generations.get(generation.id), generation);
  assert.deepEqual(f.studio.get(speech.id), speech);
  assert.deepEqual(f.providers.createReasoning(project.id, reasoningRequest), call);
  assert.deepEqual(await f.generations.create(shot.id, imageRequest), generation);
  assert.deepEqual(f.studio.create(project.id, speechRequest), speech);
  assert.throws(() => f.providers.createReasoning(project.id, { ...reasoningRequest, clientRequestId: 'stale-reasoning' }), { code: 'PROVIDER_CHANGED', status: 409 });
  await assert.rejects(f.generations.create(shot.id, { ...imageRequest, clientRequestId: 'stale-image' }), { code: 'PROVIDER_CHANGED', status: 409 });
  assert.throws(() => f.studio.create(project.id, { ...speechRequest, clientRequestId: 'stale-speech' }), { code: 'TARGET_CHANGED', status: 409 });

  const newProfile = f.providers.getProfile(updated.profileIds.reasoning).profile;
  const nextCall = f.providers.createReasoning(project.id, { ...reasoningRequest, clientRequestId: 'new-reasoning', expectedProviderUpdatedAt: newProfile.updatedAt });
  assert.equal(nextCall.credentialRef, nextReference);
  noSecrets([f.providers.listCalls(project.id), f.generations.list(project.id), f.studio.list(project.id)], originalKey, rotatedKey);
});

test('invalid or stale account edits do not partially change profiles or rotate a credential', t => {
  const f = fixture(t);
  assert.throws(() => f.connections.save({ ...input, key: '' }), { code: 'CREDENTIAL_REQUIRED', status: 409 });
  assert.equal(f.connections.list().length, 0);
  assert.equal(f.providers.listProfiles().length, 0);
  assert.deepEqual(vaultContents(f.store), {});

  const connection = f.connections.save(input);
  const snapshot = persistedConfiguration(f.store), vault = vaultContents(f.store);
  const edit = { ...input, key: rotatedKey, expectedRevision: connection.revision };
  for (const value of [
    { ...edit, models: { ...input.models, speech: '' } },
    { ...edit, models: { ...input.models, image: 123 } },
    { ...edit, baseUrl: 'https://other-service.invalid/v1' },
    { ...edit, models: { ...input.models, injected: 'ignored-if-not-validated' } },
    { ...edit, key: 'test-key\ninvalid' },
    { ...edit, expectedRevision: undefined },
  ]) {
    assert.throws(() => f.connections.save(value, connection.id), error => error instanceof AppError && error.status === 400);
    assert.deepEqual(persistedConfiguration(f.store), snapshot);
    assert.deepEqual(vaultContents(f.store), vault);
  }
  assert.throws(() => f.connections.save({ ...edit, expectedRevision: connection.revision + 1 }, connection.id), { code: 'REVISION_CONFLICT', status: 409 });
  assert.deepEqual(persistedConfiguration(f.store), snapshot);
  assert.deepEqual(vaultContents(f.store), vault);

  const kept = f.connections.save({ ...input, key: '', label: '调整模型，保留密钥', models: { ...input.models, reasoning: 'configured-reasoning-model' }, expectedRevision: connection.revision }, connection.id);
  assert.deepEqual(kept.profileIds, connection.profileIds);
  assert.equal(f.providers.getProfile(kept.profileIds.reasoning).profile.model, 'configured-reasoning-model');
  assert.equal(f.providers.getProfile(kept.profileIds.image).profile.model, input.models.image);
  assert.equal(f.providers.getProfile(kept.profileIds.speech).profile.model, input.models.speech);
  assert.deepEqual(vaultContents(f.store), vault, 'an empty key on edit preserves the shared credential');
});

test('a database failure during a child-profile write rolls back the complete connection change', t => {
  const f = fixture(t);
  f.store.db.exec(`CREATE TRIGGER fail_openai_speech_insert BEFORE INSERT ON provider_profiles
    WHEN json_extract(NEW.body_json,'$.kind')='openai-speech'
    BEGIN SELECT RAISE(ABORT,'fixture child profile failure'); END;`);
  assert.throws(() => f.connections.save(input), /fixture child profile failure/);
  assert.deepEqual(persistedConfiguration(f.store), { accounts: [], profiles: [], links: [] });
  f.store.db.exec('DROP TRIGGER fail_openai_speech_insert');

  const connection = f.connections.save(input), snapshot = persistedConfiguration(f.store);
  const originalReference = sharedReference(f.providers, connection);
  f.store.db.exec(`CREATE TRIGGER fail_openai_speech_update BEFORE UPDATE ON provider_profiles
    WHEN json_extract(NEW.body_json,'$.kind')='openai-speech'
    BEGIN SELECT RAISE(ABORT,'fixture child profile failure'); END;`);
  assert.throws(() => f.connections.save({ ...input, key: rotatedKey, expectedRevision: connection.revision }, connection.id), /fixture child profile failure/);
  assert.deepEqual(persistedConfiguration(f.store), snapshot);
  assert.equal(sharedReference(f.providers, f.connections.get(connection.id)), originalReference);
  assert.equal(f.providers.vault.get(originalReference), originalKey);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('shared connections survive restart and a credential-free backup can be repaired with one key', async t => {
  const f = fixture(t), connection = f.connections.save(input);
  const originalReference = sharedReference(f.providers, connection);
  const project = f.store.createProject({ name: '保留的项目', brief: '备份应保留作品和连接配置' });
  f.store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.connections.get(connection.id), connection);
  assert.equal(sharedReference(reopened.providers, connection), originalReference);
  assert.equal(reopened.providers.vault.get(originalReference), originalKey);

  const backup = join(f.root, 'portable-backup'), manifest = await reopened.store.backupTo(backup);
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.credentialsIncluded, false);
  assert.equal(readdirSync(backup, { recursive: true }).some(path => String(path).includes('provider-credentials')), false);
  assert.equal(readFileSync(join(backup, 'app.sqlite')).includes(Buffer.from(originalKey)), false);
  const restoredOptions = { dataDir: join(f.root, 'restored-data'), projectsDir: join(f.root, 'restored-projects') };
  await restoreBackup(backup, restoredOptions);
  const restored = f.open(restoredOptions), missingKey = restored.connections.get(connection.id);
  assert.equal(restored.store.getProject(project.id).name, project.name);
  assert.deepEqual(missingKey.profileIds, connection.profileIds);
  assert.equal(missingKey.hasKey, false);
  assert.ok(restored.providers.listProfiles().every(profile => !profile.hasKey));
  assert.throws(() => restored.connections.save({ label: missingKey.label, models: missingKey.models, expectedRevision: missingKey.revision }, missingKey.id), { code: 'CREDENTIAL_REQUIRED', status: 409 });

  const repaired = restored.connections.save({ ...input, key: rotatedKey, expectedRevision: missingKey.revision }, missingKey.id);
  const repairedReference = sharedReference(restored.providers, repaired);
  assert.equal(repaired.hasKey, true);
  assert.ok(restored.providers.listProfiles().every(profile => profile.hasKey));
  assert.deepEqual(vaultContents(restored.store), { [repairedReference]: rotatedKey });
  assert.equal(restored.providers.vault.has(originalReference), false, 'restoring a new key must not impersonate credentials frozen in old tasks');
});

test('the schema migration preserves an existing independent protocol connection and its credential', t => {
  const f = fixture(t);
  const compatible = f.providers.saveProfile({ ...compatibleInput, key: originalKey });
  const before = f.providers.getProfile(compatible.id);
  // Remove the newly added tables to obtain the actual prior schema, not just a version label.
  f.store.db.exec('DROP TABLE openai_connection_profiles; DROP TABLE openai_connections; PRAGMA user_version=5;');
  f.store.close();
  const migrated = f.open();
  assert.equal(migrated.store.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.store.migrationSnapshot?.manifest.fromSchemaVersion, 5);
  assert.equal(migrated.store.migrationSnapshot?.manifest.toSchemaVersion, SCHEMA_VERSION);
  assert.deepEqual(migrated.providers.getProfile(compatible.id), before);
  assert.equal(migrated.providers.vault.get(before.credentialRef), originalKey);
  const connected = migrated.connections.save({ ...input, key: rotatedKey });
  assert.equal(migrated.providers.listProfiles().length, 4);
  assert.equal(migrated.providers.getProfile(compatible.id).credentialRef, before.credentialRef);
  assert.equal(migrated.providers.vault.get(sharedReference(migrated.providers, connected)), rotatedKey);
  assert.deepEqual(migrated.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});
