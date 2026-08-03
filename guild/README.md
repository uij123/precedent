# Guild agents

Both agents are published in the Guild catalog (workspace `precedent`):

- `clinical-criteria-agent` — argues the clinical-standards side of every packet
- `payer-policy-agent` — argues the payer-rulebook side, citing learned evidence

The files here are tracked snapshots of each agent's source (`<name>.agent.ts`)
and catalog metadata (`<name>.guild.json`). The working directories
(`<name>/`, gitignored) are guild-CLI workspaces with their own git history —
update flow: edit, commit there, then `guild agent save --message … --wait
--publish` from the agent directory.
