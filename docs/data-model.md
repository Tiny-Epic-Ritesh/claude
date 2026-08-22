# Target Data Model

**Date:** 21 Aug 2026
**Basis:** `docs/legacy-leadsquared/` Part 7, argued with rather than implemented
**Stack:** Node 24 · Express · SQLite today (Postgres at pilot) · React
**Status:** proposal. Nothing here is built yet — awaiting review, per the brief.

---

## Where I disagree with Part 7

Part 7 says it is a hypothesis to argue with. Four arguments.

### 1. `Deal` should stay a per-product card, not a flat pipeline object

Part 7 proposes `Deal{pipeline, stage, value, expected_close, owner, win_loss_reason}`
— one row per pursuit, `pipeline` naming which of the ~12 genuine deal types it is.

I think that is a step backwards for this business, and I want to defend what is
already built. Bonanza sells **eleven products to the same person concurrently**.
A client can hold Equity active, be mid-KYC on MF, be pitched PMS, and have
declined Insurance — simultaneously. Modelled as `Deal.pipeline`, that is four
rows whose only relationship is a shared `party_id`, and the questions the desk
actually asks — *"what does this client not yet hold?"*, *"which of my clients
have an untapped product?"* — become anti-joins against a product catalogue.

The existing `product_cards` model already answers those directly: one row per
(party × product), always present, carrying a state. The audit's own Revenue
Board reference does exactly this — "Coverage 6/12 ACTIVE PRODUCTS" with six
untapped products listed — and that view is trivial on cards and awkward on deals.

**Proposal:** keep the card grain. Rename it `ProductInterest` to stop it reading
as a UI artefact, and add the deal-ish fields Part 7 wants (`value`,
`expected_close`, `win_loss_reason`) onto it. It is a Deal; it just has a
guaranteed row per product rather than being created on demand.

**Where Part 7 is right and I will change:** cards currently exist for every
product on every lead (310 rows for 30 leads). At 495,118 leads × 11 products
that is 5.4M rows, most of them `INACTIVE` and meaningless. Materialise a card
only once it leaves `INACTIVE`, and treat absence as inactive.

### 2. `Segment` should not be listed beside the entities — it is not one

Part 7 puts `Segment` in the entity list with "computed membership, NOT a stored
owned record". Agreed on the substance, but listing it alongside `Party` and
`Deal` invites someone to build a `segments` table with rows in it, which is how
the 4,810 lists happened. A segment is a **saved query**. I model it as a
definition with no membership table at all, and say so loudly in the schema.

### 3. Consent needs to be its own entity, not a block of columns on `Party`

Part 7 has `consent: do_not_call, do_not_email, do_not_sms, opt_in_status, opt_in_at, opt_in_source`
as a flat block. For a SEBI-regulated broker facing a TRAI DND regime, the
question that gets asked in an audit is not "is this person opted in?" but
**"prove what their consent state was on 14 March, and who changed it."** Flat
columns cannot answer that.

**Proposal:** `ConsentRecord` as an append-only log per (party, channel), with
the current state derived. Costs one join; makes the regulatory question
answerable. Part 8.5 calls consent "regulatory … must migrate with full fidelity
and provenance" — provenance is precisely what a mutable column destroys.

### 4. Scoring: drop it rather than rebuild it

Part 2.6 records that **46 of 54 activity types score zero** and calls the model
"vestigial". I have faithfully rebuilt a scoring system anyway
(`SCORE_RULES` in `engine/rules.js`) with the same weakness — arbitrary weights
nobody tuned.

**Proposal:** do not migrate a lead score. Replace it with a small number of
explicit, named signals computed on demand — `days_since_contact`,
`connect_rate`, `products_held`, `untapped_products`, `last_positive_outcome` —
which a supervisor can reason about and argue with. A single opaque number that
nobody can explain is worse than four numbers they can. If a composite is wanted
later, build it on top of these, versioned, with the formula visible in the UI.

---

## The model

Written as the target. `→` marks a change from what exists today.

### Party — one row per human or organisation

```
party
  id
  kind                    person | organisation
  full_name
  display_name
  date_of_birth
  gender
  father_spouse_name
  language                                    ← routing input, not decoration
  sales_org               BONANZA | BIGUL     ← existing tenancy model, unchanged
  created_at, updated_at, deleted_at

  → NO stage, NO score, NO kyc_status, NO client_code, NO aum.
    Every one of those is either a role, a child entity, or a projection.
```

**Identity, separated** — because PAN is the dedupe key and needs its own
constraints, and because a person can hold several client codes:

