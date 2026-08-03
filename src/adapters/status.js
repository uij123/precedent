// Adapter mode registry — every sponsor seam reports whether it is running on
// the real service or the in-memory fallback. Shown as badges in the UI header
// so the demo is always honest about what is live (spec §1.5).

const adapters = new Map();

export function report(name, { mode, detail = '' }) {
  adapters.set(name, { name, mode, detail, at: new Date().toISOString() });
  console.log(`[adapter] ${name}: ${mode}${detail ? ` (${detail})` : ''}`);
}

export function adapterStatus() {
  return [...adapters.values()];
}
