# Gap Analysis — current build vs. the LeadSquared audit

**Date:** 21 Aug 2026 · **Scorecard re-checked against the code:** 3 Sep 2026
**Audit basis:** `docs/legacy-leadsquared/LEADSQUARED-CRM-REFERENCE.md`, Parts 1 and 7
**Subject:** the CRM in this repo (`server/`, `client/`) as built to date

---

## How to read this

The audit asked me to check whether what I have already built repeats any of the
ten failure modes in Part 1. It does repeat some of them. Three of those are
cheap to fix today and expensive to fix after cutover, so they are the ones that
matter.

I have tried to be blunt, as asked. Where I think Part 7 is wrong for our case I
say so in `docs/data-model.md` rather than here.

**Current state, for context:** Node + Express + SQLite (`node:sqlite`) + React.
253 passing tests. **No production data** — the database is seeded fixtures only.
That last fact is the single most important input to every "now vs. later"
judgement below: schema changes are nearly free today and get permanently more
expensive the moment 495,118 leads land on them.

---

## Scorecard against the ten findings

| # | Finding | Status | Where |
|---|---|---|---|
| 1 | Overloaded stage enum | ✅ **Closed** | separate `state` / `stage` / `kyc_portal_stage`; 5 stages, not 32 |
| 2 | Opportunity as generic work item | ✅ Avoided | `product_cards` / `tickets` / `kyc_journeys` are distinct |
| 3 | Cross-entity activity mirroring | ✅ Avoided | one `activities` table, multi-parent FKs |
| 4 | Timestamps stamped by automation | ✅ **Closed** | `field_history` is first-class and queryable; stage entry/exit tracked |
| 5 | Undefined automation ordering | ✅ **Closed** | `engine/conflicts.js` — priority, static conflict detection, failure queue |
| 6 | Notes appended to parent record | ✅ Avoided | `notes` table + per-interaction `activities.body` |
| 7 | Shared login accounts | ✅ Avoided | one identity per human, scrypt, sessions |
| 8 | Static lists / flat query power | ✅ **Closed** | nested AND/OR trees in `engine/conditions.js`; static / refreshable / dynamic lists |
| 9 | No cascading picklist validation | ✅ Avoided | `dispositions` enforced server-side |
| 10 | No versioning | ⚠️ **Partly closed** | rules, templates, KYC journeys, SLA policies versioned with diff and rollback (`engine/versioning.js`); dispositions, KRA and incentives still carry active/effective flags only |

Plus the explicit checklist from the brief:

| Failure mode to check for | Present? |
|---|---|
| A single overloaded status enum | No longer — split into separate dimensions |
| Opportunity used as a generic work item | No |
| Stamped counters instead of computed aggregates | No longer — derived, with `field_history` behind it |
| Notes appended to the parent instead of the interaction | No |
| Flat-only AND/OR query filters | No longer — nested condition trees |
| Vendor names embedded in entity types | No, but see 3.4 |

> **Read the sections below as a record of what was true on 21 August, not as a
> description of the build.** The scorecard above is current; the prose that
> follows was written before any of it was fixed and is kept because the
> reasoning for each decision is still the useful part. Section 1 in particular
> argues for three refactors that have since been done.

---

## 1. What must be refactored now

These three share a property: they are cheap today and become progressively
impossible later, because the wrongness gets baked into historical data rather
than just into code.

### 1.1 `leads.kyc_status` is a stamped mirror of a child entity — delete it

**What I built.** `kyc_journeys` is a proper child entity: own status, own
current step, per-step progress rows in `kyc_journey_progress`, multiple per
lead (one per product). That is exactly Part 7's `Application`, and it is right.

**What contradicts it.** `leads.kyc_status` also exists, maintained separately.
So does `leads.kyc_portal_stage`. Two columns on the parent re-encode a child
entity's state.

This is precisely the mechanism that produced `mx_KRA_status`,
`mx_DIY_Account_Opened` and `mx_Ready_To_Trade` in the legacy tenant. Finding 1
says the tenant "compensated with dozens of `mx_` fields re-encoding the same
journey". I have started the same compensation, from the opposite direction —
I built the child entity first and then stamped a summary onto the parent for
convenience of querying.

