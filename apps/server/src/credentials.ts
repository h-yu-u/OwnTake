import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
/** Versioned keys let in-flight calls keep their original account after a profile edit. */
export class CredentialVault {
  private path: string;
  private values: Record<string, string>;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'provider-credentials.json');
    try { this.values = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string> : {}; }
    catch { throw new AppError('CREDENTIALS_INVALID', '凭据文件无法读取，请保留原文件并检查格式', 500); }
    invariant(this.values && typeof this.values === 'object' && !Array.isArray(this.values), 'CREDENTIALS_INVALID', '凭据文件无法读取', 500);
    if (existsSync(this.path)) chmodSync(this.path, 0o600);
  }
  put(key: string): string {
    invariant(typeof key === 'string' && key.length <= 8192 && !/[\u0000-\u0020\u007f-\uffff]/.test(key), 'INVALID_KEY', 'API 密钥应为不含空白或控制字符的 ASCII 文本');
    const id = randomUUID(), values = { ...this.values, [id]: key }, temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(values), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); this.values = values; return id;
  }
  get(id: string | null): string {
    if (!id) return '';
    invariant(Object.hasOwn(this.values, id) && typeof this.values[id] === 'string', 'CREDENTIAL_MISSING', '该调用绑定的凭据不可用，请检查原连接账号', 409);
    return this.values[id]!;
  }
  has(id: string | null): boolean { return Boolean(id && this.values[id]); }
}
