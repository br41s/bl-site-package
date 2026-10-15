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

**Rebuilds run in a child process, never in the server's.** `src/build/rebuild.js` spawns
`src/build/eleventy-child.js` (the same programmatic Eleventy call `npm run build` makes).
A catalogue client's site is ~14,500 pages; built in-process that was ~30s per publish
during which the event loop answered no request at all, and the Product Sheet Writer's
read right after each publish timed out 10-23 times a day. `src/build/rebuild.test.js`
runs a real build and fails if a request is not served while it is in flight.

**Every async route goes through `asyncHandler`** (`src/middleware/async-handler.js`).
Express 4 does not catch a rejected promise, and Node 22 exits on an unhandled rejection:
one throw in an unwrapped async route takes the client's site down. `apiErrorHandler`,
mounted last in `server.js`, turns what reaches it into a JSON 500.
`src/middleware/async-handler.test.js` fails if an unwrapped `async (req` handler appears.

**`_site` is a symlink, and a build never writes into the slot being served.** The child
builds into whichever of `_site.a` / `_site.b` is idle, from empty, and only on exit 0 is
`_site` repointed (an atomic rename). Eleventy writes files in place, so a visitor served
out of the directory being rebuilt could get a half-written page. `eleventy.config.mjs`
therefore sets no `dir.output`: a value there overrides the slot the child asks for.

## Content — same rule as biglobster

**`site/` is the source of truth. `_site/` is build output — never edit it.**

The layout owns all chrome (nav, footer, head, meta). Content files carry body HTML only.
Anything generated from a collection — blog index, sitemap, feed — is rebuilt on every
build, so hand edits are silently overwritten.

The homepage's "Últimas publicaciones" section (`site/index.njk`) renders the 3 newest
posts from the `articles` data provider. Its cards **mirror the markup in `site/blog.njk`
on purpose** — restyle blog cards and you must change both, or the two surfaces drift.
It needs no config key: `articles` is empty for a client with no published posts, so the
section hides itself. Card titles there are `h3` (the section owns the `h2`), which is why
`.site-post-card h2` rules in `web/style.css` also match `h3`.

**Nothing under `site/` is inert — Eleventy executes it.** `eleventy.config.mjs` sets
`dir.data = "_data"`, so every `.js` there is imported as a data provider on every build.
A test file placed in `site/_data/` therefore runs on every build: `node:test` executes a
suite the moment it is imported, so its fixtures and teardown hit whatever database the
build is pointed at. That happened — one `npx eleventy` took a 14,487-product catalogue
down to a single row, with every endpoint still answering 200. Tests for `site/_data/*`
live in `src/` and import across; `src/build/no-tests-in-site.test.js` fails if one ever
appears under `site/` again.

**Tables in customer content get a scroll wrapper at build time.**
`lib/table-scroll.mjs` wraps every `<table>` in
`<div class="table-scroll" role="region" tabindex="0">`. A table cannot shrink below its
min-content — the widest cell is a hard floor and `width:100%` is a wish, not a limit — so
a wide table in an article body used to push the whole document sideways on a phone
(measured: 620px wide on a 375px viewport). It matters here more than on the flagship,
because article and page bodies are arbitrary HTML out of the database
(`{{ post.contentHtml | safe }}`), written by the customer's panel or agent: there is no
source file anyone could fix by hand, so the build is the only point that HTML passes
through. The bug is invisible on desktop, where the min-content floor is never reached.

- The file is a **byte-for-byte copy of biglobster's** on purpose, so the two cannot
  drift. Fix one, copy it across verbatim. The policy difference lives in the CSS.
- The CSS is scoped to `.site-page-body` / `.site-post-body`, where customer HTML lives.
  The transform also wraps `.cart-table` and `.product-specs` (package markup, narrow by
  design), but those wrappers get no styles and stay **inert** — no overflow, no margin,
  zero height — so the empty cart's `hidden` and `cart.js`'s `getElementById` keep
  working. If you ever style `.table-scroll` unscoped, you break the empty cart.
- **`1rem` is 16px in this repo**, unlike biglobster's 62.5% root, and the fade cover uses
  `--bg`, not `--bg-base`. Neither is interchangeable between the two stylesheets.