```
party_identifier
  party_id
  kind                    pan | aadhaar_ref | boid | dp_id | client_code | ckyc
  value_encrypted                             ← AES-256-GCM, as today
  value_blind_index                           ← HMAC, for equality search
  verified_at, verified_by
  is_primary
  UNIQUE (kind, value_blind_index) WHERE kind = 'pan'
```

`party_identifier` replaces `leads.pan` and `leads.client_code`. The audit's
`mx_Client_Code_1..6` becomes rows, not columns — and `Account` (below) is where
the *meaning* of a client code lives.

### PartyRole — concurrent, never exclusive

```
party_role
  party_id
  role                    prospect | applicant | customer | partner | employee
  status                  active | dormant | closed
  since, until
  PRIMARY KEY (party_id, role)
```

This is the fix for Finding 1's fourth concept and for gap-analysis 2.1. A human
who is both a customer and an Authorised Person holds two rows. `leads` and
`partners` as separate tables go away; both become views over `party` filtered by
role.

**Lifecycle stays a small stable enum, on the role, not the party:**
`prospect → applicant → customer → dormant → closed`. Six values, and it never
absorbs KYC steps or disqualification reasons.

```
disqualification
  party_id, role
  reason                  not_interested | relevant_not_interested | no_response
                          | invalid_data | already_client | do_not_disturb
  detail_text
  at, by_user_id
```

→ Separate and nullable, exactly as Finding 1 asks. It is set from the
disposition matrix already built, which already demands a reason.

### Application — the onboarding journey, already right

```
application
  id, party_id
  type                    equity | mf | partner | reactivation | shifting | global
  status                  in_progress | stalled | abandoned | under_objection
                          | verified | complete | rejected
  current_step
  → per-step timestamps live in application_step, not as columns
  started_at, completed_at
  version_id              ← which journey definition this instance follows
```

```
application_step
  application_id
  step_code               PAN | KRA | PERSONAL | BANK | SIGNATURE | SELFIE
                          | SEGMENT | DOCUMENTS | ESIGN | VERIFIED
  entered_at, completed_at, outcome, actor_id
```

→ This is essentially `kyc_journeys` + `kyc_journey_progress`, which already
exist and are already correct. The changes are: `type` widens beyond KYC to cover
the partner and reactivation journeys the audit found hiding in the stage enum;
`version_id` is added; and `leads.kyc_status` is deleted rather than mirrored.

### Account — what a client code actually means

```
account
  id, party_id
  client_code                                  ← also mirrored into party_identifier
  sales_org, depository, dp_id, ddpi
  opened_at, closed_at
  status                  active | dormant | closed
account_segment
  account_id
  segment                 equity | derivatives | commodity | currency | mf | gi
  activated_at, deactivated_at
```

→ New. Replaces the single `leads.client_code` and the audit's
`mx_Segment_Activation*` sprawl. Holdings and ledger balance are deliberately
**not** here — they belong to the back office and should be a read-model, as
Part 7 itself suggests.

### ProductInterest — the deal grain (was `product_cards`)

```
product_interest
  id, party_id, product_id
  state                   EXPLORING | WARM | RM_ENGAGED | KYC_IN_PROGRESS
                          | ACTIVE | ON_HOLD | LOST
  → INACTIVE is no longer a stored state; absence means inactive
  value, expected_close_at, win_loss_reason
  owner_id, product_rm_id, contact_flag
  entered_state_at
```

State transitions keep the existing `card_audit` pattern, renamed
`product_interest_history` and folded into the generic field history below.

### Case and ProcessInstance

`tickets` becomes `case` (category, priority, SLA, resolution) — already correct,
already has SLA pause/breach. `ProcessInstance` covers the audit's guided agent
scripts (Part 3.5: all 10 legacy processes are agent-invoked call scripts, a
genuinely different feature from background automation). Not built yet.

### Interaction — one timeline (already correct, needs tidying)

```
interaction                                    ← was `activities`
  id
  party_id                                     ← the one required link
  application_id?, product_interest_id?, case_id?, process_instance_id?
  channel                 call | whatsapp | sms | email | meeting | chat | app_event
  direction, occurred_at, duration_s
  disposition_code, sub_disposition_code       ← FK to the disposition matrix
  reason, sentiment, notes
  actor_user_id                                ← never a shared login
  vendor_ref              JSON {provider, external_id, recording_url}
```

→ Two changes from today: `external_id` and `recording_url` move into
`vendor_ref` (gap-analysis 3.4), and `leads.wa_last_inbound_at` is deleted —
the 24-hour WhatsApp window is derived from the last inbound interaction.