The audit already shows where that ends. It also shows the failure mode when the
two disagree: Part 6 records a live record where
`Telecaller Calling Status = "Not Contactable"` while `Lead Stage = READY TO TRADE`
— "contradictory states coexisting because different automations maintain each
with no cross-validation." I have two writers for KYC state today.

**Fix.** Derive it. `kyc_status` becomes a computed projection over
`kyc_journeys`, not a column. Where the list view needs it for sorting, use a
view or a materialised read-model that is rebuilt, never hand-maintained.

**Cost of delay:** low effort now (one column, a handful of call sites). After
migration, every historic lead carries a value that may not match its journeys,
and no one can tell which was right.

### 1.2 `leads.score` and `leads.aum` are stamped counters — the exact thing finding 3 is about

**What I built.** `applyScore()` does
`UPDATE leads SET score = MAX(0, score + ?)` on every activity.
`syncTradingDb()` stamps `leads.aum` on a nightly sweep.

**Why this is the worst item on the list.** The legacy tenant's second-largest
automation is `Activity Score` at **8,023,974 lifetime triggers**, and Part 2.3
lists `mx_ConnectedAttempts`, `mx_Number_of_Follow_Up`, `mx_WhatsApp_Count`,
`mx_Total_Connects_and_Attempts` as "counters maintained by automation → should
be computed aggregates over the timeline". Part 6 notes the lead-detail KPI tiles
(Lead Score, No Of Not Connects, No of Connects, Number of Pitch Done) are "all
driven by automation-maintained counter fields."

I have reproduced this pattern faithfully. `leads.score` is an incrementing
counter with no way to recompute it, no way to audit it, and no way to correct it
if the scoring rules change. If we decide next quarter that a WhatsApp reply is
worth 5 instead of 3, every historical score is silently wrong and unrecoverable.

**Fix.** Score and AUM become derived values computed over `activities` and
`product_cards`. Cache them if the query cost demands it, but as a rebuildable
projection with a `computed_at`, never as an authoritative column.

**Cost of delay:** this is the one I would fix first. Today the "history" is
seed data. Post-cutover, the incremental counter is the only record of its own
derivation and cannot be reconstructed.

### 1.3 Rule conditions are flat AND-only — this is finding 8's root cause, in our code

**What I built.**
- `rules.conditions` — JSON `[{field, op, value, join}]`
- `assignment_rules.conditions` — JSON `[{field, op, value}]`, evaluated by
  `matches()` with `.every()`, i.e. **AND only**. The `join` key is not even
  honoured in the assignment engine.
- `lead_lists` + `lead_list_members` — **stored membership rows**.

Finding 8 is unambiguous about where this leads: *"The root cause is query power.
Advanced Search offers only a flat Any/All … you cannot express
`(A AND B) OR (C AND D)`. So people leave the product to do real segmentation."*
Result: 4,810 static CSV-derived lists against 495,118 leads.

I have built both halves of that trap — a flat condition model *and* stored
membership. Bonanza's users will do exactly what they do today, because we have
given them exactly the same limitation.

**Fix.**
- One recursive condition tree shared by rules, assignment rules and segments:
  `{op: 'AND'|'OR', children: [...]}` with leaves `{field, op, value}`.
- Segments become saved queries evaluated live. Snapshot only where a point-in-
  time membership is genuinely needed (a campaign send), with a TTL and a
  recorded reason.

**Cost of delay:** the condition JSON shape is persisted. Every rule written
between now and the change has to be migrated. Ten rules today; hundreds after
the business starts configuring.

---

## 2. What must be decided now, built soon

### 2.1 There is no `Party`, and no `Account` — leads and partners cannot be the same human

**What I built.** `leads` and `partners` are unrelated tables. A partner has
`name`, `mobile`, `pan`, `bank_account` of their own. There is no link between a
lead record and a partner record for the same person.

**What the audit says.** Part 7 puts `roles[]: Prospect | Customer | Partner/AP |
Employee` on a single `Party`, explicitly "concurrent, not exclusive", and
Finding 1 calls out the parallel partner journey (`PARTNER ESIGN DONE`,
`ARN INFO SUBMITTED`) as one of the four concepts crushed into the stage enum.

For a broker this is not hypothetical. A customer who becomes an Authorised
Person is one human with two roles. Today I would create two records, and every
360° view, every deduplication check and every consent flag would be split
across them.