**Images in article bodies: `/uploads/` or the site's own catalogue photos, nothing
else.** `formatContent` (`src/content/format-content.js`, the XSS boundary for all
customer content) keeps an `<img>` only if its src is an uploaded file, or, for blog
posts only, an `https://` URL that is **exactly** one of the catalogue's image URLs
(`products.image_url` + `product_images.url`, passed as a Set by `site/_data/articles.js`).
That is how the Product Guide agent shows the photos of the products it compares: the
same hotlinked images the product pages use, already allowed by CSP and disclosed on
`/privacidad` and `/cookies`. They cannot be copied into `/uploads` instead: the
distributor's CDN (Akamai) answers 403 to any fetch that is not a real browser. Pages,
the panel preview and sites without a catalogue pass no set and keep `/uploads/` only.

**Catalogue links in posts are rewritten at build time** (`src/content/guide-buttons.js`,
applied in `site/_data/articles.js` after `formatContent`, which allows exactly one class
on links: `guide-buy`):

- `<a href="/productos/SLUG" class="guide-buy">` is the Product Guide agent's buy button.
  The agent never writes a price; the build writes «Comprar · 69,95 €» from the catalogue
  as of the last sync (the sync always ends in a rebuild), or «Agotado · ver
  alternativas» to the product's category when it is out of stock or no longer sold. The
  price is retail with VAT as plain text, deliberately not a `.product-price`: `cart.js`
  would rewrite it for a trade account inside a button with no VAT note.
- `guide-buy` on a link that is not one of this site's product pages loses the class, so
  the button can only ever lead to the shop.
- Any other link to a product no longer sold (its page is not built) goes to its category,
  and so does the post's CTA button, so old posts do not pile up 404s.
- A guide is a post whose `cta_url` is a product page (`src/content/guide-links.js`).
  Product pages list the guides that link them («Aparece en estas guías») and category
  pages the guides whose recommended product is theirs.
- **On a desktop column each product block is two columns, by CSS alone**
  (`web/style.css`, `@media (min-width: 769px)`): the photo paragraph and the button
  paragraph float left at 320px and «Lo mejor» / «A tener en cuenta» flow beside them.
  The body has no wrapper per product, so the rule hangs off the shape the hermes
  prompt writes: `<p><a><img></a></p>` immediately followed by `<p><a class="guide-buy">`.
  Change that order in the prompt and the layout silently falls back to stacked.

## Homepage game (`hero_game`)

Opt-in per deploy (panel → Mi sitio → Apariencia → Animación de portada, default
off). "Pedido a pedido": offices order clips, paper, pens or folders; the player
drags the product from the dock to the office before its patience ring runs out;
three lives. Idle, the same simulation plays itself behind the hero text.

- **Rules and drawing are split, as in FlyWell.** `web/game/rules.js` is pure (no
  DOM) and owns every timing — spawn, patience, van travel — so
  `web/game/hero-game.js` only lays out, paints and calls `deliver()`. Tests in
  `src/game/` import across, like `site/_data` tests, so they never reach `_site`.
- **Difficulty is one function**, `ordersPerMinute` in `web/game/traffic.js`.
  Patience and office count are fixed; tune the game there and nowhere else.
- **No customer data in the scene.** The warehouse sign is `company_name`; the
  truck says "Proveedor". The files are passed through one by one in
  `eleventy.config.mjs` so a file added to `web/game/` is not shipped by accident.
- **Playable without a pointer:** keys 1-4 pick a product, arrows pick an office
  (numbered on the canvas), Enter delivers; every order, loss and delivery is
  read out through an `aria-live` line, and the idle demo has a pause button.
  Browsers without `ctx.roundRect` get the plain hero, no Jugar button.
- `prefers-reduced-motion` gets one still frame; the loop stops when the hero is
  off-screen or the tab hidden (the Browser pane counts as hidden — override
  `document.hidden` to watch it there). Best score: `localStorage` `bl-game-best`.

## The catalogue

Clients who sell from a distributor feed get a synced catalogue. Shoroban's is Liderpapel:
~14,500 products, arriving as JSON over sFTP (`src/sync/liderpapel/`).

