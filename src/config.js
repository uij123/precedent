// Central configuration. Everything overridable by env; defaults tuned for the live demo.

export const config = {
  appPort: num('PORT', 7400),
  payerPort: num('PAYER_PORT', 7402),

  // Payer simulator processing delay (per spec §10: ~20s demo, 3s testing)
  payerDelayMs: num('PAYER_DELAY_MS', 20_000),
  payerDelayFastMs: 3_000,

  // Background world generator (spec §3.3: 1 event / 5–10 s default)
  backgroundMinMs: num('BG_MIN_MS', 5_000),
  backgroundMaxMs: num('BG_MAX_MS', 10_000),
  worldSeed: num('WORLD_SEED', 20260803),

  // Sponsor / service endpoints
  laserConnectionString: process.env.LASER_CONNECTION_STRING || 'iggy:laser@127.0.0.1:8090',
  laserStream: process.env.LASER_STREAM || 'precedent',
  falkordbUrl: process.env.FALKORDB_URL || 'redis://127.0.0.1:6379',
  falkordbGraph: process.env.FALKORDB_GRAPH || 'precedent',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite',
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || 'Precedent <onboarding@resend.dev>', // Resend's universal test sender
  emailTo: process.env.EMAIL_TO || 'demo-inbox@precedent.example',
  rocketrideApiKey: process.env.ROCKETRIDE_API_KEY || '',
  guildWorkspace: process.env.GUILD_WORKSPACE || '',

  // Force local fallbacks even if services are reachable (demo safety switch)
  forceLocal: (process.env.FORCE_LOCAL || '').split(',').filter(Boolean), // e.g. "bus,graph"

  // Interjection discipline (spec §7)
  maxInterjectionsPerConsult: 2,

  // Aging thresholds for the manager console (spec §11A)
  agingAmberMs: num('AGING_AMBER_MS', 5 * 60_000),
  agingRedMs: num('AGING_RED_MS', 10 * 60_000),
  humanApprovalAlertMs: num('HUMAN_ALERT_MS', 10 * 60_000),
};

// Benchmark constants for the ROI module (spec §11B) — sources shown in UI tooltips.
export const ROI = {
  MANUAL_COST_PER_PA: { value: 10.97, unit: '$', source: 'CAQH 2023 Index (provider cost per manual PA transaction)' },
  ELECTRONIC_COST_PER_PA: { value: 5.79, unit: '$', source: 'CAQH 2023 Index' },
  MANUAL_MINUTES_PER_PA_SPECIALIST: { value: 24, unit: 'min', source: 'CAQH 2023 Index (specialist, manual)' },
  MANUAL_MINUTES_SAVED_ELECTRONIC: { value: 14, unit: 'min', source: 'CAQH 2024 Index' },
  REWORK_COST_PER_DENIAL: { value: 25, unit: '$', source: 'industry estimate (denial rework/appeal)' },
  PA_STAFF_HOURLY: { value: 24, unit: '$/hr', source: 'derived from $45–55k PA-specialist salary' },
  PHYSICIAN_HOURLY: { value: 150, unit: '$/hr', source: 'standard business-case value' },
  WEEKLY_PA_BURDEN_PER_PHYSICIAN: { value: '13 hrs, ~40 PAs', unit: '', source: 'AMA 2025 survey' },
};

// Price per million tokens, USD. Used by the token meter (spec §11B).
// Defaults match claude-opus-5 ($5 in / $25 out per MTok); override by env
// alongside ANTHROPIC_MODEL if you switch models.
export const MODEL_PRICE_PER_MTOKEN = {
  input: num('PRICE_IN_PER_MTOK', 5.0),
  output: num('PRICE_OUT_PER_MTOK', 25.0),
};

function num(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== '' ? v : dflt;
}
