// Deterministic fact-extraction engine. This is BOTH the emergency fallback
// behind the LLM extraction agent AND the golden reference in tests. It must
// infer, not just match: "physio since mid-June" → weeks computed from the
// consult date (spec §6). Unknown/ambiguous → emit nothing.
//
// Fact enum (spec §6): therapy_weeks (number) · therapy_provider (string) ·
// pt_notes_available (bool) · redflags (present|absent|not_discussed) ·
// imaging_intent (bool) · payer_mention (string)
import { PAYERS } from '../domain/payers.js';
import { weeksBetween } from '../util.js';

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const THERAPY_CONTEXT = /\b(physio(?:therapy)?|physical therapy|\bPT\b|therapy|exercises)\b/i;
const SCREEN_QUESTION = /\b(saddle|groin|inner thighs?|bladder|bowel|fevers?|weight loss|history of cancer|safety (screen|questions))\b/i;

/**
 * @param {{speaker:string,text:string}} utterance
 * @param {{consultDate: Date, prev?: {speaker:string,text:string}}} ctx
 * @returns {Array<{type:string, value:any}>}
 */
export function extractFacts(utterance, ctx) {
  const facts = [];
  const text = utterance.text;
  const prevText = ctx.prev?.text || '';
  const therapyContext = THERAPY_CONTEXT.test(text) || THERAPY_CONTEXT.test(prevText);

  // payer_mention — any payer name spoken by anyone
  for (const p of Object.values(PAYERS)) {
    if (text.toLowerCase().includes(p.name.toLowerCase()) || new RegExp(`\\b${p.id}\\b`, 'i').test(text)) {
      facts.push({ type: 'payer_mention', value: p.id });
      break;
    }
  }

  // therapy_weeks — explicit duration or relative date, only in therapy context
  if (therapyContext) {
    const weeks = therapyWeeksFrom(text, ctx.consultDate);
    if (weeks !== null) facts.push({ type: 'therapy_weeks', value: weeks });

    // therapy_provider — "with Dr. Rossi" / "with the PT clinic on 5th"
    const provider = text.match(/\bwith ((?:Dr\.\s+[A-Z][a-zA-Z-]+)|(?:the [A-Za-z0-9 .'-]*?clinic[A-Za-z0-9 .'-]*?))(?=[,.?]|$)/);
    if (provider) facts.push({ type: 'therapy_provider', value: provider[1].trim() });
  }

  // pt_notes_available — provider can share session notes
  if (/\b(send over|share|forward|provide)\b.{0,30}\b(session )?(notes|charts|records)\b/i.test(text)) {
    facts.push({ type: 'pt_notes_available', value: true });
  }

  // redflags — present / absent (screening happened); silence = not_discussed
  if (/\b(cauda equina|red flag)/i.test(text) && /\b(is|are|that('s| is)) a red flag|cauda equina\b/i.test(text) && utterance.speaker === 'doctor' && !/\bno red flags?\b/i.test(text)) {
    facts.push({ type: 'redflags', value: 'present' });
  } else if (/\bno red flags?\b/i.test(text)) {
    facts.push({ type: 'redflags', value: 'absent' });
  } else if (utterance.speaker === 'patient' && SCREEN_QUESTION.test(prevText)) {
    // Patient answering the screening question. A "no" to ADDITIONAL flag
    // questions after a positive finding (prev asserts a red flag is present)
    // must not downgrade the consult to screen-negative.
    const prevAssertsPresent = /\b(red flag|cauda equina)\b/i.test(prevText) && !/\bno red flags?\b/i.test(prevText);
    if (/\b(yes|actually)\b/i.test(text) && /\b(numb|bladder|bowel|fever|weight)\b/i.test(text)) {
      facts.push({ type: 'redflags', value: 'present' });
    } else if (!prevAssertsPresent && /\b(no|none|neither)\b/i.test(text) && !/\byes\b/i.test(text)) {
      facts.push({ type: 'redflags', value: 'absent' });
    }
  }

  // imaging_intent — the doctor commits to ordering an imaging study
  if (utterance.speaker === 'doctor'
    && /\b(MRI|CT scan|CT|ultrasound)\b/i.test(text)
    && /\b(order(ing)?|get|time we get|I'm ordering|we should get|let's get)\b/i.test(text)) {
    facts.push({ type: 'imaging_intent', value: true });
  }

  return facts;
}

function therapyWeeksFrom(text, consultDate) {
  // "about four weeks now" / "6 weeks" / "for three weeks"
  const explicit = text.match(/\b(?:about |around |roughly )?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+weeks?\b/i);
  if (explicit) {
    const raw = explicit[1].toLowerCase();
    const n = NUMBER_WORDS[raw] ?? Number(raw);
    if (Number.isFinite(n)) return n;
  }

  // "since mid-June" / "since early July" / "since June" / "since June 15"
  const sinceMonth = text.match(/\bsince (?:around )?(early|mid|late)?[- ]?(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{1,2}))?\b/i);
  if (sinceMonth) {
    const [, mod, monthName, dayStr] = sinceMonth;
    const month = MONTHS.indexOf(monthName.toLowerCase());
    let day = dayStr ? Number(dayStr) : ({ early: 5, mid: 15, late: 25 }[mod?.toLowerCase()] ?? 15);
    let year = consultDate.getFullYear();
    const candidate = new Date(year, month, day);
    if (candidate > consultDate) candidate.setFullYear(year - 1); // "since June" said in Aug = this year; said in Jan = last year
    return weeksBetween(candidate, consultDate);
  }

  // "since Memorial Day" (last Monday of May, US)
  if (/\bsince (?:around )?memorial day\b/i.test(text)) {
    let year = consultDate.getFullYear();
    let md = lastMondayOfMay(year);
    if (md > consultDate) md = lastMondayOfMay(year - 1);
    return weeksBetween(md, consultDate);
  }

  return null;
}

function lastMondayOfMay(year) {
  const d = new Date(year, 4, 31);
  while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  return d;
}
