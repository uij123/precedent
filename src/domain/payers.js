// Payer registry: identities only. Coverage rules live EXCLUSIVELY in the
// verdict simulator (src/domain/verdict-sim.js) — the app must learn them.

export const PAYERS = {
  bluepeak: { id: 'bluepeak', name: 'BluePeak Health', plan: 'BluePeak PPO Select' },
  meridian: { id: 'meridian', name: 'Meridian Care', plan: 'Meridian Choice HMO' },
  calwest: { id: 'calwest', name: 'CalWest Mutual', plan: 'CalWest Advantage' },
  atlas: { id: 'atlas', name: 'Atlas Health Plan', plan: 'Atlas Complete PPO' },
  pinnacle: { id: 'pinnacle', name: 'Pinnacle Care', plan: 'Pinnacle Direct EPO' },
  sequoia: { id: 'sequoia', name: 'Sequoia Mutual', plan: 'Sequoia Classic' },
};

export const PAYER_IDS = Object.keys(PAYERS);

// Advanced-imaging studies the synthetic world orders. Learning stays keyed
// by (payer, requirement); the graph records which studies each rule was
// observed on via FOR_PROCEDURE links.
export const PROCEDURES = {
  '72148': { cpt: '72148', label: 'MRI lumbar spine without contrast', short: 'MRI lumbar' },
  '70551': { cpt: '70551', label: 'MRI brain without contrast', short: 'MRI brain' },
  '73721': { cpt: '73721', label: 'MRI knee without contrast', short: 'MRI knee' },
  '72131': { cpt: '72131', label: 'CT lumbar spine without contrast', short: 'CT lumbar' },
  '74177': { cpt: '74177', label: 'CT abdomen and pelvis with contrast', short: 'CT abdomen' },
  '76700': { cpt: '76700', label: 'Ultrasound abdomen, complete', short: 'US abdomen' },
};
export const PROCEDURE = PROCEDURES['72148']; // default study
export function procedureLabel(cpt) { return PROCEDURES[cpt]?.label || PROCEDURE.label; }
export function procedureShort(cpt) { return PROCEDURES[cpt]?.short || PROCEDURE.short; }

export const DIAGNOSIS = { code: 'M54.5', label: 'Low back pain' };

export function payerName(id) {
  return PAYERS[id]?.name || id;
}