### Task / WorkItem, Reminder — already built, keep

`tasks` (kind, due_at, assignee, SLA, queue) and `reminders` (channel, due_at,
status, escalation) are as built two days ago and match Part 7's `Task/WorkItem`.
Add `queue_id` so shared work is a queue authenticated users pull from, per
Finding 7 — rather than a shared login, which we never had.

---

## Cross-cutting

### Condition tree — one shared shape

```
{ op: 'AND' | 'OR',
  children: [ {field, operator, value} | {op, children: [...]} ] }
```

Used identically by segments, automation rules, assignment rules and list views.
Replaces the flat `[{field, op, value, join}]` in `rules` and the AND-only
evaluator in `engine/assignment.js`. This is gap-analysis 1.3 and the direct
answer to the 4,810 lists.

### Segment — a saved query, with no membership table

```
segment
  id, name, description, owner_id, sales_org
  definition              JSON condition tree
  is_dynamic              true = always live
  snapshot_ttl_hours      only for campaign sends
  last_evaluated_at, last_count
```

→ `lead_list_members` is deleted. A point-in-time snapshot is written only when a
campaign sends, and carries the reason and a TTL.

### Field history — first class

```
field_history
  entity_type, entity_id, field, old_value, new_value
  actor_user_id, source            ui | api | automation | import | vendor
  at
```

Written by one choke point in the data layer, not by callers. Stage entry/exit
becomes a query over this, and the stamped columns
(`assigned_at`, `first_response_at`, `next_follow_up_at`, `aum_as_of`) are
deleted once it exists. Finding 4; kills six legacy automations.

### Consent — append-only

```
consent_event
  party_id, channel       call | email | sms | whatsapp | tracking
  state                   opted_in | opted_out | dnd_registry
  source, evidence_ref, at, actor_user_id
```

Current state = latest row per (party, channel). Answers "what was their consent
on 14 March, and who changed it".

### Versioning

`definition_version(artefact_type, artefact_id, version, body, published_at,
published_by, is_current)` for automation rules, disposition matrices, journey
definitions, forms and templates. In-flight records keep the version they
started under. Finding 10.

### Computed projections, never stamped

`party_metrics(party_id, computed_at, connect_rate, days_since_contact,
products_held, untapped_products, open_cases, aum)` — a rebuildable materialised
view. Nothing writes to it incrementally. Findings 3 and 4; gap-analysis 1.2.

---

## Indexes and constraints worth stating now

- `party_identifier`: unique blind index on PAN — the dedupe key, and the audit's
  Common Client Master check depends on it.
- `interaction(party_id, occurred_at DESC)` — the timeline query, hottest read.
- `interaction(vendor_ref->>'external_id')` — webhook de-duplication; vendors
  redeliver.
- `product_interest(party_id, product_id)` unique; `(state, owner_id)` for boards.
- `task(assignee_id, status, due_at)` — the follow-up board.
- `reminder(status, due_at)` — the sweep. Already present.
- Every org-scoped table carries `sales_org` with an index. Already present.
- Foreign keys on, cascade only where a child cannot outlive its parent
  (`application_step`, `account_segment`); `SET NULL` for ownership.

---

## Migration posture

Not written yet — it needs the data-quality profile (Part 9, item 1). Two things
already clear from the audit:

- The 338 lead fields cannot be mapped on declared type. 113 Text + 82 Dropdown
  against 2 Booleans means flags are free text and will contain
  `Yes/YES/Y/1/true`. Profile distinct values per column before mapping anything.
- `mx_Disposition_Notes_Remarks` and its `|`-concatenated siblings should migrate
  as an opaque legacy blob attached to the party, clearly labelled, not parsed
  into interactions. Splitting them would fabricate attribution and timestamps
  that do not exist.

---
---

# Revision 2 — the metadata layer

**Added:** 22 Aug 2026, after the Salesforce design reference.
Part 8 of that document supersedes Part 7 of the LeadSquared audit; this section
supersedes everything above where they conflict.

The entity model above stands. What changes is that entities and fields stop
being SQL tables written by hand and become **rows in a metadata layer** — which
is Part 1 item 1 of the Salesforce reference, and the thing that makes the other
constraints cheap instead of impossible.

## The metadata core