**Related:** `leads.client_code` is a single column. The audit is explicit that
`mx_Client_Code_1..6` "is a one-to-many. In the new CRM it is a child **Account**
entity." I have flattened it to one — the same mistake with a smaller number.

**Fix.** Introduce `Party` with concurrent `party_roles`, and `Account` as a
child holding client codes, depository and per-segment activation. `leads`
becomes a role/view over `Party`, not a separate species of record.

**Cost of delay:** this is the largest structural change and it touches every
route. It is also the one I am least willing to defer, because merging two
record types after they both hold production data is a data-quality project, not
a refactor. I would rather do it before cutover than after.

### 2.2 No field-change history, no stage entry/exit timestamps

`card_audit` gives me from/to/when/who for product-card transitions — good, and
already better than the legacy system for that entity. But there is nothing
equivalent for `leads`: no field-level before/after, no stage entry/exit times.

Finding 4 says six legacy automations exist *only* because LeadSquared lacks
this, and Part 7 lists it as a cross-cutting requirement that "kills 6
automations, ~15 fields on day one."

I have already started down the same path without noticing: `leads.assigned_at`,
`leads.first_response_at` and `leads.next_follow_up_at` are all stamped columns
that exist because there is no history to query. `next_follow_up_at` in
particular I added *yesterday*, denormalised, with a comment justifying it on
performance grounds. That is the identical reasoning that produced
`mx_First_Intent` and `Capture PAN Submitted Date`.

**Fix.** A generic `field_history` table (entity, entity_id, field, old, new,
actor, at) written by one choke point in the data layer, plus stage entry/exit
derived from it. Then delete the stamped columns that exist only to be queried.

### 2.3 No versioning anywhere

Finding 10. Nothing in my build is versioned: not `rules`, not `dispositions`,
not `kyc_steps_master`, not `templates`. The moment someone edits a disposition's
`follow_up_hours`, every historical activity that used the old value is
silently reinterpreted, and there is no diff and no "what did this rule look like
in June?".

The legacy tenant's answer to this was `- Clone` and `…19Aug 2025V4-` in names. We
will get the same, because we have given ourselves the same constraint.

**Fix.** Version the definition, point at a current version, keep in-flight
records on the version they started under. Additive, so it can follow 1.1–1.3.

### 2.4 Automation conflict detection

`rules.priority` and `assignment_rules.priority` exist, so ordering is defined —
better than the legacy race condition in Finding 5. But there is no static check
for "these two rules both write `owner_id` on the same trigger", and no way to
answer "what writes to this field?", which the audit identifies as the root cause.

---

## 3. What is genuinely fine, and why

Stated briefly, because the brief rightly warns against a gap analysis that finds
nothing wrong.

**3.1 One shared interaction timeline.** `activities` carries `lead_id`,
`card_id` and `partner_id` and is never mirrored. This avoids the single largest
automation in the legacy tenant (14,140,741 triggers). It was not deliberate
foresight about that automation — it just fell out of having one table — but it
is right and should not change.

**3.2 Four distinct work entities.** `product_cards` (deal-like, per product),
`tickets` (case), `kyc_journeys` (process instance), `lead_lists` (segment).
Finding 2's collapse of 35 pipelines into ~4 entity types is already the shape
here. The per-product card model is arguably better than Part 7's flat `Deal`,
and I argue that in the data-model document.

**3.3 Cascading dispositions enforced at the API.** Finding 9 exactly. Built
yesterday: `dispositions` carries `requires_datetime` / `requires_reason` /
`sets_card_state`, and `validateDisposition()` rejects at the API, not the form.
The audit's warning that "a large share of writes arrive via API/automation and
would bypass UI-only validation" is why it was done server-side.

**3.4 Vendor quarantine — mostly.** Activity types are generic (`Call`,
`WhatsApp`, `Meeting`) with vendor adapters behind `src/vendors/`. There is no
`Zoom Meeting` activity type. Two leaks remain: `activities.external_id` and
`activities.recording_url` sit on the core record rather than in a
`vendor_ref{provider, external_id}` sub-object, and `leads.wa_last_inbound_at` is
a channel-specific column on the parent. Both are small and should be tidied when
1.1 is done.

