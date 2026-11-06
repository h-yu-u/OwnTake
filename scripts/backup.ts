import { resolve } from 'node:path';
import { serverConfig } from '../apps/server/src/config.ts';
import { acquireLock } from '../apps/server/src/instance-lock.ts';
import { Store, restoreBackup } from '../packages/storage/src/index.ts';
const [command, destination] = process.argv.slice(2);
if (!['create', 'restore'].includes(command || '') || !destination) {
  console.error('Usage: npm run backup -- create|restore /absolute/backup-directory'); process.exit(1);
}
const config = serverConfig();
if (command === 'restore') {
  await restoreBackup(resolve(destination), { dataDir: config.dataDir, projectsDir: config.projectsDir });
  console.log('Backup restored. Start OwnTake to verify projects.');
} else {
  const release = await acquireLock(config.dataDir); const store = new Store(config);
  try { await store.backupTo(resolve(destination)); console.log('Backup completed.'); } finally { store.close(); await release(); }
}