**Two owners, and the split is the whole design.**

- **Feed-owned** — cost (`cost_ex_vat`), price, stock, `feed_active`, plus the physical
  facts: `gtin`, `mpn`, `brand`, weight, dimensions, and the `product_features` /
  `product_images` / `product_documents` child tables. The sync overwrites all of it on
  every run. Editing any of it by hand is pointless; that is why `PUT /api/products/:id`
  accepts only `active`.
- **Ours** — `product_content`: the title and body we write when the feed's are missing or
  poor. **The sync cannot reach this table.** Only `status = 'owned'` renders, so a draft
  never reaches a visitor, and it is what carries our copy through a change of distributor.

**PVP is made by the sync, not at display time.** `price_cents` = PVO × (1 + adjustment) ×
(1 + VAT), through `retailPriceCents()` in `src/sync/liderpapel/parse.js`. The PVO is the
distributor's suggested retail price for its general catalogue (`priceType` `suggestedCI`,
confirmed as the general one by Liderpapel support on 2026-10-13; stored as `pvo_ex_vat`),
and the VAT is the product's own (`vat_rate`, from `VATRates`: 21 % on most of the
catalogue, 4 % on books, 10 % on a few). Brais decided on 2026-10-14 that the site sells at
the catalogue price: a Calipage shop's customers compare against the printed catalogue, and
the old cost × 1.4 published 12,403 of 14,487 products below it. The adjustment is ours: a
general one (`liderpapel_pvo_adjust_pct`, 0 = catalogue price, negative undercuts it) and an
optional one per category (`category_price_adjust`), set in panel → Productos → Precios
(`src/api/pricing.js`). Saving one re-prices the stored catalogue with the same
`retailPriceCents()` and rebuilds once, so the sync and the panel can never disagree by a
cent. Everything else (built pages, JSON-LD, cart, reservations, the B2B discount) reads
`price_cents` and needs no change; never add a markup at read time. A product the feed gives
no PVO for (13 of 14,487) is priced from `cost_ex_vat` at the fixed 40 % fallback margin.
The pre-PVO keys (`liderpapel_margin_pct`, `category_margins`) are read by nothing: reusing
them would have put a 40 % margin on top of the catalogue price the day this shipped.

- **`cost_ex_vat` is the smallest quantity tier.** The feed lists purchase tiers largest
  pack first (10 units at 1.98 €, then 1 unit at 2.38 € with the 20 % below-pack supplement
  included; 2,631 products). The shop sells single units, so its cost is the unit-of-sale
  line (`AdditionalInfo.UVE`), never `PriceLine[0]`.
- **The feed carries several supplier blocks, and the sync reads the configured ones.**
  `liderpapel_supplier_code` is a comma-separated list (`parseSupplierCodes`); Shoroban's
  feed has `CSP` plus `GC2`–`GC5` (Safta, ACCO brands, printer consumables, Wondee: 7,387
  more sellable products, same warehouse, same terms, confirmed by the customer on
  2026-10-14). Ids are disjoint across blocks; the first configured block wins if one ever
  repeats. A block missing from a file (no prices, no descriptions) yields rows priced 0 and
  named by id, never a throw.

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
- **The distributor's figures never leave the server unauthenticated.** `cost_ex_vat`
  (what the shop pays) and `pvo_ex_vat` are stripped by `publicProduct()` in
  `src/api/products.js` from every unauthenticated response; the panel and the agent get
  the full row. The routes return `SELECT *`, so a new confidential column goes on that
  list, not on a per-route allow-list someone has to remember.

## B2B area (trade prices)

Opt-in per deploy (`b2b_enabled`, default off; panel → Profesionales). The
admin creates business accounts; each gets an emailed one-time link to choose its own
password (the admin never sees it), then signs in at `/profesionales` and sees a percentage off
retail per catalogue category, with a general fallback. `src/api/b2b.js` holds all of it.

- **The static pages keep the retail price.** `web/cart.js` rewrites prices for a
  signed-in account from `GET /api/b2b/me`; `POST /api/reservations` re-prices server-side
  from the session cookie. The browser's figures are display only. `b2bPriceCents` and
  `vatCents` exist in both files and must stay identical to the cent.