**3.5 One identity per human.** No shared credentials; scrypt-hashed, session-
expiring, per-user. Finding 7 avoided.

**3.6 Consent surface exists but is thin.** I have `marketing_opt_out` and
`mobile_invalid`. The audit (Part 2.2, Part 8.5) is explicit that
DoNotCall / DoNotEmail / DoNotSMS / opt-in status / date / details are
**regulatory** surface for a SEBI-regulated broker and must migrate with full
fidelity. One boolean is not that. Expanding it is cheap and I have listed it in
the data model.

---

## 4. What I would throw away

Asked plainly, so answered plainly. Not much needs deleting; most needs
*deriving* instead of *storing*.

| Thing | Verdict |
|---|---|
| `leads.score`, `leads.aum` | Keep the concept, delete the columns. Compute. |
| `leads.kyc_status`, `leads.kyc_portal_stage` | Delete. Derive from `kyc_journeys`. |
| `lead_list_members` | Delete. Segments become live queries; snapshot only on send. |
| `leads.next_follow_up_at`, `assigned_at` | Delete once field history exists. |
| Flat condition JSON in `rules` / `assignment_rules` | Replace with a recursive tree. Migrate the 11 existing rules. |
| `leads.client_code` (single) | Replace with an `Account` child entity. |
| `leads` / `partners` as unrelated tables | Restructure under `Party` + roles. |
| Everything else | Keep. |

Nothing built in the last two days (dispositions, follow-ups, reminders,
assignment) needs to be thrown away — but the assignment engine's condition
evaluator must be rewritten onto the shared tree in 1.3, and it is better to do
that before more rules exist.

---

## 5. Sequence, with reasoning about cost of delay

1. **Condition tree + live segments** (1.3) — blocks rule authoring; every rule
   written before it must be migrated.
2. **Computed score and AUM** (1.2) — the derivation is unrecoverable once real
   history accrues.
3. **Party + roles + Account** (2.1) — largest blast radius, and merging record
   types after go-live is a data project rather than a refactor.
4. **Field history, then delete the stamped columns** (2.2) — additive first,
   subtractive after.
5. **Drop `kyc_status` mirror** (1.1) — trivial once 2.2 lands.
6. **Versioning** (2.3) and **conflict detection** (2.4) — additive, safe to
   follow.

Items 1–3 should happen before any production data exists. Items 4–6 can follow
during build.

---

## 6. Open questions — I need a business decision, not a technical one

1. **Workforce management (audit Part 4.5).** Check-in/check-out, work-day
   templates, holiday calendar, leave tracker, assignment quotas, IP whitelisting.
   `Auto Check Out 8:00 PM` has 128,482 triggers, so it is genuinely in use. Does
   this belong in the new CRM, or in an HRMS with an integration? The audit says
   explicitly: do not let this default silently.

2. **Cutover strategy.** Big-bang replacement, or dual-run alongside LeadSquared
   with sync? This changes the architecture, not just the plan — dual-run needs
   bidirectional sync, conflict resolution and a system-of-record decision per
   field. The handoff notes this is something only you can tell me.

3. **Data-quality profile (audit Part 9, top priority).** No fill rates or value
   distributions were captured. 113 custom Text and 82 Dropdown fields against
   only 2 Booleans means flags are stored as free text. I cannot write a
   trustworthy migration map without knowing which of the 338 fields are actually
   populated. This is a cheap export and it is the highest-value missing input.

4. **Multi-account clients.** Does one Bonanza/Bigul customer routinely hold more
   than one client code — and are Bonanza and Bigul codes different codes for the
   same human? This decides whether `Account` is a child entity (my assumption)
   or whether client code can stay on the party.

5. **Partner-who-is-also-a-customer.** How common, and should their partner
   commissions and their own portfolio be visible on one record? This decides how
   hard `party_roles` has to work.

---

## Decisions taken — 21 Aug 2026

Answers to the open questions in section 6, recorded here so they are not
re-litigated.

