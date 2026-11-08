import { randomUUID } from 'node:crypto';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import type { OpenAIConnection, OpenAIConnectionSummary } from '../../../packages/contracts/src/openai.ts';
import { resourceId } from '../../../packages/domain/src/validation.ts';
import { OPENAI_CAPABILITIES } from '../../../packages/providers/src/openai-presets.ts';
import { openAIProfiles, parseOpenAIConnectionInput } from '../../../packages/providers/src/openai.ts';
import type { ProviderRepository } from './provider-repository.ts';

interface StoredConnection { connection: OpenAIConnection; credentialRef: string }

/** Owns one account and its three stable execution profiles; never calls the supplier. */
export class OpenAIConnectionRepository {
  readonly providers: ProviderRepository;

  constructor(providers: ProviderRepository) { this.providers = providers; }

  private stored(id: string): StoredConnection {
    const row = this.providers.store.db.prepare('SELECT body_json,credential_ref FROM openai_connections WHERE id=?').get(resourceId(id));
    if (!row) throw new AppError('OPENAI_CONNECTION_NOT_FOUND', 'OpenAI 连接不存在。', 404);
    return { connection: JSON.parse(String(row.body_json)) as OpenAIConnection, credentialRef: String(row.credential_ref) };
  }

  private summary(stored: StoredConnection): OpenAIConnectionSummary {
    return { ...stored.connection, hasKey: this.providers.vault.has(stored.credentialRef), verification: 'unverified' };
  }

  get(id: string): OpenAIConnectionSummary { return this.summary(this.stored(id)); }

  list(): OpenAIConnectionSummary[] {
    return this.providers.store.db.prepare('SELECT id FROM openai_connections ORDER BY rowid').all()
      .map(row => this.get(String(row.id)));
  }

  save(value: unknown, existingId?: string): OpenAIConnectionSummary {
    const input = parseOpenAIConnectionInput(value, existingId !== undefined);
    return this.providers.store.transaction(() => {
      const previous = existingId ? this.stored(existingId) : undefined;
      invariant(!previous || previous.connection.revision === input.expectedRevision,
        'REVISION_CONFLICT', 'OpenAI 连接已更新，请刷新后重新编辑。', 409);
      const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.connection.updatedAt) + 1 : 0)).toISOString();
      const connection: OpenAIConnection = {
        id: previous?.connection.id ?? randomUUID(), label: input.label, models: input.models,
        profileIds: previous?.connection.profileIds ?? { reasoning: randomUUID(), image: randomUUID(), speech: randomUUID() },
        revision: (previous?.connection.revision ?? 0) + 1,
        createdAt: previous?.connection.createdAt ?? now, updatedAt: now,
      };
      const profiles = openAIProfiles(connection);
      invariant(input.key || previous && this.providers.vault.has(previous.credentialRef),
        'CREDENTIAL_REQUIRED', '请填写 OpenAI API Key；恢复备份后也需要重新配置密钥。', 409);
      // A rotation creates one new immutable vault entry. Frozen tasks retain the old reference.
      const credentialRef = input.key ? this.providers.vault.put(input.key) : previous!.credentialRef;
      this.providers.store.db.prepare(`INSERT INTO openai_connections(id,body_json,credential_ref) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json,credential_ref=excluded.credential_ref`)
        .run(connection.id, JSON.stringify(connection), credentialRef);
      for (const capability of OPENAI_CAPABILITIES) {
        this.providers.persistProfile(profiles[capability], credentialRef);
        this.providers.store.db.prepare(`INSERT INTO openai_connection_profiles(connection_id,capability,provider_id) VALUES(?,?,?)
          ON CONFLICT(connection_id,capability) DO UPDATE SET provider_id=excluded.provider_id`)
          .run(connection.id, capability, connection.profileIds[capability]);
      }
      return this.summary({ connection, credentialRef });
    });
  }
}
