#!/usr/bin/env node
// Generates the ~10 consult scripts (spec §3.2) from a template with variables:
// patient name, payer, weeks of conservative therapy, PT provider mentioned,
// red flags (present/absent/not discussed). Each script has exactly one
// imaging-intent moment. Output: data/consults/*.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'consults');
mkdirSync(outDir, { recursive: true });

// therapy: {weeks} for explicit mention, {since:'mid-June'} for relative phrasing
const SCENARIOS = [
  {
    id: 'c-bluepeak-4wk', patient: 'Maria Alvarez', payer: 'bluepeak',
    therapy: { weeks: 4 }, provider: 'Dr. Rossi', notesAvailable: true, redflags: 'absent',
    title: 'BluePeak · 4 weeks PT — the first denial (demo beat 2–3)',
    expect: { therapy_weeks: 4, pt_notes_available: true, redflags: 'absent' },
  },
  {
    id: 'c-bluepeak-7wk', patient: 'James Okafor', payer: 'bluepeak',
    therapy: { since: 'mid-June' }, provider: 'Dr. Rossi', notesAvailable: true, redflags: 'absent',
    title: 'BluePeak · physio since mid-June (~7 wks) — the memory moment (demo beat 4)',
    expect: { pt_notes_available: true, redflags: 'absent' }, // therapy_weeks depends on consult date
  },
  {
    id: 'c-redflag', patient: 'Elena Petrova', payer: 'bluepeak',
    therapy: { weeks: 1 }, provider: null, notesAvailable: false, redflags: 'present',
    title: 'BluePeak · cauda equina red flags — expedited pathway',
    expect: { redflags: 'present' },
  },
  {
    id: 'c-calwest-3wk', patient: 'Dan Wheeler', payer: 'calwest',
    therapy: { weeks: 3 }, provider: 'the PT clinic on 5th', notesAvailable: false, redflags: 'absent',
    title: 'CalWest · 3 weeks — the easy approval',
    expect: { therapy_weeks: 3, redflags: 'absent' },
  },
  {
    id: 'c-meridian-5wk', patient: 'Priya Sharma', payer: 'meridian',
    therapy: { weeks: 5 }, provider: 'Dr. Nguyen', notesAvailable: true, redflags: 'absent',
    title: 'Meridian · 5 weeks — denied for the order form, appeal wins',
    expect: { therapy_weeks: 5, pt_notes_available: true, redflags: 'absent' },
  },
  {
    id: 'c-bluepeak-5wk', patient: 'Rosa Delgado', payer: 'bluepeak',
    therapy: { weeks: 5 }, provider: 'Dr. Rossi', notesAvailable: true, redflags: 'absent',
    title: 'BluePeak · 5 weeks — the honest gap (denied@4 vs approved@6, 5 untested)',
    expect: { therapy_weeks: 5, pt_notes_available: true, redflags: 'absent' },
  },
  {
    id: 'c-meridian-4wk', patient: 'Ken Watanabe', payer: 'meridian',
    therapy: { weeks: 4 }, provider: 'Dr. Nguyen', notesAvailable: false, redflags: 'absent',
    title: 'Meridian · exactly 4 weeks — approve once the form is learned',
    expect: { therapy_weeks: 4, redflags: 'absent' },
  },
  {
    id: 'c-bluepeak-noscreen', patient: 'Ahmed Haddad', payer: 'bluepeak',
    therapy: { weeks: 8 }, provider: 'Dr. Rossi', notesAvailable: true, redflags: 'not_discussed',
    title: 'BluePeak · 8 weeks but red flags never screened',
    expect: { therapy_weeks: 8, pt_notes_available: true, redflags: 'not_discussed' },
  },
  {
    id: 'c-meridian-3wk', patient: 'Lena Fischer', payer: 'meridian',
    therapy: { weeks: 3 }, provider: null, notesAvailable: false, redflags: 'absent',
    title: 'Meridian · 3 weeks — one week short (payer contrast with BluePeak)',
    expect: { therapy_weeks: 3, redflags: 'absent' },
  },
  {
    id: 'c-calwest-memorial', patient: 'Grace Kim', payer: 'calwest',
    therapy: { since: 'Memorial Day' }, provider: 'the PT clinic on 5th', notesAvailable: false, redflags: 'absent',
    title: 'CalWest · PT since Memorial Day (~10 wks) — relative-date inference',
    expect: { redflags: 'absent' },
  },
];