```
entity_def
  api_name          TEXT PK        immutable, integrations bind to this
  label, label_plural              user-facing, freely renameable
  description
  is_custom
  owner_type        user | user_or_queue | none
  features          JSON { history, activities, search, record_types, approvals }
  sales_org         null = shared across both businesses

field_def
  id
  entity            → entity_def.api_name
  api_name          immutable. `mx_Subscription_End_dtae` cannot happen twice.
  label                                    ← renameable, never load-bearing
  type              see palette below
  precision         JSON { length } | { precision, scale }
  required, unique, external_id, indexed
  default_value, help_text, description
  controlling_field → field_def.id         ← cascading picklists, enforced at API
  formula           expression, when type = formula
  rollup            JSON { child_entity, fk, agg: SUM|COUNT|MIN|MAX, filter }
  encrypted         BOOLEAN                ← a schema decision, not a call site
  history_tracked   BOOLEAN
  retire_at         DATE                   ← the governance gate, in the schema

picklist_value
  field_id, value, label, sort_order, active,
  controlling_value                        ← which parent value permits this child

record_type
  entity, api_name, label, active
  picklist_subsets  JSON { field_api_name: [allowed values] }
  layout_id, process_id

layout                                     ← ONE composition model, not two
  entity, record_type, profile
  kind              compact | full | list
  definition        JSON sections/components

validation_rule
  entity, api_name, condition_tree, message, active, priority
```

### The field type palette

Derived: `auto_number` · **`formula`** · **`rollup`**
Relationship: `lookup(entity)` · `polymorphic_lookup(entity[])`
Primitive: `checkbox` · `currency(16,2)` · `date` · `datetime` · `email` ·
`number(p,s)` · `percent` · `phone` · `picklist` · `multipicklist` · `text(n)` ·
`textarea` · `richtext` · **`encrypted_text`** · `time` · `url`
Compound: `address` · `person_name`

Three of these are load-bearing:

- **`formula` and `rollup`** delete a category of automation. `engine/metrics.js`
  already computes score and AUM correctly; it becomes the evaluator behind these
  types rather than a module anyone has to call.
- **`encrypted_text`** makes PAN, bank account and BOID a schema decision. Today
  `encryptField()` is called at each site that touches PAN, which means a new
  route can forget. A field declared encrypted cannot be read in the clear by a
  route that forgot.
- **`address`** replaces the legacy tenant's six unrelated text columns.

### What I am deliberately not copying

- **No `__c` suffix.** Label/API separation yes; encoding "custom" into the name
  is Salesforce's own debt, and Part 7 item 2 warns against inheriting exactly
  this. `is_custom` is a column.
- **One layout model, not two.** Page Layouts *and* Lightning Record Pages is
  historical duality (Part 7 item 3). `layout.kind` covers compact, full and list.
- **One permission construct.** Profiles + Permission Sets + Permission Set Groups
  exists because Profiles came first (Part 7 item 2). Roles + additive permission
  sets, already built, is the cardinality discipline without the third artefact.
- **Fifteen entities, not five hundred.** Part 7 item 1.

## Access: the floor that is missing

The grant-only model is built and right. Beneath it belongs an OWD floor:

```
org_wide_default
  entity, audience  internal | external
  level             private | read | read_write | read_write_transfer
                    | controlled_by_parent
```

Two details worth taking exactly as they are:

- **Internal and external are separate columns.** Bonanza's partners and APs need
  a different baseline from employees, declared once rather than inferred.
- **`transfer` is a right distinct from read/write.** That is the "can see" versus
  "manages" split — the same distinction the legacy Sales Groups fudge with
  twelve managers and one user.

And **`Activity` is Private in the reference org while Lead and Opportunity are
public** — interaction history treated as more sensitive than the record itself.
For a broker holding call recordings, that deserves a deliberate answer rather
than a default.

## Owner becomes polymorphic

```
owner_ref  { type: 'user' | 'queue', id }

queue
  api_name, label, entity, sales_org
  members       users who may pull from it
  routing       manual | round_robin | least_loaded
```

This is the structural fix for the six shared logins in the legacy tenant. A
queue owns the record; individually-authenticated people pull from it; attribution
survives.

## Migration posture for the metadata move

The engines survive; the substrate is rewritten. Concretely, the existing tables
become the *physical* storage for entities whose definitions now live in
`entity_def` and `field_def` — so `leads` keeps its columns, and a new custom
field lands in an adjacent `field_value` store rather than an `ALTER TABLE`.

That hybrid is deliberate and worth arguing about: fully generic storage
(everything in `field_value`) is the purest expression of the idea and the
slowest to query. Which way to go is the first question below.

---

# Revision 3 — the metadata layer, as built

