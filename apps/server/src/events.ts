import type { ServerResponse } from 'node:http';
import type { Store } from '../../../packages/storage/src/index.ts';
export function eventStream(store: Store, projectId: string, after: number, response: ServerResponse): () => void {
  store.getProject(projectId);
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.write('retry: 1500\n\n'); let cursor = after;
  const flush = () => {
    for (const event of store.listEvents(projectId, cursor)) {
      response.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.seq;
    }
  };
  flush(); const timer = setInterval(flush, 500); timer.unref();
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000); heartbeat.unref();
  const stop = () => { clearInterval(timer); clearInterval(heartbeat); response.end(); };
  response.on('close', stop); return stop;
}
