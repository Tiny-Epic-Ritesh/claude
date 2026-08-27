# Feedback Round 1 — status by item ID

Source: `Bonanza-AI-CRM-Feedback-Round-1.md`, Ritesh, 26 Aug 2026.
Status values: **Done** · **Partial** · **In build** · **Blocked** · **Not started**

## Decisions taken (22 Aug, before development)

| Ref | Decision |
|---|---|
| Sequencing | **Real defects first, then the unbuilt modules.** Four P0s are modules that were never built, not regressions. |
| Q-16 | **Admin + Super Admin only.** Marketing Manager keeps masked PII — that role segments and sends; it never needs to read a PAN. Setup screen still ships so you can widen it later, and every unmask is audited. |
| Q-06 / Q-13 | **Build fully, simulate until credentials land.** Composer, templates and attachments all work; sends go through the existing adapter and log an Activity. Live by setting credentials, no code change. |
| Q-14 | **One assistant, context-aware.** Extend the existing Copilot rather than add a second. One place where residency and permission scoping are enforced. |
| Q-27 | **Confirmed** — `/ai-crm/dkyc` and `/ai-crm/portal`. |
| Q-GEN | **Yes, a design system exists** — tokens in `client/src/styles.css`. All UI items extend those tokens rather than adding one-off CSS. |

## The framing correction

Thirteen tabs render a deliberate "In build" placeholder, not a broken page:
pipeline, clients, calendar, products, ccm, team, revenue, kra, incentives,
campaigns, content, lists, dashboards.

**BUG-20, BUG-25, BUG-26 and ENH-24 are therefore net-new modules**, not fixes,
and are the largest items in the document. They are sequenced after the genuine
defects by agreement.

A real defect sits underneath them: unknown `/api/*` routes returned **200 with
HTML** because the SPA fallback caught them. An unbuilt endpoint must 404.

## Status

| ID | Area | Pri | Status | Note |
|---|---|---|---|---|
| BUG-01 | Login field alignment | P2 | **Done** — root cause was the input selector, see below | |
| BUG-02 | Dark theme, login email | P1 | **Done** — same root cause | with BUG-18 |
| ENH-03 | Scrolling ticker | P2 | **Done** - continuous marquee, seamless loop, pauses on hover, on every page | |
| ENH-04 | Ticker role control | P2 | **Done** - role + per-user toggle in Setup > Navigation, audited | Q-03/Q-04 confirmed |
| ENH-05 | Summary-card drill-through | P1 | **Done** — metrics carry a destination; 5 of 6 linked per cockpit | needs Q-05 |
| ENH-05a | Drill-through per role | P1 | **Done** — same mechanism, every role, filters respect data scope | |
| ENH-06 | Email composer | P1 | **Done** - composer opens from the address; templates, free text, collateral, files, consent-checked | simulates until SMTP is configured |
| BUG-07 | Copilot breaks layout | P0 | **Done** — `.copilot` had no CSS at all | |
| ENH-08 | Role→tab matrix | P1 | **Done** - confirmed matrix seeded, editable in Setup > Navigation, per-user overrides, audited | Q-08 confirmed |
| ENH-09 | Market items link out | P2 | **Done** - headline links to source; simulated items say the link arrives with the live feed | needs Global Datafeed |
| ENH-10 | Rename to Products | P2 | **Done** - display labels only; API names untouched | Q-10 confirmed |
| ENH-10a | Replace status dots | P1 | **Done** — "1 Warm · 2 Active"; hover still gives product names | |
| ENH-10b | Directive actions | P1 | **Done** - each state names its step and why; server-declared; alternatives kept beside it | stage model sent |
| ENH-10c | Richer View popup | P1 | **Done** - one request carries pitch, objections, history, what was tried, KYC and consent | |
| ENH-10d | Start Engaging actions | P1 | **Done** - Call / WhatsApp / SMS / Email, each consent-checked before it is offered | |
| ENH-11 | Group NBA + Start Call | P2 | **Done** — grouped into a record toolbar | |
| ENH-12 | Warm card meaning | P1 | **Done** — "Products marked Warm", clickable, lands filtered | needs Q-12 |
| BUG-13 | Quick Actions dead | P0 | **Done** — were spans, not buttons; server now declares each destination | |
| ENH-14 | Contextual AI help | P1 | **Done** - one assistant, page-aware, returns links only to records the reader can already open | answer quality needs an AI key |
| ENH-15 | Advanced Search UX | P1 | **Done** - Match all/any wording, inline help, four starter filters, live plain-English readback | |
| ENH-16 | Unmask + config | P1 | **Done** - Admin/Superadmin/Marketing unmasked; per-field per-role config in Setup > Field masking | Q-16 confirmed |
| ENH-17 | Tabs above summary | P1 | **Done** — tabs sit directly under the header, above the summary | |
| BUG-18 | Dark theme audit | P1 | **Done** — same root cause, verified across the lead edit form | |
| ENH-19 | Input styling | P2 | **Done** — all 45 untyped inputs now inherit the design system | |
| BUG-20 | Pipeline | P0 | **Done** — card board by state, weighted open value, scoped | |
| BUG-21 | Log Activity opens | P0 | **Done** — modal host had no case for it; composer existed but was unreachable | |
| ENH-21a | Highlight connected | P1 | **Done** — Connected/Not Connected are now the first, largest choice | |
| ENH-21b | Log Activity UX | P1 | **Done** — two-step picker, keyboard shortcuts, 0 chips until you choose | |
| ENH-21c | Dispositions in Setup | P1 | **Done** - editable in Setup > Call outcomes; effects shown beside each label; edits survive a deploy | Q-21c confirmed |
| ENH-22 | Setup in main nav | P2 | **Done** - Setup in the header for anyone who has it | |
| ENH-23 | Launcher animation | P2 | **Done** - tint, lift and a quarter-turn on hover | |
| ENH-23a | Launcher icon size | P2 | **Done** - 44px target, 26px glyph, its own resting tint | |
| ENH-23b | Launcher by role | P1 | **Done** - already enforced server-side; now covered by a test | |
| ENH-24 | Dashboard | P1 | **Done** — per-role tiles, alerts first, every tile drills through | Q-24 confirmed |
| ENH-24a | Date range | P1 | **Done** — Today / Month / Quarter / FY, FY starts 1 April | |
| ENH-24b | Placement | P1 | **Done** — on the homepage, same component backs the tab | |
| BUG-25 | Lead Lists | P0 | **Done** — three kinds, 06:00 IST refresh, bulk actions with consent preview | Q-25 confirmed |
| BUG-26 | Clients | P0 | **Done** — clients is its own object; list, detail, unified timeline, dormancy | Q-26 confirmed |
| BUG-27 | Portal/DKYC URLs | P0 | **Done** — both resolve to /ai-crm/… | confirmed |
| ENH-28 | Partner Portal usable | P1 | **Done** - client cards and training rows are real buttons that open detail | |
| ENH-28a | Commission trend | P1 | **Done** - month names on the axis, plus a sentence saying the direction and what drove it | |
| ENH-28b | Client drill-down | P1 | **Done** - client detail panel; products, KYC, commission earned, no PII | |
| ENH-28c | Training detail | P1 | **Done** - module detail with summary, contents, duration, and mark-complete | |
| — | API 404 not HTML | P1 | **Done** | unknown /api routes now 404 with JSON |
