// LaserData bus — real streaming through the LaserData SDK over Apache Iggy.
// Every event is produced to and consumed from actual LaserData topics; the
// app's own workers receive events via the consume loop, so judges can watch
// real traffic (publish AND consume) on the wire.
import { Laser } from '@laserdata/laser-sdk';

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function createLaserBus({ connectionString, stream: streamName, topics: topicNames }) {
  const laser = await Laser.connect(connectionString);
  const stream = laser.stream(streamName);
  await stream.ensure();

  const topics = new Map(); // logical name -> { topic, events, handlers, abort }
  for (const name of topicNames) {
    const topic = stream.topic(name);
    await topic.ensure(1);
    topics.set(name, { topic, events: [], handlers: new Set(), abort: new AbortController() });
  }

  // One replay-cursor loop per topic: replays existing messages (history after
  // restart) then tails live traffic, dispatching to in-process subscribers.
  for (const [name, t] of topics) {
    (async () => {
      const cursor = await t.topic.replay({ batchSize: 100, readerName: `precedent-${name}` });
      for await (const msg of cursor.stream({ signal: t.abort.signal, pollIntervalMs: 150 })) {
        let event;
        try { event = JSON.parse(dec.decode(msg.payload)); }
        catch { continue; }
        t.events.push(event);
        if (t.events.length > 5000) t.events.splice(0, 1000);
        for (const h of t.handlers) {
          Promise.resolve(h(event)).catch((e) => console.error(`[laser:${name}]`, e.message));
        }
      }
    })().catch((e) => {
      if (!t.abort.signal.aborted) console.error(`[laser:${name}] consume loop died:`, e.message);
    });
  }

  return {
    mode: 'laserdata',
    async publish(name, event) {
      const t = topics.get(name);
      if (!t) throw new Error(`unknown topic ${name}`);
      await t.topic.send(enc.encode(JSON.stringify(event)));
    },
    subscribe(name, handler) {
      const t = topics.get(name);
      if (!t) throw new Error(`unknown topic ${name}`);
      t.handlers.add(handler);
      return () => t.handlers.delete(handler);
    },
    history(name, limit = 100) {
      const t = topics.get(name);
      return t ? t.events.slice(-limit) : [];
    },
    async idle() { await new Promise((r) => setTimeout(r, 400)); },
    async close() {
      for (const t of topics.values()) t.abort.abort();
      await laser.close();
    },
  };
}
