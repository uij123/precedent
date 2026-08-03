# Precedent — prior auth that remembers

*Built at the Memory Meets Motion hackathon · Frontier Tower SF · Aug 3 2026.*
*Official requirements: [hackathon doc](https://docs.google.com/document/d/1f7mms4ZMx3WXzWnvR80Dlzny8RiOdVXzh86YXMksF84/edit).*

## What it does

Prior authorization is the paperwork wall between a doctor ordering an imaging
study and an insurer agreeing to pay for it. Clinics burn staff hours per
request, denials arrive weeks late, and the payer's real rules are never
written down anywhere a clinic can read.

Precedent is a copilot that sits in the visit and closes that loop:

1. **Listens** to the doctor–patient conversation (live mic or scripted
   replay) and transcribes it in real time, tagging who is speaking.
2. **Extracts** the facts that matter — payer, weeks of conservative therapy,
   red-flag screening, notes availability — into a knowledge graph.
3. **Predicts the payer's answer before the doctor orders**, computed
   deterministically against a rulebook the system has *learned* — the app
   starts knowing zero payer rules and learns them all from streamed verdict
   outcomes across a network of clinics.
4. **Shows its sources.** Every claim ("BluePeak requires 6 weeks of therapy")
   is clickable down to the exact prior denials that taught it — clinic,
   weeks documented, date. PA staff can audit anything the copilot says.
5. **Waits for a human.** Two specialist agents debate the packet, then an
   approval checklist appears in chat. Nothing executes before the click.
6. **Executes**: assembles the payer-specific packet (synthetic PDFs), emails
   it with the confirmation, submits, and tracks the claim to a verdict.
7. **Learns from the verdict** — approved or denied, the outcome is written
   back to the graph, and the *next* clinic's prediction is sharper. The
   whole network compounds.

Three views: **Consult** (what a practitioner sees: visits rail, live
transcript, copilot — nothing technical), **Practice manager** (every claim,
its stage, who it's waiting on, the next step, and would-cost vs actual vs
saved per claim), and **Admin** (demo driver, world controls, network feed,
raw rulebook, graph query console — hidden behind
`http://localhost:7400/?admin=1`).

Scope: entirely synthetic data. Six fictional payers, six advanced-imaging
studies (MRI lumbar/brain/knee, CT lumbar/abdomen, ultrasound abdomen),
16 scripted consults plus a live-mic mode. That wedge is enough to show the
full loop.

## How it meets the hackathon requirements

The [official doc](https://docs.google.com/document/d/1f7mms4ZMx3WXzWnvR80Dlzny8RiOdVXzh86YXMksF84/edit)
has one hard rule: **all four sponsor technologies meaningfully integrated and
load-bearing** (judges verify there are no unused imports or API keys), in a
system that treats **memory** (durable, queryable, persists across sessions,
users, and time) and **motion** (orchestration, real-time action, multi-agent)
as one thing.

Precedent's loop *is* that one thing: every verdict in motion becomes memory;
every prediction is memory driving motion.

| Doc requirement | Where it lives | Why it's load-bearing |
|---|---|---|
| **LaserData should feed FalkorDB** | `src/adapters/bus/laserdata.js` + `src/services/ingest.js` | All four streams (`consult.utterances`, `network.events`, `payer.verdicts`, `case.lifecycle`) are produced and consumed through `@laserdata/laser-sdk` over the laser-stack (Apache Iggy). Ingest workers consume them into FalkorDB — kill the stack and the UI badge flips to a labeled fallback; nothing silently pretends. |
| **FalkorDB is the memory** | `src/adapters/graph/falkordb.js` | The entire memory is graph-shaped: patients, consults, **full visit transcripts** (`(Consult)-[:SAID]->(Utterance)` — reviewable across restarts), extracted facts, learned Requirements with `BECAUSE` evidence edges to the outcomes that taught them, submissions, procedures. Queryable three ways: the sources panel on every claim, a read-only Cypher console in Admin, and raw Cypher typed straight into the copilot chat. |
| **Guild coordinates specialists + human-in-the-loop before execution** | `src/services/guild.js` + `guild/` | Two agents — `clinical-criteria-agent` and `payer-policy-agent` — are **published in the Guild catalog** (workspace `precedent`) and debate every packet on top of the deterministic core. Their output feeds the approval gate: nothing executes before a human clicks Approve, and the wait is metered into the ROI math. |
| **RocketRide reads memory and acts** | `src/adapters/rocketride/index.js` + `src/services/chains.js` | The submit/appeal/notify chains open by querying the graph (`query-graph-requirements`), then act on what memory says: assemble the packet against learned rules, generate PDFs, email the packet, submit to the payer, write the verdict back into memory. Chain definitions are validated server-side by RocketRide's pipeline engine at boot; every chain is idempotent by `submission_id` (proven in the harness). |
| **No dead imports / unused keys** | Admin tab badges + `npm test` | Every adapter reports live vs fallback truthfully in the UI, and the harness exercises each seam. |

## Quickstart

Prereqs: **Node ≥ 22.14**, **Docker** (for the two real sponsor backends).

```bash
# 1. infra — real FalkorDB + real LaserData stack (Apache Iggy + plane)
docker run -d --name falkordb -p 6379:6379 falkordb/falkordb:latest
git clone https://github.com/laserdata/laser-stack && (cd laser-stack && ./scripts/up)

# 2. app
npm install
npm start            # UI on http://localhost:7400 · payer sim on :7402
npm test             # the harnesses (also runnable from the Admin tab, live)
```

No Docker? It still runs: every sponsor seam has an in-memory fallback and the
Admin badges show exactly what is live vs fallback. The demo never lies about
what it's running on.

Optional keys (all with labeled fallbacks), via `.env` or the environment:

```bash
LASER_CONNECTION_STRING='iggy:laser@127.0.0.1:8090' \
FALKORDB_URL='redis://127.0.0.1:6379' \
OPENROUTER_API_KEY=… \
RESEND_API_KEY=… EMAIL_TO=you@example.com \
ROCKETRIDE_API_KEY=… \
npm start
```

The LLM seam prefers OpenRouter → Anthropic → the deterministic extractor;
LLMs only ever explain and converse — they never decide (see below). Email
without a Resend key lands in a local outbox as real multipart `.eml` files
with the packet PDFs attached. `FORCE_LOCAL=bus,graph,llm,email,rocketride`
forces any subset onto fallbacks (demo safety switch).

Live mic uses the browser's Web Speech API (no keys) with automatic speaker
tagging; `F` anywhere swaps to scripted replay — everything downstream is
identical.

## The demo runbook (all from the UI)

Open `http://localhost:7400/?admin=1` for the Admin tab; the audience-facing
tabs are Consult and Practice manager.

1. **Prime.** Admin: set *Verdicts in 3 s* if rehearsing, **Seed ×500** for an
   instantly rich rulebook (about a second; repeatable), then **Start** the
   background world so the feed keeps moving. Nobody typed those rules in.
2. **Consult A.** Admin: pick *Maria Alvarez · BluePeak · the first denial*,
   **Replay consult** — the app jumps to the Consult view. The transcript
   streams, Captured details fill in plain language, and the moment the doctor
   says "MRI" the copilot interjects: denial expected, missing items, denial
   precedents cited. **Click "Sources"** — the panel shows the exact prior
   denials that taught the rule. That is the auditability story.
3. **Ask it things.** `what if we wait 2 weeks?` — computed, not guessed.
   Then **Prepare submission** → agents debate → checklist (learned items
   carry Sources links) → **Approve and execute** → the packet email (cover
   sheet + PDFs attached) lands in the outbox → seconds later: denied. The
   reason is written to the graph — the network just learned.
4. **Consult B.** *James Okafor · BluePeak · the memory moment*. The
   interjection is sharper (approval expected, cites the fresh denial), the
   checklist **auto-includes PT notes** because of it. Approve → approved on
   first pass. The approval-rate curve in Practice manager bends.
5. **The kicker.** Admin: rulebook rows are clickable evidence, the memory
   graph is queryable directly (or from the copilot chat), and **Run tests**
   runs the harness green live.
6. **Practice manager**: every claim, its stage, who it's waiting on and the
   **next step** (agents are never a resting bottleneck — human-blocked rows
   carry an "Open in Consult" jump), with would-cost vs actual vs saved per
   claim and totals. Click a claim for its timeline and token receipt.
7. Admin: **Reset memory** wipes the graph for the next run-through.

## Engineering credibility

- **Deterministic decision core** (`src/core/decide.js`): predictions and
  checklists are rule checks against the graph. LLMs explain and converse;
  they never decide. Same inputs → identical outputs, enforced by the harness
  running every golden scenario twice.
- **Deterministic learning rule** (`src/core/learn.js`): plain code, shared
  byte-identically by the FalkorDB and in-memory backends (parity-tested).
- **Ground truth lives in exactly one place** — the payer verdict simulator
  (`src/domain/verdict-sim.js` behind `POST :7402/payer/{id}/submit`),
  deliberately not an LLM, so every test is replayable.
- **The harnesses** (`npm test`, 37 tests): judgment goldens ×2 runs +
  ground-truth cross-checks · extraction over all 16 consult scripts (incl.
  relative-date inference) · execution chains (idempotent double-fire, exactly
  one email per submission, appeal path) · the end-to-end learning loop (the
  denial → sharper-second-prediction arc is itself asserted).
- **Idempotency**: chains keyed by `submission_id`; the email adapter dedupes
  by key. Double-triggering anything never double-submits or double-sends.
- **Memory that persists**: transcripts, facts, learned rules, and evidence
  live in FalkorDB and survive restarts — archived visits stay reviewable.
- **Human-in-the-loop**: the approve gate sits between deciding and doing,
  and the wait is measured into the per-claim cost receipt.

## Layout

```
server.js                 entry: boots everything + SSE/REST/static
src/adapters/             sponsor seams (bus, graph, llm, email, rocketride) + status registry
src/core/                 deterministic: decide.js, learn.js, extract-rules.js
src/domain/               payers + procedures, GROUND-TRUTH verdict sim, synthetic PDFs
src/services/             payer-sim HTTP, ingest (single-writer), cases (state machine),
                          chains, guild (debate + gate), consults, chat (grounded Q&A + Cypher),
                          metrics (ROI)
src/world/                background clinic generator (seeded RNG)
data/consults/            16 consult scripts
guild/                    published Guild agent definitions
public/                   the UI (Consult · Practice manager · Admin)
test/                     the harnesses + golden files
```

## Non-goals (by design)

No real patient data, no real payer integrations, no auth. Scope is the
advanced-imaging wedge (six studies, six fictional payers). No LLM anywhere in
verdict computation or learning, and no autonomous submission — nothing goes
out without the human Approve click.