Shipped 22 Aug 2026. `server/src/engine/metadata.js`, schema in `server/src/db.js`,
routes in `server/src/routes/setup.js`, 33 tests in `server/test/metadata.test.mjs`.

## Storage — hybrid, and where the line falls

| | Core fields | Custom fields |
|---|---|---|
| Where | Real columns on `leads`, `activities`, `partners`, … | Rows in `field_value` |
| `field_def.storage` | `column` | `value` |
| Cost | Indexed, no join | One join per record |
| Who creates them | Developers, via migration | Administrators, via Setup |
| Registered in metadata? | **Yes** — same configuration surfaces | Yes |

57 core fields across six entities are registered. They gain every configuration
surface — rename, help text, required, history tracking, field-level security —
without giving up their columns. That is the whole point of the hybrid: the
fields 495,118 rows are filtered by stay fast, and everything is configurable.

Derived fields (`formula`, `rollup`, `auto_number`) declare `storage = 'derived'`
and are never written. `setCustomValues()` silently ignores a write to one — a
test asserts this, because automation that tries to maintain a computed field is
precisely the failure mode being designed out.

## Tables

| Table | Holds | Note |
|---|---|---|
| `entity_def` | Objects | `api_name` PK, immutable; `label`/`label_plural` renameable |
| `field_def` | Fields | 31 columns; `UNIQUE (entity, api_name)` |
| `picklist_value` | Values | `controlling_value` carries the cascade |
| `field_value` | Custom values | Typed columns — `text/num/date/bool` — not one blob |
| `field_history` | Every tracked change | `source` records ui/api/automation/import/vendor |
| `config_audit` | Schema changes | Separate from the data audit log, deliberately |

## Field-type palette

23 types. Three groups matter architecturally:

- **Derived** — `formula`, `rollup`, `auto_number`. Non-negotiable 3: computed
  fields are schema, not automation.
- **Sensitive** — `encrypted_text` sets `encrypted = 1` regardless of what the
  caller passed. A route that forgets to encrypt cannot leak a field declared
  encrypted.
- **Compound** — `address` stores five parts under one field, replacing the
  legacy tenant's six unrelated address columns.

## Field-level security

`field_def.read_scope` takes three values, and this is what makes the interaction
decision expressible:

| Scope | Who reads the value | Used by |
|---|---|---|
| `record` | anyone who can read the record | everything by default |
| `owner_or_manager` | the owner, their management chain, or a capability holder | `interaction.body`, `.reason`, `.recording_url` |
| `capability` | only holders of the named capability | `lead.pan`, `partner.pan`, `partner.bank_account` |

`applyFieldSecurity()` nulls what the reader may not see and names it in
`_restricted`, so the UI can say **"notes hidden"** rather than showing an empty
box. Silence and absence must not look the same — and the converse holds too: a
call with no recording does not claim one is being withheld.

Row-level security cannot express this. Hiding the interaction to protect the
note would also hide that the call happened, and coverage reporting would go
dark. Wired into four read paths: the lead timeline, the activity feed, the
activities list, and the partner timeline.

Ownership does **not** grant a `capability`-scoped field. An RM who owns a lead
still cannot read its PAN without `pii.unmask` — tested explicitly, because
"it's my lead" is the intuitive wrong answer.

## Stage duration is derived

`stageDurations()` reads `field_history` and returns entry, exit and days per
stage. Six legacy automations exist only to stamp dates into `mx_` fields for
this. They are now one query, and the current stage correctly reports
`exited_at: null` rather than pretending to have ended.

## Governance, at creation time

`POST /setup/objects/:entity/fields` refuses a field with no stated `purpose` and
defaults `owner_user_id` to its creator. It also warns — does not block — on a
near-duplicate label: *"Lead already has 'Referral Code'. Is this the same thing
under another name?"*

`GET /setup/field-usage/:entity` gives fill rate, owner and purpose per field,
plus `unused` and `unowned` lists. The legacy tenant has 289 custom fields, 8+
duplicate pairs and four test fields in production because it can produce none of
this.

## What is frozen after creation

`api_name`, `type`, `storage` and `entity`. A PATCH attempting any of them returns
400 with the reason: integrations bind to the API name and stored values match
the type. The remedy offered is deactivate-and-replace.

Fields are never deleted — `active = 0`, and the response states how many stored
values were retained. A deleted field takes its data with it and leaves every
report that referenced it silently wrong.

## New capability

`admin.objects` — "Configure objects & fields", held by `superadmin` and `admin`.
Distinct from `admin.users` and `admin.system` because a field added here changes
what every screen and every integration sees.