| Question | Decision | Consequence |
|---|---|---|
| **Cutover** | **Phased by desk or module.** One desk moves first, then the rest. | Needs an explicit migration boundary so both systems never own the same lead. A `migrated` marker per team/desk, and routing that refuses to assign a lead into a desk still live on LeadSquared. |
| **Identity** | **Party + concurrent roles + Account as a child entity.** One human may hold several client codes and may be both customer and partner. | The largest refactor. `leads` and `partners` stop being separate species; both become roles over `Party`. `leads.client_code` becomes `account` rows. |
| **Workforce** | **Operational bits only.** Working hours, holiday calendar and assignment quotas stay in the CRM because SLA clocks and routing need them. Attendance, shifts and leave go to an HRMS. | Adds a holiday calendar the SLA and follow-up engines must consult — today they only know 09:00–19:00 Mon–Sat and would count a public holiday as a working day. |
| **Refactor scope** | **All three "fix now" items approved** — condition tree, computed score/AUM, drop the `kyc_status` mirror. | Proceeding. Party/Account follows once these land. |

### Order of work now agreed

1. Shared recursive condition tree (1.3) — unblocks the automation builder.
2. Computed score and AUM (1.2) — the derivation is unrecoverable once real
   history accrues.
3. Drop the `leads.kyc_status` mirror (1.1).
4. Holiday calendar, so SLA and follow-up clocks stop counting holidays as
   working days (from the workforce decision).
5. `Party` + roles + `Account` (2.1).

### Still outstanding

**The data-quality profile.** The audit's own top-priority gap (Part 9, item 1):
fill rate and distinct values for all 338 lead fields. Without it the migration
map cannot be trusted — 113 custom Text and 82 Dropdown fields against only 2
Booleans means flags are stored as free text and will contain
`Yes`/`YES`/`Y`/`1`/`true`. This is a cheap export from LeadSquared and it
blocks `docs/migration-map.md`, nothing else.

### Further decisions — 22 Aug 2026

| Question | Decision | Consequence |
|---|---|---|
| **Scoring** | **Signals, with a composite score on top.** Four explainable signals are the primary read; a score built from them drives sorting and leaderboards. | The formula must be versioned and visible, so a reweighting does not silently rewrite history. Both are computed, never incremented. |
| **First desk** | **Digital Onboarding Team.** | Highest volume and the journey already built most completely. The migration boundary must stop routing from assigning leads into desks still live on LeadSquared. |
| **Holidays** | **Two calendars, tracked separately.** Office holidays pause SLA and follow-up clocks; NSE/BSE trading holidays additionally suppress trade-related follow-ups. | The office can be open on a settlement holiday, so one calendar cannot express both. |
| **Party merging** | **Auto-link on exact PAN; everything else to a review queue.** | PAN already carries a blind index, so exact match is cheap. Mobile is explicitly NOT an auto-link key — families and small businesses share numbers. |

---
---

# Part 2 — Reconciliation against the Salesforce design reference

**Added:** 22 Aug 2026
**Basis:** `docs/salesforce-reference/SALESFORCE-DESIGN-REFERENCE.md`, Parts 1, 6, 7 and 8
**Role of that document:** target *architecture*. Business requirements still
come from the LeadSquared audit and from you — never from the Salesforce sample
data, which is generic ("Bertha Boxer", "Farmers Coop. of Florida").

## Filling in the two placeholders the brief left blank

**Stack:** Node 24 · Express 5 · `node:sqlite` (Postgres at pilot) · React 19 +
Vite. 1,153 passing tests. **No production data** — seeded fixtures only.

**Scope and timeline:** phased cutover, Digital Onboarding Team first, per the
decisions recorded above. Correct me if either is wrong; both shape everything
below.

---

## Scorecard against the sixteen hard constraints