- **A B2B reservation never shows the IBAN.** With `bank_iban` set, a retail reservation
  answers (and emails) the bank details, amount and reference; a B2B one gets "your usual
  payment terms" instead (`paymentInstructions` in `src/api/reservations.js`). The
  bank keys are public config on purpose: every buyer is shown them, and the build words
  the cart and the terms page from them.
- **Trade prices exclude VAT.** `price_cents` has the product's own rate baked in
  (`products.vat_rate`, carried to the browser as `data-vat-rate` and on each cart item);
  `b2bPriceCents` takes the discount off and divides that rate back out, rounding once. The
  VAT on a cart is grouped by rate, each group rounded once (`vatCentsByRate` and
  `cartVatCents` must agree). A B2B reservation stores net unit prices and total with
  `vat_included = 0` and the VAT in `vat_cents`; every other row keeps `vat_included = 1`.
  `B2B_VAT_RATE` (21 %) is only the fallback for rows and cart items from before `vat_rate`
  existed.
- **The B2B session is never signed with `jwt_secret`** — it uses a key derived from it.
  `requireAuth` and the inline checks in `products.js` / `blog.js` accept *any* token
  signed with `jwt_secret` as a panel admin, so a B2B token signed with it would be a
  panel login for every trade customer. `src/api/b2b.test.js` asserts this.
- Discounts and the general % are written without `setConfig`: they are in no built page,
  and a rebuild of ~14,500 pages for a discount change would be pure cost.

## Legal pages — they describe the code, so they move with it

`/aviso-legal`, `/condiciones` (sales terms, only with a catalogue), `/privacidad`,
`/cookies`, `/uso-de-ia`. The **customer** is the titular, controller and seller,
under Spanish law; the company that builds and hosts the site is named nowhere
on them (only as "proveedor de alojamiento y mantenimiento técnico"). Every fact
comes from config (`legal_*`, `biz_phone`, `bank_iban`, `sales_shipping_text`,
`legal_adr`), and each section renders only when its feature is on.

The pages state what the code does, so a code change can make them false:

- **A new cookie or `localStorage` key** goes on `/cookies`. The site has no
  consent banner because everything it stores is strictly necessary or asked
  for; a key that is not would need consent, and a banner.
- **A new third-party request** from public pages (script, font, image host)
  goes on `/privacidad` and `/cookies`. Fonts are self-hosted in `web/fonts/`
  for this reason: Google Fonts sent every visitor's IP to Google.
- **Retention is enforced, not promised.** `src/privacy/retention.js` deletes
  contact messages after 24 months and orders after 6 years, daily; the policy
  reads the same constants (`retention-periods.js` → `site.retention`).
- **Checkout requires accepted terms** (`accept_terms`, stored as
  `reservations.terms_accepted_at`) and the button says «Confirmar pedido con
  obligación de pago» (TRLGDCU art. 98.2). The screen says «Pedido recibido»:
  the terms make the contract when the business confirms, not on submit.
- **Promises depend on what the deploy can do.** Emailed copies are promised only
  when `site.mail_configured` (SMTP set). `/uso-de-ia` and the footer must not
  promise human review before publication: agents can publish posts and product
  sheets directly. Add a review gate in code before ever claiming one again.
- Wording follows `bank_iban` the way `paymentInstructions` does
  (`site.shop_payment_line`); never promise "sin pago por adelantado" again.

## Customer configuration

Per-customer setup runs through `/setup` and the panel, not through code. Company name,
sector, OpenRouter key and panel password are wizard inputs.

The agent defaults to `openai/gpt-oss-120b` on OpenRouter (`DEFAULT_AGENT_MODEL` in
`src/api/chat.js`; the panel's featured option posts the same id). It is paid: a few cents per
article, billed to the customer's own OpenRouter key. Brais decided this on 2026-10-09 so the
default works under OpenRouter's `data_collection: deny` policy (free models train on prompts
and `deny` excludes every one of them) and answers better than the 20B. The free models in
`FREE_MODELS_FALLBACK` are now only the last resort when the paid one is rate-limited (429) or the key has no
credit (402); any other upstream error is still a 502. A customer who saved the old free default keeps it (it shows as their custom model).
`CONTENT_AGENT_MODEL` is documented but never read; the model lives in the `ai_model` config
row, set from the panel. **Do not change the default again** without an explicit decision; it
changes the unit economics of every deployment.

