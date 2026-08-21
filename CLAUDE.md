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

**Nothing under `site/` is inert — Eleventy executes it.** `eleventy.config.mjs` sets
`dir.data = "_data"`, so every `.js` there is imported as a data provider on every build.
A test file placed in `site/_data/` therefore runs on every build: `node:test` executes a
suite the moment it is imported, so its fixtures and teardown hit whatever database the
build is pointed at. That happened — one `npx eleventy` took a 14,487-product catalogue
down to a single row, with every endpoint still answering 200. Tests for `site/_data/*`
live in `src/` and import across; `src/build/no-tests-in-site.test.js` fails if one ever
appears under `site/` again.

## The catalogue

Clients who sell from a distributor feed get a synced catalogue. Shoroban's is Liderpapel:
~14,500 products, arriving as JSON over sFTP (`src/sync/liderpapel/`).

**Two owners, and the split is the whole design.**

- **Feed-owned** — price, stock, `feed_active`, plus the physical facts: `gtin`, `mpn`,
  `brand`, weight, dimensions, and the `product_features` / `product_images` /
  `product_documents` child tables. The sync overwrites all of it on every run. Editing any
  of it by hand is pointless; that is why `PUT /api/products/:id` accepts only `active`.
- **Ours** — `product_content`: the title and body we write when the feed's are missing or
  poor. **The sync cannot reach this table.** Only `status = 'owned'` renders, so a draft
  never reaches a visitor, and it is what carries our copy through a change of distributor.

Three consequences worth holding on to:

- **`slug` is pinned at first publication and never recomputed.** It derives from the feed
  title, so refreshing it moved a product's public URL every time the distributor reworded
  something, leaving the old one 404ing.
- **`source_fingerprint` is a hash of exactly the facts a sheet is written from** — title,
  description, specs, identifiers, documents; deliberately not price or stock, which move
  every few hours. Comparing the feed's current value against the one stored on an owned
  sheet is how we notice the distributor changed something underneath it, and the same
  comparison decides when a `skipped` product becomes writable again. It is derived at read
  time, never stored as a flag.
- **Writes are partial.** An absent field means leave alone; present-but-empty means clear.
  Sending a field the caller never meant to change used to erase it.

## Customer configuration

Per-customer setup runs through `/setup` and the panel, not through code. Company name,
sector, OpenRouter key and panel password are wizard inputs.

The agent defaults to `openai/gpt-oss-20b:free` on OpenRouter — free, so a customer deploy costs
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
- On anything touching the catalogue, `scripts/smoke-test.sh <url>` — it now fails if the
  product count collapsed, which is the one failure every other check answers 200 through

**The shared staging instance is unconfigured** — no panel password, no catalogue, no
posts. A green smoke test there proves a deploy boots and serves its setup wizard; it
proves nothing about authenticated routes or the catalogue. Verify catalogue work against
a local instance seeded from a real feed.