| # | Constraint | Status |
|---|---|---|
| 1 | One shared Interaction timeline, never mirrored | ✅ Met — `activities` with multi-parent FKs |
| 2 | Notes on the interaction, never on the parent | ✅ Met |
| 3 | **Computed fields are a schema feature, not automation** | ✅ **Met** — `formula` and `rollup` are declared field types in `engine/metadata.js`, marked `derived`, computed on read and never stored |
| 4 | Field-change history + stage entry/exit, queryable | ✅ **Met** — `field_history`, indexed by record and by field |
| 5 | **Label ≠ API name** | ✅ **Met** — `field_def.api_name` is immutable, `field_def.label` renameable |
| 6 | **Uniform per-object configuration** | ✅ **Met** — `entity_def` and `field_def` cover all seven objects: lead, client, case, partner, task, interaction, product_interest |
| 7 | OWD floor, then grants only | ⚠️ **Half met, unchanged** — grant-only ✅, still no OWD floor and no internal/external split |
| 8 | **Owner is polymorphic (User or Queue)** | ✅ **Met** — `queues` table with `leads.owner_queue_id` beside `owner_id`, two nullable keys rather than a type-plus-ref pair |
| 9 | Record types over pipeline sprawl | ⚠️ Sideways — per-product cards instead; see below |
| 10 | Segments as live nested queries | ✅ Met — condition tree, nested to any depth |
| 11 | Cascading picklists enforced at the API | ✅ Met — `dispositions` |
| 12 | Rule priority + static conflict detection | ✅ **Met** — `engine/conflicts.js` provides `detectConflicts`, `ambiguousOrdering` and `healthReport` |
| 13 | **Automation failure queue** | ✅ **Met** — `rule_failures`; each action is attempted independently, so one dead number no longer aborts the run and skips every lead after it |
| 14 | **Configuration audit log** | ✅ **Met** — `config_audit` beside `audit_log`, plus versioned snapshots with diff and rollback in `engine/versioning.js` |
| 15 | Vendor detail quarantined | ✅ **Mostly, unchanged** — `activities.external_id` and `activities.recording_url` still sit on the core record, as noted in §3.4 |
| 16 | **Encrypted field type at schema level** | ✅ **Met** — `encrypted_text` is a declared type; PAN carries it on the field rather than being encrypted at each call site |

Thirteen met, one mostly, two half. **No zeros.**

The four that were zero on 21 August shared one cause — there was no field
metadata layer — and building that one thing closed all four: label versus API
name, uniform per-object configuration, field-change history, and the polymorphic
owner that needed a place to declare itself.

Three things are left, and only the first is a hole rather than a choice:

- **7 · no OWD floor.** Access is grant-only with no restrictive default
  underneath it and no internal/external split. This is the one item on this
  scorecard that is a real hole rather than a design choice.
- **15 · two vendor columns on the core record.** `activities.external_id` and
  `activities.recording_url` belong in a vendor-reference table. Small, known,
  and not yet worth a migration.
- **9 · record types.** Still per-product cards instead. That is a divergence
  from the Salesforce pattern taken on purpose; see the section below.

---

## The one thing that matters more than the rest

### There is no metadata layer, and that is the whole idea

Part 1 item 1 of the Salesforce reference is not a feature request. It is the
architecture:

> *"Design the metadata layer first. Entity definition, field definition, layout
> definition, permission definition — all generic, all applying uniformly. Then
> 'Lead' and 'Deal' are just rows in that metadata."*

What I have built is the opposite. `leads`, `partners`, `tickets` and the rest
are hand-written SQL tables with hand-written routes each. Adding one field today
means: a migration, an INSERT column, a SELECT column, a validator, a form
control, and a test. Six edits in five files, by a developer, per field.

Salesforce's actual product is that those six edits are one row in a table.

**This is why constraints 5, 6, 8 and 14 all fail together.** Label-vs-API-name,
uniform configuration, polymorphic owner and a config audit log are not four
separate features — they are four things you get for free once field and entity
definitions are data, and four things you cannot retrofit cheaply while they are
code.

**Blunt version:** if the goal is "Salesforce-like configurability", the current
entity layer cannot get there by extension. It would have to be rebuilt on top of
a metadata layer. The engines are fine; the substrate is not.

**What that does and does not condemn.** It condemns the *entity and route
layer* — the per-table CRUD in `routes/crm.js`, `routes/partners.js` and their
siblings. It does not condemn the engines built on top, which are the harder and
more valuable half:

| Keep | Why it survives |
|---|---|
| `engine/conditions.js` | Operates on a field registry — the registry becomes metadata rather than a constant |
| `engine/dispositions.js` | Already data-driven and API-enforced; Part 6 row 9 asks for exactly this |
| `engine/followups.js` | Business logic, entity-agnostic |
| `engine/assignment.js` | Needs `owner` to become polymorphic; otherwise unchanged |
| `engine/metrics.js` | Becomes the *implementation* behind Formula/Rollup field types |
| `engine/access.js` | Grant-only model is right; needs an OWD floor beneath it |
| `engine/kyc.js`, `engine/sla.js` | Unaffected |
| `vendors/*`, `routes/webhooks.js` | Vendor quarantine already correct |