## WhatsApp add-on (`whatsapp_bot_enabled`)

Opt-in per deploy, off by default. The site's own part is small: `GET /api/knowledge`
(`src/api/knowledge.js`, Bearer `KNOWLEDGE_API_TOKEN`, 404 while unset) feeds the central
bot, and `src/api/conversations.js` proxies Chatwoot for the WhatsApp tab in Mensajes
(`CHATWOOT_BASE_URL` / `CHATWOOT_ACCOUNT_ID` / `CHATWOOT_API_TOKEN`, 404 while unset). The
browser never sees the Chatwoot token, and a reply is refused server-side unless the
conversation is human-owned (`open`) and inside WhatsApp's 24 h window — the UI gate is not
the boundary. Everything else lives elsewhere: Chatwoot CE (central, one Account per
customer) and the bot service in `hermes-sandbox/scripts/whatsapp-lead-bot`. Onboarding
checklist: `ONBOARDING-WHATSAPP.md`.

- **The bot says nothing that is not in `/api/knowledge`**, so the payload is the offer:
  `business` (+ `site_url`), `pages` (the four editable pages as plain `text` — the
  prose of quienes/servicios/contacto lives in `page_*_desc`, which the first version
  dropped whenever a subtitle was set), `products`, `categories`, `faq` (the FAQ blocks
  of published posts, via `buildFaqLd`), `articles`, and `operational_facts` derived
  from config (payment line from `bank_iban`, `sales_shipping_text`, `biz_hours`,
  `b2b_enabled`, SMTP state) — never a promise the deploy cannot keep. A catalogue
  client has ~14,500 products and the whole payload goes into one prompt per turn, so
  `products` is a **sample of 60** — owned sheets (`product_content.status = 'owned'`,
  our copy, not the feed's) first, then in stock — and `categories` lists the whole
  catalogue with counts and URLs for everything the sample lacks. URLs are the clean
  paths the server serves (`/productos/<slug>`, `/blog/<slug>`; a trailing slash 404s).
  The `etag` hashes the content, not the clock. Tests: `src/api/knowledge.test.js`.
  **The sample is not the catalogue, so the payload advertises `catalogue.search_path`
  (`GET /api/knowledge/search?q=`, same Bearer)**: the bot calls it on every turn with the
  visitor's message and gets the real products (slug, price, owned name) and categories for
  what was asked — every word first, then any word ranked by hits, in stock first. Before
  it existed the model invented three pens with prices and 404 links on Shoroban's first
  day (2026-10-15); the bot now also strips any site URL that is not in its reference.
- For a client whose prices are public (any catalogue client), set `answersPricing: true`
  on its entry in the bot's registry, or the bot escalates every price question.
- `whatsapp_bot_enabled` is in `PUBLIC_CONFIG_KEYS` and gates the AI sections of
  `/uso-de-ia` and `/privacidad`; since v1.24.0 the panel sets it (Integraciones → "Asistente
  de IA", the checkbox) through `POST /api/site/texts`.
- **The web-chat widget is two public config keys**, `chat_widget_url` (the Chatwoot origin)
  and `chat_widget_token` (the inbox's website token), set in the same panel block, which also
  has a `?` button opening a `<dialog>` with the customer instructions. With both set,
  `base.njk` loads the Chatwoot SDK (left side; WhatsApp owns the right), `/cookies` lists
  `cw_conversation`, `/privacidad` and `/uso-de-ia` describe the chat, and `src/csp.js`
  adds the origin (script, frame, img, connect + `wss:`) to the CSP header, which `server.js`
  now builds per request from config. The URL validator accepts an https origin only — it is
  interpolated into every page and into the header.
- Visitor and lead content in the panel is built with `createElement`/`textContent`, never
  string-built `innerHTML`. An explicit `display` on a class that is also used with
  `[hidden]` needs a paired `.class[hidden] { display: none }` rule, or the element shows
  regardless of the attribute (the unread-badge bug).

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
