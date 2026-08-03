# bl-site-package — Claude Code Instructions

Deployable web package sold to SMB clients: public site, management panel, blog, message
inbox, and an AI marketing agent. One deploy per customer on Zeabur, configured through a
`/setup` wizard rather than by editing code. Repo: `br41s/bl-site-package`.

Extends the workspace `CLAUDE.md`. Rules here are project-specific only.

**This ships to paying customers.** A broken build is a client's site down.

## Stack

Eleventy static build (`eleventy.config.mjs`) plus a plain Node server (`src/server.js`).
Data in `data/`. Deployed on Zeabur from the `Dockerfile`; `passenger-startup.cjs` exists
for Passenger-based hosts.

- `npm run build` — Eleventy, `site/` → `_site/`
- `npm start` / `npm run dev` — Node server (`--watch` on dev)

## Content — same rule as biglobster

**`site/` is the source of truth. `_site/` is build output — never edit it.**

The layout owns all chrome (nav, footer, head, meta). Content files carry body HTML only.
Anything generated from a collection — blog index, sitemap, feed — is rebuilt on every
build, so hand edits are silently overwritten.

## Customer configuration

Per-customer setup runs through `/setup` and the panel, not through code. Company name,
sector, OpenRouter key and panel password are wizard inputs.

The agent defaults to `gpt-oss-20b:free` on OpenRouter — free, so a customer deploy costs
nothing to run. **Do not change the default to a paid model** without an explicit
decision; it changes the unit economics of every deployment.

## Client-facing documents — treat as published

Read by customers or handed over at onboarding. Never let internal notes or debugging
detail leak into them:

`INSTRUCCIONES-CLIENTE.md` (and its generated PDF) · `FORMULARIO-CLIENTE.md` ·
`ONBOARDING-INTERNO.md` · `RELEASE.md` · `DEPLOY.md`

If a change alters what a customer sees or does, say so explicitly — it may need the PDF
regenerating.

## Language

Customer-facing content and docs are in **Spanish**. Match the surrounding language.

## Before declaring done

- `npm run build` passes
- The affected page renders in `_site/`
- No customer-facing document contradicts the change