So: roughly the engines survive, the substrate is rewritten, and the UI is
rebuilt generically rather than per screen.

---

## Where I disagree with the Salesforce reference

### Record types vs. the per-product card (Part 6, row 2)

Part 6 says one `Deal` object with record types per business line, replacing 35
pipelines. For the 35-pipeline problem, that is plainly right.

But Bonanza sells **eleven products to the same person concurrently**, and the
question the desk asks is *"what does this client not yet hold?"*. On a record-typed
`Deal`, that is an anti-join against a product catalogue. On the per-product grain
already built, it is a column.

**Proposal:** both, at different grains. `Deal` with record types for the
business lines that genuinely are separate pursuits (Global Investments, Partner
onboarding, Algo). `ProductInterest` retained for the concurrent product matrix
that drives the coverage view. They are not competing models; they answer
different questions.

I flag this as the place I am most likely to be wrong, because it is the one
place I am arguing to keep something I already built.

### Two identifiers, but not the `__c` suffix (Part 1, item 3)

Label/API-name separation: agreed, unreservedly — it is the fix for
`mx_Subscription_End_dtae` being permanent. The `__c` suffix convention itself is
Salesforce's own historical debt (Part 7 item 2 warns against inheriting exactly
this kind of thing). A `custom: true` flag on the field definition carries the
same information without encoding it in the name.

---

## Revised sequence

Items 1–3 of the earlier plan are **done** (condition tree, computed metrics,
`kyc_status` mirror still pending). The Salesforce reference reorders what
follows:

1. **Metadata layer** — entity, field, layout, picklist definitions as data,
   with label/API-name split and an encrypted field type. Everything else below
   depends on it.
2. **Formula and Rollup as field types**, with `engine/metrics.js` as the engine
   underneath.
3. **Field history + stage entry/exit**, which the metadata layer makes generic
   rather than per-table.
4. **Polymorphic owner + Queue entity.**
5. **OWD floor** beneath the existing grant-only model, with internal/external
   split for partners.
6. **Config audit log**, automation failure queue, static conflict detection.
7. **Party + roles + Account** — unchanged in intent, but far cheaper once
   entities are metadata.
8. Approvals — scope to be decided (see questions).

**Cost of delay is now sharper.** Every additional hand-written entity and route
increases the cost of the metadata migration. The `Party` work in particular
should wait until the metadata layer exists, or it will be written twice.

## Decisions — 22 Aug 2026, after the Salesforce reference

| Question | Decision | Consequence |
|---|---|---|
| **Metadata depth** | **Hybrid.** Core entities keep real SQL columns; admins add custom fields into an adjacent value store. Every entity still exposes the same configuration surfaces. | Core queries stay fast at 495k leads. Custom fields cost a join. The configuration UI is built once, generically, and applies to both. |
| **Approvals** | **All four scopes:** partner onboarding & elevation, account closure & retention, fee waivers / discounts / brokerage changes, bulk actions & lead reassignment. | Needs a generic approval engine — entry criteria, approver resolution, record locking, audit trail — not four bespoke flows. |
| **OWD floor** | **Private, widened by role and sharing.** | Nothing is visible by default. Sharing rules and the role hierarchy must be configured before anyone sees anything beyond their own book — including supervisors. This is stricter than today's behaviour and will change what existing roles see. |
| **Interaction visibility** | **Split — metadata open, content restricted.** Everyone who can see the lead sees that a call happened, when, and its disposition. The notes body and the recording require ownership or supervision. | Field-level security on `interaction.notes` and `vendor_ref.recording_url`, not row-level. Coverage reporting and "who has gone quiet" keep working for supervisors without exposing what was said. |

### What this changes about the OWD decision specifically

Today `lead.view.all` is held by seven of eleven roles, so most people see the
whole org. A Private floor inverts that: visibility must be granted. Before this
ships, sharing rules need to exist for the supervisor and product-RM cases, or
those roles go blind. That ordering is a build constraint, not a detail.

---

## Build log — item 1 of the revised sequence is done

**Metadata layer.** Shipped 22 Aug 2026. 33 tests. Detail in
[data-model.md](data-model.md) Revision 3.

