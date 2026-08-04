# The three-minute sales demo

Audience-facing tab: `http://localhost:7400` (Consult + Practice manager only).
Driver tab (yours): `http://localhost:7400/?admin=1`.

## Before the meeting (5 minutes, once)

```bash
docker start falkordb && (cd laser-stack && ./scripts/up)   # if not running
npm start                                                   # UI on :7400
```

In the driver tab, Admin: **Verdicts in 3 s** on, **Seed ×500** once, **Start**
the background world at *Every 5–10 s*. Open both tabs side by side. Run
`npm test` once so you can say "fifty-five tests passed this morning."

## Beat 1 — the real answer (30 seconds)

Audience tab, Consult, type into the copilot:

> does Blue Shield require prior auth for a lumbar MRI 72148?

It answers from Blue Shield of California's actual August list: PA required,
managed by RadMD, with the state's own number — 48% of appealed imaging
denials get overturned — and the snapshot hash the fact traces to.

Say: **"No AI wrote that answer. It's a pure lookup over the payer's real
document, and every line cites its source. Ask it about UnitedHealthcare,
Health Net, Kaiser — seven California payer lines are loaded."**

## Beat 2 — the loop (75 seconds)

Driver tab: pick *Maria Alvarez · BluePeak · the first denial*, speed **Fast**,
**Replay consult**. The audience tab jumps to the live visit.

- Transcript streams; Captured details fill in plain language.
- The copilot interjects before the doctor orders: denial expected, with the
  exact gap. **Click "Sources"** — the prior denials that taught the rule.
- **Prepare submission** → two agents debate → checklist → **Approve and
  execute** → packet PDFs emailed → 3 seconds → denied → the graph learns
  on screen.

Then *James Okafor · the memory moment*: sharper prediction, checklist
auto-includes PT notes, approved first pass.

Say: **"It started knowing zero payer rules. Everything it just used, it
learned from outcomes — and every claim was auditable down to the evidence."**

## Beat 3 — the money (30 seconds)

Audience tab, Practice manager: the claims table — every prior auth, its
stage, who it's waiting on, the next step, and **would-cost vs actual vs
saved per claim**, metered, not estimated.

## Beat 4 — the depth (30 seconds)

Driver tab, Admin: **California coverage** (seven payer lines, 4,700+ codes,
every row snapshot-stamped), the **Memory graph**, and — if they're technical
— **Run tests** live: the suite includes a battery that replays all 42,749
of California's published IMR determinations against the system.

## Close (30 seconds)

**"The engine is open source — you can read every line of the thing that
listens to your patients. What you subscribe to is the living rulebook: we
watch every payer document so your staff doesn't have to. Free for the first
pilot clinics."**

## If something breaks

- Mic requested → press **F**: scripted replay, identical pipeline. Say so.
- Backend dies → adapter badges flip to *fallback*, demo keeps working on
  labeled in-memory twins. That honesty is itself a selling point.
- Copilot question misfires → terminal:
  `node src/pa-graph/cli.js resolve blueshield_ca commercial 72148`
- Total failure → the recorded demo page (artifact link in the pitch doc).
