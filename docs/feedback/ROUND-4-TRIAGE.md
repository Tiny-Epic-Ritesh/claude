# Round 4 — per-ID status

**Source:** [ROUND-4-source.md](ROUND-4-source.md) — an independent QA audit, 43
findings, received 13 October 2026.

**What the auditor asked for:** "Claude Code should return per-ID status
(`fixed`, `partly fixed`, `not started`, or `needs decision`) with evidence
against this document and earlier feedback IDs." This is that document.

## The ledger — every point in the report, and where it stands

Kept current: a commit that closes a point changes its row here and says so.
Last updated **13 October 2026**: `84c2c2f`, `eaf4743`, `d34bb6b`, the QA-02 design, the rulings of 13 October, the partner-access commit `72fa94d` (OPS-15, 16, 17, 25, 26), and the commit after it (OPS-18 to OPS-24).

**States.** *fixed* — in code, tested, pushed. *not started* — open, no
blocker. *needs decision* — waiting on Ritesh, and nothing is built until it is
answered. *unverified* — the auditor's evidence stands but I have not traced it
to a line yet. *environment* — a change to labs.tinyepic.in itself, not the code. *closed by
ruling* — Ritesh ruled that the behaviour reported is the behaviour wanted.

**Today, of the 43 IDs: 21 fixed · 1 closed by ruling · 5 partly fixed · 16
open · none waiting on a decision.** Every decision asked for was answered on 13
October; QA-37's is answered once its recommendations are in. Plus the points
below the table, which are not IDs but are as much part of the report.

### The 43 findings

