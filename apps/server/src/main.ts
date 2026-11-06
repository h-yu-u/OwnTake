import { startServer } from './app.ts';
const app = await startServer();
console.log(`OwnTake is ready at ${app.url}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
