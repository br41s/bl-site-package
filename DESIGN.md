# DESIGN.md — the look of the base site

Status: **slices 1 and 2 implemented** (slice 1 on branch `feat/estilo-calida`, slice 2
stacked on it, both 2026-10-17); slice 3 of §9 is pending. Brais chose direction C, «Cálida», from the look-and-feel
board (https://claude.ai/artifact/MzSrwrJqE9FcPta3gnE77d, artboard "C · Cálida"). This
file is what the implementation is checked against; where the code settled on
something other than the first draft, the text below says so. Read it before touching
`web/style.css`, `web/style-calida.css` or any template under `site/`.

## 1. Principles

- **Soft and warm.** Rounded shapes, a cream ground, surfaces tinted with the client's
  accent, diffuse shadows, generous air. Friendly before impressive.
- **Every visual derives from data the package already has.** Company name, sector,
  city, phone, hours, logo, page texts and images, posts, social links. A section or
  ornament with no data behind it does not render. No lorem, no invented figures.
- **One component set, styles are token bundles.** The same nav, hero, cards, chips,
  bands and footer serve every style. `site_style` only swaps fonts, colours, radii and
  shadows. That is what keeps A and B (editorial, studio) cheap later.
- **The content model does not change.** The one-shot creation stays one-shot: the
  wizard, the questionnaire and the agent fill the same fields as today. The only new
  field is optional (`page_index_highlights`, §5.2) and the page is complete without it.
- **Motion is small, purposeful and off under `prefers-reduced-motion`.**
- **No new third-party request, no new browser storage.** Fonts are self-hosted like
  today's; the legal pages stay true without a word changed.

## 2. Styles and the `site_style` key

| Value | Meaning |
| --- | --- |
| `calida` | This spec. Written by the setup wizard on every **new** install. |
| `clasico` or empty | Today's look: Inter + DM Serif Display, white ground, 8 px radius. Existing deploys keep it until the admin switches. |

- `<html data-style="calida">` is set by `base.njk`; every Cálida rule in `style.css`
  hangs off `[data-style="calida"]`, so Clásico CSS is untouched by this work.
- Panel → Mi sitio → Apariencia gets a first control **Estilo** (Cálida / Clásico). The
  existing controls keep working: `accent_color` is the client's brand colour in both
  styles; `radius_style` maps in Cálida to the card radius (`sharp` 12 px, default
  24 px, `rounded` 32 px); `theme_default`, `hero_density` and `hero_game` behave as
  before (§5.2 says how the hero game and the blob coexist).
- Shoroban stays on Clásico until Brais flips it in the panel. Flipping is one rebuild.

## 3. Tokens

All colours are CSS custom properties on `:root[data-style="calida"]` and its
`[data-theme="dark"]` variant. Existing variable names are kept so the 1,900 lines of
component CSS keep resolving; new names are added for what Cálida needs.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--bg` | `#fbf8f4` | `#17161f` | page ground |
| `--bg-elevated` *(new)* | `#ffffff` | `#211f2c` | cards, nav pill, footer, form |
| `--bg-subtle` | `color-mix(in srgb, var(--accent) 6%, var(--bg))` | same formula | alternating bands |
| `--text-primary` | `#1d1b2a` | `#f2effb` | headings, body |
| `--text-secondary` | `#3a3850` | `#cfcbe0` | long-form body |
| `--text-muted` | `#5e5b70` | `#aaa6bd` | captions, dates (≥ 4.5:1 on `--bg`) |
| `--border` | `#e8e2da` | `#2f2d3d` | 1 px card and divider lines |
| `--accent` | panel value, default `#1a7e6f` | same value (text uses `--accent-ink`) | buttons, links, glows |
| `--accent-ink` *(new)* | `color-mix(in srgb, var(--accent) 80%, black)` | `color-mix(in srgb, <accent> 70%, white)` | accent **text** (chips, links, accent word); the raw accent is for fills only |
| `--on-accent` *(new)* | `#ffffff` | `#17161f` | text on accent fills |
| `--tint` *(new)* | `color-mix(in srgb, var(--accent) 11%, var(--bg))` | same formula | chips, icon circles, CTA band, hero glow |
| `--tint-2` *(new)* | `#f6dfd0` | `#3a2f33` | the warm second glow and the offset blob behind photos |
| `--radius` | 24 px (`radius_style`: 12 / 24 / 32) | | cards, images, form — the existing knob, so the 23 rules in style.css that read it round correctly |
| `--radius-band` *(new)* | 32 px | | CTA band, footer top corners |
| `--radius-pill` *(new)* | 999 px | | buttons and chips |
| `--max-w` | 1120 px | | the content column (960 px in Clásico) |
| `--shadow-card` *(new)* | `0 30px 50px -30px rgba(20,18,40,.35)` | `0 30px 50px -30px rgba(0,0,0,.6)` | card hover |
| `--shadow-float` *(new)* | `0 24px 50px -24px rgba(20,18,40,.35)` | same, darker | nav pill, floating cards |

Default accent for a new Cálida deploy is `#1a7e6f` (teal). The terracotta `#b8391c`
stays the Clásico default. Both are only defaults: the wizard asks for the brand colour.

## 4. Typography

- **Display:** Fraunces 500 and 600 (h1, h2, h3, post and product card titles, the
  footer wordmark). **Body:** Nunito 400, 600, 700.
- Self-hosted in `web/fonts/` as latin woff2 subsets with their OFL notices, declared
  in a separate `web/fonts/fonts-calida.css` that `base.njk` links **only** when
  `site_style` is `calida`, so Clásico downloads nothing new. Expected weight: five
  files, well under 200 KB in total.
- Scale (desktop → phone through `clamp`): h1 `clamp(2.5rem, 6vw, 4.75rem)` line-height
  1.1; h2 `clamp(2rem, 4vw, 3.25rem)`; h3 `1.5rem`; body `1.0625rem` / 1.65; chip and
  eyebrow `0.8125rem` 700; captions `0.875rem`.
- **Accent word in a title.** `*word*` inside `page_index_title` (and the other page
  titles) renders as `<span class="accent-word">`. Nothing is automatic: a title without
  the mark renders plain. The agent prompt gets one line telling it to mark one word.

## 5. Components

### 5.1 Nav

Sticky floating pill: `--bg-elevated`, full radius, `--shadow-float`, 14 px above the
viewport edge, blur behind. Left: the uploaded logo at 36 px, or a 36 px accent circle
with the company's initial, then the company name in Fraunces. Centre: the five links as
chips (`--tint` + `--accent-ink` on hover and active). Right: theme toggle (round, tint),
then the CTA pill **Contactar**. The Catálogo link stays, as today. Below 768 px the
links collapse behind the existing menu button into a rounded panel under the pill.

### 5.2 Hero (home)

Two columns from 769 px (text 1fr, visual 1fr), stacked on phones. Two soft radial glows
behind everything: `--tint` top-left, `--tint-2` right.

- **Chip:** `sector` and `biz_city` joined with « · »; either alone works; none → no chip.
- **h1** `page_index_title`, **subtitle**, **desc**: as today.
- **Buttons:** unchanged — «Ver catálogo» solid, «Contactar» ghost (both pills).
- **Highlights row** *(new, optional)*: `page_index_highlights`, newline-separated,
  first three lines, each a check icon in a tint circle plus the text. Panel field under
  Páginas → Inicio, one line in `FORMULARIO-CLIENTE.md`, one line in the agent prompt.
  Absent → the row is not rendered.
- **Visual:** `page_index_image` inside an organic mask
  (`border-radius: 58% 42% 55% 45% / 48% 60% 40% 52%`) with a `--tint-2` blob offset
  behind it. Without an image: the same blob shape filled with a gradient from `--tint`
  to `--tint-2` to a stronger accent mix, so the first screen is never text on a blank
  wall. The old full-width image section under the hero disappears in Cálida.
- **Floating card** (bottom-left of the visual): phone icon in a tint circle,
  «Llámanos» and `biz_phone` as a `tel:` link. Only with a phone.
- **Floating chip** (top-right): clock icon and `biz_hours`, only when the text is
  40 characters or shorter; longer hours stay on the contact page.
- `hero_game = 1`: the canvas remains the backdrop and the blob visual, glows and
  floating cards are omitted; the text column keeps the Cálida type and buttons.
- `hero_density = compact`: paddings halve; the visual stays.

### 5.3 Home section order

hero → highlights (inside hero) → `page_index_body` (if any, in a 68ch column) →
**services teaser** → **about** → latest posts → CTA band → footer.

- **Services teaser:** the first three cards from the `###` blocks of
  `page_servicios_desc` (the same cards /servicios shows, §5.8), under the Servicios
  title and subtitle, with a «Ver todos los servicios» link. Whenever the body has no
  `###` headings, a tint band with the Servicios subtitle and a «Ver servicios» pill.
- **About:** chip «Quiénes somos», `page_quienes_subtitle` as h2, the first paragraph
  of `page_quienes_desc_html`, a «Conocer al equipo» link, and `page_quienes_image` in
  the second blob shape (`45% 55% 40% 60% / 55% 45% 60% 40%`) with a tint blob behind.
  Rendered only when the Quiénes page has a title.
- **Latest posts:** the three existing cards, restyled (§5.5). The markup keeps
  mirroring `blog.njk` exactly, as `CLAUDE.md` requires.

### 5.4 Chips, buttons, icons

- **Chip:** pill, `--tint` background, `--accent-ink` text, 0.8125rem 700, optional
  leading 14 px icon. Used for eyebrows, tags, nav links, highlights.
- **Pill button:** `--accent` fill with `--on-accent` text; hover lifts 2 px with a
  shadow in the accent at 60 % alpha; the trailing arrow nudges 4 px right. **Ghost
  pill:** `--bg-elevated` with `--border`, accent border on hover.
- **Icons:** one Nunjucks partial, `site/_includes/icon.njk`, inline stroke SVG at
  1.8–2 px, names: `arrow`, `check`, `phone`, `clock`, `pin`, `calendar`, `smile`,
  `sparkle`, `instagram`, `facebook`, `whatsapp`, `theme`, `menu`, `cart`. No emoji
  anywhere (the construction page's 🚧 becomes an icon).

### 5.5 Cards

`--bg-elevated`, 1 px `--border`, `--radius-card`, hover: `translateY(-6px)` and
`--shadow-card`. Post card: 10 px padding with the cover inset at 18 px radius and a
16:10 ratio, then a tag chip (first entry of `badgesList`, when any), Fraunces title,
date and reading time. Content card (a `###` block of Servicios or Quiénes somos,
§5.8): the block's first image as media at 4:3, or a 56 px circle with the card's
number (services) or the first letter of the name (team); Fraunces title; the block's
text, lists and links. 1.5 rem padding, 3 / 2 / 1 columns at the post grid's
breakpoints.

### 5.6 CTA band

A `--tint` container with `--radius-band`, 72 px padding (40 on phones), two columns:
left «¿Hablamos?» as h2 and `page_contacto_subtitle`; right the pills **Contactar**,
**WhatsApp** (with `whatsapp_number`) and the phone (with `biz_phone`), then
`biz_hours`. Always rendered: it has a default title and the Contactar button needs no
data.

### 5.7 Footer

`--bg-elevated`, top corners at `--radius-band`, four columns: company (logo or initial
circle, name, `biz_street` / `biz_postal_code` / `biz_city`, hours, phone); Navegación;
Legal (plus Condiciones with a catalogue and Área de profesionales with `b2b_enabled`);
Síguenos with Instagram and Facebook icons **only when the admin has set the links**.
Bottom row: ©, the AI transparency line and the Biglobster credit, all kept.

### 5.8 Interior pages

Quiénes somos, Servicios, Contacto, Blog index: a chip eyebrow with the page name, the
Fraunces h1 with the optional accent word, subtitle, image at `--radius-card`, body in a
68ch column. Contacto: the address, phone and hours block becomes three small icon
cards, the form sits in an elevated card with pill inputs; the privacy note and
Turnstile slot are unchanged. Blog post: unchanged layout, Cálida type, TOC in a tint
card. Legal pages: type and colour only.

Two content-shaped pieces come out of the build, in Cálida only (slice 2; Clásico
renders every body exactly as before, byte for byte):

- **Cards from `###` blocks** (`src/content/content-cards.js`). On Servicios and
  Quiénes somos every `###` heading and what follows it, up to the next `###` or
  `##`, is a card (§5.5); the text before the first `###` stays prose above them, and
  an `##` ends a run of cards, so a body can go prose → cards → prose → cards. A team
  member's photo is the first image of their block. The home teaser (§5.3) shows the
  first three services cards.
- **FAQ accordions** (`src/content/faq-accordion.js`). The FAQ block the blog already
  marks up for `buildFaqLd` — a `## Preguntas frecuentes` (or «FAQ», «Preguntas y
  respuestas») heading, each question as `###` with its answer beneath, two or more
  answered — renders on any of the four page bodies as `<details>` with a tinted,
  rounded summary and a chevron, and the page emits its FAQPage JSON-LD like a post
  does. Fewer than two answered questions and the block stays plain headings, so the
  accordion and the data never disagree. Run before the cards transform, so the
  questions are never mistaken for services.

The not-found page is built like any other (`site/404.njk`, served with a 404 by
`src/not-found.js`), so it carries the nav, footer and tokens of the site's style.

### 5.9 Catalogue

Tokens do most of the work: product cards and shop blocks get `--radius-card`, buttons
and category pills become pills and chips, the shop hero is a tint band, the B2B banner
a tint card. **Markup, ids and class names stay as they are**: `cart.js` and the B2B
flow read them. Verified against a local instance seeded from a real feed (see
`CLAUDE.md`, "Before declaring done").

## 6. Dark mode

Tokens in §3. Photos are not filtered. `--tint-2` turns to a warm dark plum so the glow
is still warm. The accent stays raw for fills, with white text on them (4.9:1 on the default
teal), and only `--accent-ink`, the accent used as text, is lightened. Shadows get
darker, not removed. The existing toggle, `bl-theme` key and `theme_default` are unchanged, so
`/cookies` stays true.

## 7. Motion

Existing `.reveal` stagger (+60 ms per sibling); card lift; arrow nudge; the two hero
floating elements drift ±10 px on a 7–9 s loop; the nav pill gains its shadow after the
first 24 px of scroll (one `scroll` listener, passive). All of it under
`@media (prefers-reduced-motion: no-preference)` only. No marquee, no parallax, no
page-transition work in this spec.

## 8. Accessibility

Muted text ≥ 4.5:1 on the ground; accent text always `--accent-ink`, never the raw
accent; focus rings 2 px `--accent-ink` with 2 px offset on every pill and chip; touch
targets ≥ 44 px; decorative SVG `aria-hidden`; hero floating cards are real links.

## 9. Slices

1. **Cálida base** (one PR, done in `feat/estilo-calida`): `site_style` + wizard default + panel select; tokens;
   fonts; nav, hero (with blob, backdrop, floating card and chip), bands, cards, chips,
   pills, icons partial, CTA band, footer; interior and catalogue restyle; dark mode;
   motion; `page_index_highlights`; docs (`README.md`, `INSTRUCCIONES-CLIENTE.md` + PDF,
   `FORMULARIO-CLIENTE.md`); agent prompt note for the accent word and highlights
   (hermes repo, separate PR).
2. **Content-shaped sections** (done, stacked on slice 1, 2026-10-17): build-time
   transforms that turn the `###` blocks of Servicios and Quiénes somos into cards
   (services teaser on home, team cards) and the FAQ block of any page body into
   accordions with FAQPage data; the 404 page built in the site's style (§5.8).
3. **More styles:** A «Editorial» and B «Studio» as token bundles plus the few
   style-specific rules each needs (hairlines and numbering; marquee and stickers).

## 10. Decisions taken in this spec (veto here, not in code review)

- Clásico is kept as a style so no live deploy changes look on a release.
- Cálida's default accent is teal `#1a7e6f`; the brand colour from the wizard overrides it.
- One optional new field, `page_index_highlights`; everything else derives from
  existing data.
- The accent word is marked by the author (`*word*`), never guessed.
- Services cards come from `###` blocks (slice 2); the tint band stays as the
  fallback for a body without them.
- Slice 2 is Cálida-only, the page-level FAQPage data included, so a Clásico build
  stays byte-identical to the one before it. Emitting the data in both styles is a
  one-line change in `site/_data/site.js` (`page_faq_ld`), should it ever be wanted.