Against the sixteen constraints in the Salesforce reference, this closes five and
partially closes a sixth:

| # | Constraint | Before | Now |
|---|---|---|---|
| 5 | Label ≠ API name | not met | **met** — two identifiers, `api_name` frozen at creation, re-seeding preserves an admin's rename |
| 6 | Uniform configuration surfaces | not met | **met** — one route set serves all six entities and anything created later |
| 11 | Cascading picklists enforced at the API | half | **met** — `setCustomValues()` validates the cascade; imports and integration writes cannot bypass it |
| 13 | Configuration audit log | not met | **met** — `config_audit`, before and after, separate from the data audit |
| 4 | Field history + stage entry/exit | half | **met** for tracked fields — `stageDurations()` derives spans from history |
| 3 | Computed fields are schema, not automation | half | **declared** — `formula`/`rollup` exist as types and reject writes; the evaluators are item 2 |

Two things arrived that were not on the list, because the work exposed the need:

**Field-level security.** The split-interaction decision could not be built on
row-level security — hiding an interaction to protect its note also hides that
the call happened, and supervision reporting goes dark. So `read_scope` moved
onto the field. It then turned out to be the right home for PAN and bank account
too, which were being masked at each call site and had leaked twice this build.

**A governance gate at field creation.** The audit's 289-custom-field problem is
not a schema problem; it is the absence of a question at creation time. Purpose
is now required and near-duplicate labels are surfaced.

### Two defects fixed in passing

The e2e suite deactivated seeded users and never restored them, so it passed
exactly once per reseed and thereafter failed with thirty-plus cryptic 401s. It
now hands the book back and reactivates. Re-running without a reseed now fails
only on the KYC fixtures, which are genuinely consumed, and which the suite
already explains in its own words.

`.backdrop`, `.modal` and `.modal-lg` were referenced by the shared Modal
component but had no CSS rules at all. Every dialog in the application — Create
user, Create rule, Upload template, and the new field form — rendered inline at
the foot of the document rather than over it, roughly 1,100px below the fold on
a 720px viewport. Clicking the button appeared to do nothing. The overlay is now
fixed, dimmed and centred, and its surface is 98.4% opaque for the same reason
the org-switcher popover is: a surface that covers content cannot be glass, or
the text underneath shows through the text on top.

### Test totals

| Suite | Tests |
|---|---|
| e2e | 228 |
| metadata | 33 |
| conditions | 25 |
| de-identification | 21 |
| vendor adapters | 20 |
| **Total** | **327** |

### Next — item 2

Formula and Roll-Up evaluators, with `engine/metrics.js` underneath. The types
and the storage contract exist; what is missing is the expression parser and the
aggregate compiler. That is what lets the two busiest legacy automations be
deleted rather than reimplemented.

## Decisions — 22 Aug 2026, second round

| Question | Decision | Consequence |
|---|---|---|
| **Sharing dimension** | **Manager chain.** `users.manager_id`, at any depth. | No new data needed — the column is populated. Composes with role scope rather than replacing it: the floor is Private, role scope (own / team / product / org) is the first grant, manager chain is the second. |
| **Formula language** | **Curated set**, chosen from a list rather than typed. | Covers every legacy automation that only computes. Cannot be written into a loop, cannot be made undebuggable, and ships against the same storage contract a parser would later use. |
| **Market data vendor** | **Global Datafeed.** | Mapping written against their shape; a sample response is still needed to confirm field names before it goes live. |
| **Migration map** | **Deferred.** | The LeadSquared data-quality export is not being pulled now. Cutover planning resumes later. |

### The Superadmin problem, and why the composition already solves it

Manager-chain sharing alone would blind the two roles that most need sight.
Superadmin and Admin have **zero direct reports** — Rohit Menon owns no leads at
all — so a pure hierarchy grant gives them an empty screen.

This is why the floor is widened by *role and sharing*, not by sharing alone:

```
visible(user, lead) =
      owns(lead)                       -- the Private floor
   OR roleScope(user) admits lead      -- own | team | product | org
   OR manages(user, lead.owner)        -- the sharing layer, any depth
```

Superadmin and Admin keep `data_scope = 'org'` and are unaffected. Supervisors
gain their reports' books without needing `lead.view.all`. A Product RM keeps
product scope wherever the lead sits. Nothing needs a special case.
