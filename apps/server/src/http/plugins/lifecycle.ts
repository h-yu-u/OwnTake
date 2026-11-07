import type { FastifyInstance } from 'fastify';

/** A closed socket does not mean its asynchronous application work has finished. */
export function trackHandlers(app: FastifyInstance): () => Promise<void> {
  const active = new Set<Promise<unknown>>();
  app.addHook('onRoute', route => {
    const handler = route.handler;
    route.handler = function (request, reply) {
      const result = handler.call(this, request, reply);
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
        const pending = Promise.resolve(result);
        active.add(pending);
        // Observe both outcomes without swallowing the rejection returned to Fastify.
        void pending.then(() => active.delete(pending), () => active.delete(pending));
      }
      // Keep synchronous and callback-style framework/plugin handlers unchanged.
      return result;
    };
  });
  // The listener has closed before this is called. Drain application work before
  // disposing its database, including handlers whose client already disconnected.
  return async () => {
    while (active.size) await Promise.allSettled([...active]);
  };
}