const PAYER_NAMES = { bluepeak: 'BluePeak Health', meridian: 'Meridian Care', calwest: 'CalWest Mutual' };

function utterances(s) {
  const u = [];
  const say = (speaker, text) => u.push({ speaker, text });
  const first = s.patient.split(' ')[0];

  say('doctor', `Come on in, ${first}. Last time we talked your lower back was still giving you trouble — how is it today?`);
  say('patient', `Honestly, not much better. It aches most of the day, and it shoots down my left leg when I sit too long.`);
  say('doctor', `That radiating pain down the leg — that sounds like sciatica. On a scale of one to ten, where is it this week?`);
  say('patient', `Around a six. Some mornings a seven.`);

  // Insurance mention (payer fact)
  say('doctor', `And before I forget for the paperwork — you're still on ${PAYER_NAMES[s.payer]} through work, right?`);
  say('patient', `Yes, same plan as last year, ${PAYER_NAMES[s.payer]}.`);

  // Conservative therapy (explicit weeks or relative date)
  if (s.therapy.since) {
    say('doctor', `And you've kept up the physical therapy we set up?`);
    say('patient', `I have. I've been doing physio ${s.therapy.since === 'Memorial Day' ? 'since around Memorial Day' : `since ${s.therapy.since}`}, twice a week, plus the ibuprofen when it flares.`);
  } else {
    say('doctor', `And you've kept up the physical therapy we set up?`);
    say('patient', `Yes — it's been about ${numberWord(s.therapy.weeks)} ${s.therapy.weeks === 1 ? 'week' : 'weeks'} now, twice a week, plus the ibuprofen when it flares.`);
  }
  if (s.provider) {
    say('doctor', `Good. That's with ${s.provider}, correct?`);
    say('patient', s.notesAvailable
      ? `Yes, with ${s.provider}. They said they can send over all my session notes if you need them.`
      : `Yes, with ${s.provider}.`);
  }

  // Red flag screening — or its absence
  if (s.redflags === 'present') {
    say('doctor', `I need to ask a few safety questions. Any numbness in the saddle area — groin, inner thighs? Any trouble controlling your bladder or bowels?`);
    say('patient', `Actually… yes. Since yesterday the inside of my thighs feels numb, and this morning I couldn't fully empty my bladder.`);
    say('doctor', `That combination is a red flag for cauda equina syndrome and we treat it as urgent. Any fevers, unexplained weight loss, or history of cancer?`);
    say('patient', `No fevers, no weight loss, no cancer history.`);
  } else if (s.redflags === 'absent') {
    say('doctor', `Quick safety screen: any numbness in the groin or inner thighs, any bladder or bowel trouble, fevers, unexplained weight loss, or history of cancer?`);
    say('patient', `No, none of that. Just the back and the leg.`);
    say('doctor', `Good — no red flags on screening, I'll note that.`);
  } // not_discussed: doctor skips the screen entirely

  // Exam beat (texture)
  say('doctor', `Let me take a look. Straight-leg raise on the left… tell me when it pulls.`);
  say('patient', `Right about there — that reproduces the shooting pain.`);

  // THE imaging-intent moment (exactly one per script)
  if (s.redflags === 'present') {
    say('doctor', `Given those symptoms I don't want to wait any longer — I'm ordering an MRI of your lumbar spine today, on an urgent basis.`);
    say('patient', `Okay. Whatever gets answers fastest.`);
  } else {
    say('doctor', `Given how persistent this is, I think it's time we get an MRI of your lumbar spine to look at that disc.`);
    say('patient', `I was hoping you'd say that. Will insurance cover it?`);
    say('doctor', `That's exactly what we're going to find out before you leave — the system is checking your plan as we speak.`);
  }

  say('doctor', `Keep up the exercises in the meantime, and I'll have the front desk follow up about scheduling.`);
  say('patient', `Thanks, doctor.`);
  return u;
}

function numberWord(n) {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
}

let written = 0;
for (const s of SCENARIOS) {
  const doc = {
    consult_id: s.id,
    title: s.title,
    patient: { id: `p-${s.id.replace(/^c-/, '')}`, name: s.patient },
    payer_id: s.payer,
    scenario: {
      therapy: s.therapy, provider: s.provider, notesAvailable: s.notesAvailable, redflags: s.redflags,
      expect: s.expect,
    },
    utterances: utterances(s),
  };
  writeFileSync(join(outDir, `${s.id}.json`), JSON.stringify(doc, null, 2));
  written += 1;
}
console.log(`wrote ${written} consult scripts to ${outDir}`);
