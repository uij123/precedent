// In-memory stream bus — the emergency fallback behind the LaserData adapter.
// Same contract: publish/subscribe/history per topic, delivery is async.

export function createLocalBus() {
  const topics = new Map(); // name -> { events: [], handlers: Set }

  function topic(name) {
    if (!topics.has(name)) topics.set(name, { events: [], handlers: new Set() });
    return topics.get(name);
  }

  return {
    mode: 'local',
    async publish(name, event) {
      const t = topic(name);
      t.events.push(event);
      if (t.events.length > 5000) t.events.splice(0, 1000);
      for (const h of t.handlers) {
        queueMicrotask(() => {
          Promise.resolve(h(event)).catch((e) => console.error(`[bus:${name}]`, e.message));
        });
      }
    },
    subscribe(name, handler) {
      const t = topic(name);
      t.handlers.add(handler);
      return () => t.handlers.delete(handler);
    },
    history(name, limit = 100) {
      return topic(name).events.slice(-limit);
    },
    /** Resolves once all queued deliveries have run (tests). */
    async idle() { await new Promise((r) => setTimeout(r, 0)); },
    async close() { topics.clear(); },
  };
}
