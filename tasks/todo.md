# Fleet update system — plan

Goal: when bl-site-package or a hermes agent improves, every deployment
(Shoroban, new customer, test instance) and every internal consumer
(biglobster, FinView via hermes profiles) gets the update through one
tracked, human-approved flow.

## Design (agreed direction)

Two propagation surfaces, one mechanism:

1. **Sites** — N deployments of bl-site-package (test Zeabur, Shoroban
   Plesk staging+prod, new customer TBD). Truth of deployed version:
   `GET /api/site/status`. Truth of latest version: git tag `vX.Y.Z`
   (already CI-enforced).
2. **Hermes** — single container, all agents as cron jobs, one profile
   per customer/project. One redeploy updates everyone. Per-profile
   config/prompt drift is the only per-customer risk (known trap:
   frozen prompts, overwritten routing.env).

Core pieces:

- **`fleet/manifest.json`** in bl-site-package: one entry per
  deployment — id, urls (staging/prod), host type, deploy driver,
  hermes profile. Reviewed via PR like any code.
- **Harmonizer** = extension of the existing hermes maintenance agent
  (it already checks "instancia desactualizada"): polls every entry,
  compares versions, and on drift prepares the update per customer and
  notifies the CEO. Nothing deploys without approval.
- **Deploy drivers** (pluggable, per host type):
  - `manual` — emits an exact runbook (commands + smoke test) — v1 for Shoroban
  - `zeabur` — redeploy via Zeabur API — v1 for test instance
  - `plesk-ssh` — git pull + restart over SSH — later, if we wire creds
  - New customer's driver gets picked when hosting is decided; adding
    one is adding a file, not redesigning.
- **Profile contract version** in hermes: when an agent update requires
  new profile fields or prompt changes, bump a `profile_schema` number;
  the harmonizer flags which profiles are stale instead of us
  discovering it via broken output.

Rollout order is always: test instance green → customer staging →
customer prod, smoke test at each step (existing RELEASE.md flow, now
tracked by the agent instead of memory).

## Phases

### Phase 1 — see the fleet (read-only)
- [x] `fleet/manifest.json` schema + entries: blcliente (zeabur), shoroban staging, shoroban prod
- [x] `scripts/fleet-check.mjs` — operator's on-demand drift view (validated by `npm test`)
- [x] RELEASE.md updated (fleet section; fixed stale unauthenticated-curl advice)
- [ ] Hermes: extend bl_site_health with release drift check → spawned as separate hermes-sandbox task (chip)
- [ ] Drift finding routed to BigLobster, not the client (part of the hermes task)

### Phase 2 — prepared rollouts (human approves)
- [ ] Runbook generation per drifted deployment (driver: `manual`)
- [ ] Approval loop: notify → CEO approves → harmonizer marks rollout done after smoke test passes
- [ ] Rollout log (which version reached which customer, when)

### Phase 3 — automated drivers
- [ ] `zeabur` driver via API for our test instance
- [ ] Decide per-customer automation (plesk-ssh for Shoroban?) once trust in the loop exists

### Phase 4 — hermes profile contract
- [ ] `profile_schema` version per agent; harmonizer flags stale profiles
- [ ] Hermes container itself becomes a fleet entry (UPSTREAM_VERSION check)

## Verification
- [ ] Drift detection: bump version on a branch instance, confirm harmonizer flags exactly that instance
- [ ] Approval loop: confirm nothing executes without explicit approval message
- [ ] Smoke tests wired into every driver before "done" is reported