| ID | Pri | State | Note |
|---|---|---|---|
| QA-01 | P0 | **fixed** `84c2c2f` | Form sends `route: false`. Its second half, adjacent (e), is `OPS-19`, fixed. |
| QA-02 | P0 | **fixed** · QA-02 commit | A rule fires once per change: `rule_firings` records what each rule has done to each lead, a delayed stage runs once if the lead still matches, a repeat happens only if the rule asks, and the stored schedule — office hours, weekends, a daily limit — is read at last. The waterfall is staged as answered and holds while a High or Critical case is open; an abandoned journey becomes one task. Leads already acted on are taken as fired at deploy. The duplicates on labs: `server/scripts/qa02-duplicate-tasks.mjs`, preview by default, for Ritesh to run. [QA-02-SCHEDULER-DESIGN.md](QA-02-SCHEDULER-DESIGN.md), "As built". |
| QA-03 | P0 | **fixed** `84c2c2f` | `engine/cases.js`. |
| QA-04 | P1 | **fixed** `eaf4743` | The Leads page reads the date window — and the source chart's `source` — a tile sends, and shows each as a removable chip. Tile and list compare the same dates. Both compared IST dates against UTC timestamps: adjacent (j), `OPS-24`, fixed — both read IST days now. |
| QA-05 | P1 | **partly fixed** `eaf4743` | "Open cases" opens on All open (`?view=`, `?open=true`). The case-summary strip is still not clickable, and "Resolved today" was not traced. |
| QA-06 | P1 | open · **ruled 13 Oct** | Marketing may view unmasked PII (decided earlier). Export: allowed, with a Setup control for Admins and Superadmins that chooses masked or unmasked export. To build. |
| QA-07 | P1 | not started | A UI build: draft-until-Save on Manage, and a consequence summary with Confirm for Escalate and Resolve (Ritesh's Part 4). Confirmed by the report; no code defect to trace. |
| QA-08 | P1 | **fixed** `84c2c2f` | Every link book-checked too. |
| QA-09 | P1 | open · **ruled 13 Oct** | No definitions given; Ritesh asked for them to be set from standard broking practice. One definitions note for QA-09, 24 and 35, built to and written down for confirmation. |
| QA-10 | P1 | not started | A UI build: an opaque, scrollable call panel with a visible End call and state-aware actions. Confirmed by the report; needs a design pass in both themes. |
| QA-11 | P1 | **fixed** `eaf4743` | One resolver, `fill()` in the merge engine, for the composer, test-send and campaign send. A field masked for the sender is refused by name. **`{{name}}` in campaigns is now the first name**, as the picker always said. The picker's static examples are untouched. |
| QA-12 | P1 | **partly fixed** `eaf4743` | The screen shows `CRM_PUBLIC_URL` or the origin it is itself using — https. Refusing a key sent over plain http needs the proxy to say the scheme (`X-Forwarded-Proto`), which is nginx, which I do not touch. |
| QA-13 | P1 | open · **ruled 13 Oct** | A Bonanza partner cannot refer Bigul products today, and the business wants to be able to allow it later: a Setup control for Admins and Superadmins, off by default. The DKYC half of the question was not part of the answer and stays as built -- a journey takes its product's book (`OPS-05`). |
| QA-14 | P2 | not started | Pipeline multi-select products and per-stage filters. |
| QA-15 | P2 | not started | Pagination and column sorting, `P3-36`/`37`/`39`. |
| QA-16 | P2 | not started | Report builder and dashboard creation, `P3-06`/`P2-17` — gated on `N-4a`. |
| QA-17 | P2 | not started | One `DD-MM-YYYY` display formatter. |
| QA-18 | P2 | not started | App Launcher outside-click, `P3-31`. |
| QA-19 | P2 | **fixed** `eaf4743` | "Create list" goes to Lead Lists for whoever holds `list.create`. |
| QA-20 | P2 | **fixed** `eaf4743` | Tasks and Tickets count what they list, like every other tab. |
| QA-21 | P2 | **fixed** `eaf4743` | The handoff names the Product RM(s) asked and the High-priority task it gave them. 60-second timing still unmeasured. |
| QA-22 | P2 | not started | Market headlines are not links, `ENH-09`. |
| QA-23 | P2 | **fixed** `eaf4743` | An egress row records what actually answered; the table says Sent abroad, Served locally, or — for rows before 13 Oct — Not recorded. |
| QA-24 | P2 | open · **ruled 13 Oct** | What `Won` means — QA-09's definitions note. |
| QA-25 | P2 | **partly fixed** `eaf4743` | The breach answer says whose tickets it counted. The drawer covering dashboard cards is untouched. |
| QA-26 | P1 | **fixed** `84c2c2f` | |
| QA-27 | P2 | **fixed** `eaf4743` | A delete returns to the list with a confirmation and a link straight to the recycle bin. |
| QA-28 | P1 | **fixed** `84c2c2f` | Four compliance flags still need a category ruling. |
| QA-29 | P2 | not started · **needs a reproduction** | Not explained by the code: the server counts live, nothing caches, and Done reloads. Needs watching in a browser. |
| QA-30 | P1 | **fixed** `84c2c2f` | Including duplication. |
| QA-31 | P2 | **fixed** `eaf4743` | Any whole-rupee minimum; zero is zero, not "not set"; a negative is refused on create and edit. |
| QA-32 | P1 | **fixed** `84c2c2f` | And the cross-book backfill it would have switched on. |
| QA-33 | P0 | **fixed** `84c2c2f` | Override question open; partner #9 cleanup is *environment*, below. |
| QA-34 | P1 | **partly fixed** `d34bb6b` | Every DKYC step is checked against its own declaration — required, pattern, listed options, dates not in the future, numbers in range — before any vendor call, and stored normalised. All six of the auditor's values are refused. PIN tightened to the house rule (`V.pincode`); account number 9–18 digits and a nominee share of 1–100 are new. **Still open:** keeping the mobile the journey started with rather than asking again; and the two rulings, **ruled 13 Oct — follow industry practice**: to build. |
| QA-35 | P2 | open · **ruled 13 Oct** | The summary query is a bug; what Active means is QA-09's definitions note. |
| QA-36 | P1 | **closed by ruling** 13 Oct | Not a bypass: Sales RM and Sales Supervisor hold `pii.unmask`, so the edit form's unmask is permitted and audited. Ritesh ruled that opening the editor should show contact details without a click, which is what it does. |
| QA-37 | P2 | open · **recommendations due** | Which entities get rename / retire / archive. Ritesh asked for industry-standard recommendations first, then a decision. The partner portal's revoke control is built (`OPS-15`). |
| QA-38 | P2 | **fixed** `eaf4743` | Send email / SMS / WhatsApp open when any purpose is allowed; the dialog asks Service or Marketing and the API enforces it. |
| QA-39 | P2 | **fixed** `eaf4743` | The manual message and the list bulk send name their sender. Automated sends stay "system". The bulk send wrote two entries per lead: adjacent (i), `OPS-23`, fixed. |
| QA-40 | P2 | **fixed** `eaf4743` | The log tabs called the Setup-health counter; they call the log counter. |
| QA-41 | P2 | **fixed** `eaf4743` | A refusal shows, on all fourteen screens that put the spinner first. |
| QA-42 | P1 | not started · **needs a reproduction** | Not explained by the code: a Dealer holds `card.mark.exploring` and the panel offers Mark as Exploring. Needs watching as a Dealer. |
| QA-43 | P1 | **partly fixed** `eaf4743` | The detail shows the refusal instead of spinning. List and detail still disagree on scope — one of `N-12`'s cases. |

Counted: **fixed 21** — QA-01, 02, 03, 04, 08, 11, 19, 20, 21, 23, 26, 27, 28,
30, 31, 32, 33, 38, 39, 40, 41. **Closed by ruling 1** — QA-36. **Partly fixed
5** — QA-05, 12, 25, 34, 43. **Open 16** — QA-06, 09,
13, 24 and 35 (ruled 13 Oct, to build); QA-37 (recommendations due); QA-07 and
QA-10 (UI builds); QA-14 to QA-18 and QA-22 (feature requests under earlier
IDs); and QA-29 and QA-42, which the code does not explain and need a
reproduction. Every open ID is traced or classified; none is "unverified". The
rulings inside QA-28 and QA-33 are listed below rather than counted, because
those IDs are fixed.

### Everything else the report asks for

| Point | Where in the report | State |
|---|---|---|
| Per-ID status back, against the report and earlier IDs | §7, retest gate | **Delivered** — this document, kept current |
| Re-run the linked reproduction paths **after deployment** | §7, retest gate | Pending a deploy of `84c2c2f` to labs.tinyepic.in — a deployment, which I do not do |
| **Revoke synthetic partner #9's portal access and sessions** — "priority cleanup" | §9, and QA-33 | **handled in code, pending deploy.** `OPS-15`'s start-up check withdraws every stored `partner<id>` password with its sessions, #9's included, the first time the fixed build starts on labs; the record itself is kept, as §9 asks. *Withdraw portal access* now exists on the partner's page. |
| A scoped, auditable cleanup mechanism for test entities the UI cannot retire | §9 | not started — depends on QA-37's lifecycle decision |
| Preserve reproduction records #40–#44, cases #9–#11, lists #3–#4, campaigns #3–#4, partners #9–#10, rule #6, automation #2 until retest | §9 | Nothing here touches them; they live in labs.tinyepic.in's database |
| BRD gate P0 — API allow/deny tests for every role and business | §1 | not started — the largest open item. `N-12` is part of it |
| BRD gate P1 — dialler/AI disposition, 90s/120s timing | §1 | partly: QA-28 fixed; real dialler blocked on `N-6` (CUBE credential) |
| BRD gate P2 — Warm handoff, partner elevation, 60-second notification timing | §1 | partly: QA-33 fixed; timing untested |
| BRD gate P3 — DKYC validation, timers, abandonment, audited override | §1 | QA-34 not started; the rest untested |
| BRD gate P4 — SLA sweep and reopen, live delivery, CSAT | §1 | QA-30 fixed; the rest untested |
| Pilot gates: credential hashing, session expiry and revocation, server-side authorisation, partner isolation, KYC document encryption and retention, consent and DND, India residency, the pilot database, latency and availability | §1 | not started as an **evidence** exercise. Some exist in code (passwords are hashed; PAN is encrypted); none has been written up as the auditor asks |
| Implementation sequence, steps 1–9 | §6 | Steps 1 (records), 5 (validation, partly), 6 (partner activation) advanced by `84c2c2f`. Step 2, QA-02, built 13 Oct. Steps 3, 4, 7, 8, 9 not started |
| Evidence attached to each fix | §6 | Tests in `round4.test.mjs`; before/after screenshots need the deployed build |
| Regression table against Rounds 1–3 and Ritesh's Part 4 | §4 | Each item maps to an ID above; nothing there is separate work |

### Found while fixing, needing their own OPS ids

**Ids assigned 13 Oct:** (a) `OPS-15`, (b) `OPS-16`, (c) `OPS-17`, (d) `OPS-18`,
(e) `OPS-19`, (f) `OPS-20`, (g) `OPS-21`, (h) `OPS-22`, (i) `OPS-23`, (j)
`OPS-24`. Fixing (a) found two more, fixed with it on approval — `OPS-25`, an
elevation approval that skipped the onboarding check, and `OPS-26`, partner
responses carrying the stored password hash — and one recorded open, `OPS-27`.
**Fixed:** all ten, and OPS-25 and 26. Fixing (j) found two more, recorded open:
`OPS-28` and `OPS-29`. State of each is in the OPS table at the top
of [OUTSTANDING.md](OUTSTANDING.md). Not counted above: they are not report IDs.

### Rulings asked for

Answered 13 Oct: 1. QA-13 (a Setup control, off) · 2. QA-09/24/35 (standard
practice) · 3. QA-06 export (allowed, with a masked/unmasked Setup control) ·
4. QA-37 (recommendations first) · 7. OPS ids (assigned) · 8. QA-02 (signed off) ·
9. QA-36 (yes) · 10. QA-34 (industry practice). **Still open:** 5. the category
for each of the four unmapped compliance flags (QA-28) · 6. whether a Superadmin
needs an audited emergency elevation (QA-33) · and the DKYC half of QA-13.

## Read this first: the build they tested is the build we have

labs.tinyepic.in was running `1cff7c3` (18 September). **No commit landed between
27 September and 3 October**, so nothing was in flight during the audit. The
seventeen commits since are N-6 (CUBE), N-10 (picklist books, KYC verification and
objection), OPS-14 (picklist enforcement) and documentation. None of them was
aimed at anything in this report.

So the honest headline is that **nothing in Round 4 has been fixed**, and the
report should not be read as partly stale. One finding, QA-01, needs its claim
narrowed rather than its status changed — see below.

## What I verified in code, and what I did not

Eleven findings — the ten the auditor asked to be prioritised, plus QA-08 — were
traced to a line. Those say **verified** and name the cause. The remaining
thirty-two say **unverified**: the report's own evidence stands, I simply have not
re-derived it, and I am not going to record a status I did not establish. Several
of those are decisions rather than defects, and those are marked as such whatever
their code state.

## The priority set, with causes

| ID | Pri | Status | Cause, in code |
|---|---|---|---|
| QA-01 | P0 | **fixed** 13 Oct · verified | The server already gets precedence right, and did in the tested build: `crm.js` line 978, `const routable = req.body.route ?? (!owner_id && INBOUND_SOURCES.has(...))`. The bug is in the client. `Leads.jsx` line 594 renders *Assign to me* as `<option value="">`, so the form posts an empty owner, `!owner_id` is true, and a Website lead routes away from the person who just claimed it. **Narrow the finding: not "routing overrides the selection" but "the selection is never sent."** Fix at both ends — carry the creator's id in the option, and have the server distinguish an absent owner from one explicitly set. The report's second observation, that the form offers owners a Sales RM should not see, is separate and also open. |
| QA-02 | P0 | **not started** · verified | `engine/rules.js` has no idempotency of any kind: no key, no already-fired check, no bounded retry. It writes `rule_runs` (line 539) but never reads it to decide whether to act. Nothing stops a sweep re-firing against a record it has already acted on, which is what 48,243 firings against 41 leads describes. |
| QA-03 | P0 | **fixed** 13 Oct · verified | `portal.js` line 161: `SELECT id FROM users WHERE role = 'customer_care' AND active = 1 ORDER BY (...) LIMIT 1` — **no `sales_org` filter**, so a Bonanza partner's ticket goes to whichever Customer Care user is least loaded in either book. The INSERT on line 164 carries no `sales_org` and no `category_id`, which is why the case reads *Uncategorised*. And hard-coding `role = 'customer_care'` bypasses the SLA category table that says `Partner Support → Partner RM`. Three defects in one query. **This is the fifth instance of the book-boundary class behind OPS-05, OPS-06, OPS-07 and OPS-08** — all fixed 17–18 September, all in other routes. The portal was missed. |
| QA-33 | P0 | **fixed** 13 Oct · verified | `partners.js` line 447, `POST /:id/request-elevation`, refuses with "N onboarding step(s) still incomplete". Line 462, `POST /:id/elevate`, checks `partner.elevate` and nothing else. The auditor's narrowing is exactly right: the guard exists on the normal path and is absent on the privileged one. |
| QA-28 | P1 | **fixed** 13 Oct · verified | Three case-creation paths, three different levels of completeness. `tickets.js` line 299 inserts `category_id` and `sales_org` and calls `applySla` (line 309). `portal.js` line 164 calls `applySla` but inserts neither. `ai.js` line 235 inserts neither **and never calls `applySla` at all** — hence a High compliance case with no category and no due timestamps. |
| QA-30 | P1 | **fixed** 13 Oct · verified | `admin.js`, the send handler from line 1340: `const template = campaign.template_id ? one(...) : null`. The template is optional and a null one falls through to a default body, which is the "Bonanza update" the auditor saw. There is no approved-content guard at the API. |
| QA-32 | P1 | **fixed** 13 Oct · verified | `admin.js` line 152 refuses unless `code` is present. The screen promises a generated permanent code and offers no Code input, so the form cannot satisfy it. Either generate server-side or expose the field; the screen's promise says generate. |
| QA-34 | P1 | **not started** · verified | `kyc.js` contains no field validation whatsoever — no `validate()` call, no format check on PAN, mobile, IFSC or PIN, and no nominee total. `ifsc` is passed straight through (line 316). Every value the auditor pushed through is accepted because nothing looks at any of them. |
| QA-26 | P1 | **fixed** 13 Oct · verified | A one-word asymmetry. `POST /leads` validates `name: ['required', 'max:120']` (line 885). `PATCH /leads/:id` validates `name: ['max:120']` (line 1085) — **no `required`** — so an empty name passes the API and the database raises `NOT NULL constraint failed: leads.name`. |
| QA-08 | P1 | **fixed** 13 Oct · verified | `POST /tasks` (line 1869) requires a title and a due date, and checks the book of `lead_id` when one is given, but nothing requires *any* of `lead_id`, `card_id`, `ticket_id` or `partner_id`. All four default to null. The page's mandatory-link promise is unenforced and has no selector. |
| QA-36 | P1 | **needs decision** — traced 13 Oct, see the ledger | The client deliberately re-fetches `/leads/:id?unmask=true` for the edit form (`LeadDetail.jsx` line 1014), with a comment that the parameter is refused without `pii.unmask`. If that refusal holds, a Sales RM's form should not have been populated — so either the server gate does not cover this role or it does not cover this route. That is one read of `unmaskRequested`/`maskFor` and I have not done it. |

## Fixed on 13 October

The eight surgical fixes, in one pass. `server/test/round4.test.mjs` carries
28 tests through the shipped routes. Run against the unfixed code (`b0920fd`),
**20 fail, and every one of the eight findings has at least one that does**; the
other eight pass on both, because they guard what must keep working.

| ID | What changed |
|---|---|
| QA-01 | The New lead form sends `route: false`. The server's precedence rule was right and is untouched. The biting test is a check of the form's source -- weaker than a behavioural one, and the best available without a browser. |
| QA-03, QA-28 | One way to open a case, `engine/cases.js`, used by the case screen, the Partner Portal and the AI disposition. Each case now gets its book, its category, the least-loaded agent **in that book**, a `BNZ-`/`BGL-` reference by book, and its SLA clock. A portal ticket is Partner Support; a Complaint flag is a Complaint case. The AI door had the portal's cross-book defect too: `role = 'customer_care' LIMIT 1`. |
| QA-33 | `POST /:id/elevate` asks the same onboarding question as `request-elevation`, through one helper. No override was built. |
| QA-26 | A lead PATCH that mentions the name may not blank it, whitespace included. |
| QA-08 | `POST /tasks` needs at least one link, and **every** link is now book-checked -- only the lead was, so a partner, case or card id from the other book went straight in. The Tasks page gained a lead search, and shows a refusal instead of swallowing it. |
| QA-32 | The server issues the code the screen promised: from the name, in the catalogue's style, `BG-` for Bigul, numbered when taken. The product gets its business, and the dialog shows its own errors. |
| QA-30 | A campaign carries an approved template for its own channel from creation, an edit cannot strip or mismatch it, a duplicate is made on the same terms, and test-send and send ask again. The stock "Bonanza update" body is gone. |

**Fixing QA-32 would have switched on a dormant cross-book defect**, so it was
fixed in the same change rather than left: a new product put a card on every
lead in **both** businesses, against the rule `generateCards` states for new
leads. It never fired only because no product could be created.

Existing tests were updated where they encoded the old contract: the e2e
suite created seven campaigns with no content, and a supervisor test
created an unlinked task without checking that it had been created at all.

### Found beside the fixes, and deliberately not widened into them

Ten of them.

Each wants its own OPS id.

| | What | Where |
|---|---|---|
| a | **Every partner activated from the screen has the portal password `partner<id>`.** The route defaults to it when given none, the screen never sends one (`PartnerProfile.jsx` posts `{}`), and the response returns it in plain text. The auditor's partner #9 on labs.tinyepic.in is ACTIVE with `partner9`. Guessable by anyone who knows a partner's number. | `partners.js`, `/:id/elevate` |
| b | The partner code is `BNZ-P####` for every partner, Bigul's included. | same route |
| c | `POST /partners` never sets the partner's business, so every new prospect is Bonanza's by column default -- the defect tickets, campaigns and now products each had. | `partners.js` |
| d | The AI disposition confirm loads its lead with no book check, so any user can change card states, the score and raise cases on a lead in either business. **One of `N-12`'s cases.** | `ai.js`, `/disposition/confirm` |
| e | The New lead form offers owners a Sales RM may not assign, and `POST /leads` takes any active owner in the book without `lead.reassign`, which the edit requires. The second half of the auditor's QA-01. | `Leads.jsx`, `crm.js` |
| f | Product create silently drops the brochure and apply URLs the form sends. | `admin.js`, `POST /products` |
| g | A campaign's template is checked for approval and channel, not for business: a Bonanza campaign can send a Bigul template. | `admin.js` |
| i | A list bulk send writes **two** timeline entries per lead — `send()` writes one and the route writes its own — against non-negotiable 1, one shared timeline. Found fixing QA-39, which now signs both. | `lists.js`, `/:id/bulk/message` |
| j | Date windows compare IST dates with UTC timestamps, so a lead made between midnight and 05:30 IST counts on the day before — in the tile and the list alike, so they agree, and both are off. | `engine/daterange.js` |
| h | Duplicating a campaign never sets the copy's business, so a Bigul campaign's copy is filed in Bonanza's book -- the defect the create route's own comment describes fixing. | `admin.js`, `/campaigns/:id/duplicate` |

And two rulings: which category each of the other four compliance flags opens
(mis-selling risk, a guaranteed-return expectation, a regulatory mention,
urgency on funds -- uncategorised until then, with their deadlines), and
whether a Superadmin needs an audited emergency override for QA-33.

## Decisions only Ritesh can make

These are not defects to fix. They block the fix.

| ID | The decision |
|---|---|
| QA-13 | May a Bonanza partner refer Bigul products, and may Bonanza-branded DKYC open Bigul accounts? The auditor explicitly says not to infer the answer from the present UI. Everything about catalogue filtering and brand copy waits on this. |
| QA-09, QA-24, QA-35 | What do `Won`, partner-client `Trading`, product-card `Active`, an issued UCC, accrued commission and paid commission each mean, and which is authoritative for which screen? Three findings are the same conflation. |
| QA-06 | Marketing may now view unmasked PII — already decided. **Export is a separate decision and is still open.** The screen currently offers Export and then refuses it, which is wrong either way. |
| QA-37 | Which configurable entities get rename/retire/archive, and which keep immutable history? Ten entities, one policy call. Includes the revoke path QA-33's cleanup needs. |

## Already-known work this report re-evidences

The auditor cross-references these themselves; I have not re-verified them.

| QA | Existing ID | Note |
|---|---|---|
| QA-04, QA-05 | Round 1 `ENH-05`/`05a`, Round 2 `P2-13`/`P2-17c` | Metric drill-through. The date predicate is dropped while the stage one applies. |
| QA-14 | Round 4 of Ritesh's own feedback | Pipeline multi-select products and per-stage filters. |
| QA-15 | `P3-36`/`37`/`38`/`39` | Pagination absent, most column sorting absent; the bulk-update "across all pages" wording is premature until pagination exists. |
| QA-16 | `P3-06`, `P2-17` | Custom report builder and dashboard creation — both already open and both gated on `N-4a`. |
| QA-17 | Ritesh's date-format request | One display formatter, `DD-MM-YYYY`, ISO preserved in storage and API. |
| QA-18 | `P3-31` | App Launcher stays open on outside click. |
| QA-22 | `ENH-09` | Market headlines are static text, not links. |
| QA-02 | older handoff `B-01` | Same scheduler defect, now with counters. |
| QA-03 | older handoff `B-02` | Same cross-business assignment, now with a reproduction. |

## Unverified, and needing a pass of their own

**Spent, 13 October.** All twenty below were traced the same day; where each
landed is in the ledger at the top. What follows is the list as it stood that
morning.

QA-07, QA-10, QA-11, QA-12, QA-19, QA-20, QA-21, QA-23, QA-25, QA-27, QA-29,
QA-31, QA-38, QA-39, QA-40, QA-41, QA-42, QA-43.

Two worth flagging inside that list:

- **QA-43** is the same shape as `N-12`, which is already open: a record-id route
  whose list and detail disagree about scope. The Product Supervisor's KYC list
  includes a journey whose detail API returns 403. When N-12 is worked, this is
  one of its cases.
- **QA-12** I looked for and could not find. `ApiAccess.jsx` renders
  `{data.base_url}` from the server rather than a hard-coded `http://`, so either
  the server composes it wrongly or this is already correct. It needs the one
  check, not a rewrite.

## Suggested order

The auditor's order is sound and I would not change it. QA-01, QA-02, QA-03 and
QA-33 first. Of those, three are small and one is not:

- **QA-01, QA-03, QA-33 are each a few lines**, and QA-26, QA-08, QA-28, QA-32 and
  QA-30 are the same size. Eight surgical fixes, each with a test, is one focused
  pass.
- **QA-02 is a design change, not a patch.** Idempotency keys, bounded retries and
  a retention policy for `rule_runs`, plus reconciling 48,000 existing activities
  and 10,000 duplicate tasks without destroying audit evidence. It wants its own
  scoping and its own sign-off.
- **QA-34 is medium.** The validation rules themselves are easy; the open question
  is where they live, because the same values arrive from DKYC, from import and
  from automation writes, and the report rightly asks for all three.

What I propose: the eight surgical fixes first, in one pass with tests, then
QA-02 scoped separately, then QA-34. The four decisions above can be answered in
parallel and do not block that work.

**13 October:** the eight are done. QA-02 and QA-34 are next.
