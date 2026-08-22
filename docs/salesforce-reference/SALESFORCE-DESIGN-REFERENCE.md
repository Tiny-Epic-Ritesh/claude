# Salesforce as Design Reference for the New CRM

**Source org:** `mindful-moose-72ar4m-dev-ed` — Salesforce Trailhead Developer Edition
**Audited:** 21 Aug 2026, as System Administrator (Ritesh Thakur)
**Release:** Summer '26
**Purpose:** A *target-state* design reference. Companion to the LeadSquared audit,
which documents the *current* state and its failures.

---

## HOW TO USE THIS DOCUMENT — AND WHAT IT IS NOT

There are now two reference documents for this project, and they play opposite roles:

| Document | Role | What it tells you |
|---|---|---|
| `leadsquared-audit/LEADSQUARED-CRM-REFERENCE.md` | **Current state** | What Bigul actually runs today, at real scale (495,118 leads, 338 fields, 35 pipelines, 51 automations), and the ten structural failures to avoid repeating |
| **this document** | **Target patterns** | How a mature CRM platform solves those same problems |

**Read Part 6 first if you only read one section** — it maps each LeadSquared
failure to the Salesforce pattern that solves it. That mapping is the actual
design brief.

### Important caveat about this source
This is a **vanilla Trailhead Developer Org with sample data**. It is *not* a
real-world configured implementation. So:

- ✅ **Trust it for**: platform architecture, the field type system, the security
  layer model, per-object configuration surfaces, UI composition patterns,
  automation tooling structure. These are Salesforce's design decisions and they
  are what we want to learn from.
- ❌ **Do NOT trust it for**: how a broking business should configure a CRM, what
  fields Bigul needs, what pipelines should exist. The sample data is generic
  ("Bertha Boxer", "Farmers Coop. of Florida"). Business requirements come from
  the LeadSquared audit and from stakeholder interviews, never from here.

### Provenance marking
Throughout the companion files: **✅** = read directly from the org in this session.
**▫** = standard platform behaviour, surface confirmed but semantics not
individually exercised. Where something is marked ▫ and the design depends on the
exact semantics, verify against Salesforce documentation before building.

---

## PART 1 — THE SIX IDEAS THAT MATTER MOST

If the new CRM adopts only six things from Salesforce, make them these.

### 1. Every object gets the SAME configuration contract
Object Manager exposes **19 identical configuration surfaces** for every object,
standard or custom ✅:

`Details · Fields & Relationships · Page Layouts · Lightning Record Pages ·
Buttons, Links, and Actions · Compact Layouts · Field Sets · Object Limits ·
Record Types · Related Lookup Filters · Search Layouts · List View Button Layout ·
Scoping Rules · Object Access · Field Access · Triggers · Flow Triggers ·
Validation Rules · Conditional Field Formatting`

**Why it matters:** an admin who learns one object can configure any object, and
you build the configuration UI *once, generically*. LeadSquared has a different
config surface for Leads, Opportunities, Activities and Custom Objects — four
mental models, four UIs, four sets of gaps.

**Build implication:** design the metadata layer first. Entity definition,
field definition, layout definition, permission definition — all generic, all
applying uniformly. Then "Lead" and "Deal" are just rows in that metadata.

### 2. Derived values are a FIELD TYPE, not an automation job
The field type palette includes **Formula** and **Roll-Up Summary** as
first-class types ✅ — read-only fields that recompute when their sources change.

**Why it matters:** LeadSquared's two busiest automations are
`Add Activity on Opportunity as per Lead` (14.1M lifetime triggers) and
`Activity Score` (8.0M). Both exist only because the platform has no computed
fields. Every `mx_*_Count`, `mx_*_Attempts`, `mx_Total_Connects_and_Attempts`
is a stored number that automation must keep correct — and inevitably won't.

**Build implication:** Formula fields and rollup aggregates in the schema layer.
This deletes an entire category of automation and an entire category of bug.

### 3. Label ≠ API name
Every field has a **Field Label** (user-facing, freely renameable) and an
immutable **API Name** with a `__c` suffix for custom fields ✅.

**Why it matters:** LeadSquared bakes typos in permanently —
`mx_Subscription_End_dtae`, `mx_Presales_Initial_Margin_Commitmnt`. Schema names
are immutable there, so a naming mistake is forever. Salesforce decouples the two,
plus offers **Rename Tabs and Labels** to rename standard objects org-wide ✅.

**Build implication:** two identifiers per field and per entity, from day one.
Business users own the label; integrations bind to the API name.

### 4. Access = one floor, then only grants
Five layers resolving in a defined order ✅:

```
OWD (the floor, per object, internal + external separately)
  → Role Hierarchy (managers inherit downward)
    → Sharing Rules (owner-based or criteria-based)
      → Manual Sharing / Teams
        → Profiles + Permission Sets (what you can DO)
```

**The rule that makes it debuggable: OWD restricts; every other layer can only
GRANT.** So "why can this person see this record?" always has a traceable answer.

Plus: **one Profile per user, many Permission Sets** — a clear cardinality rule.
Permission Set Groups add composition *and* muting, without a sixth mechanism.

**Why it matters:** LeadSquared layers Role + Permission Template + Team +
Sales Group with no stated precedence and no screen that answers "what can this
person actually see?". Effective access is emergent, which means unknowable.

### 5. Queues are an ownership target, not a login
`Lead.OwnerId` is typed `Lookup(User,Group)` ✅ — polymorphic. A record can be
owned by a **Queue**; individually-authenticated users pull work from it.
Assignment rules explicitly target "users or queues" ✅.

**Why it matters:** this is the exact fix for LeadSquared's shared logins
(`bigulcaller17`, `BigulCaller11`, `Presales Common Id`, `Biguldealer5@…`), which
today destroy attribution, make offboarding impossible, and render per-agent
performance data meaningless.

**Build implication:** Queue as a first-class entity; polymorphic owner reference;
never a shared credential.

### 6. Record Types collapse pipeline sprawl
One object serves many business lines by binding, per Record Type ▫:
a picklist value subset + a page layout + a business process (ordered stage set),
assigned per profile. `Record Types`, `Lead Processes` and `Sales Processes` are
all present in Setup ✅.

**Why it matters:** LeadSquared has **35 Opportunity types** because a new
business line means a new pipeline object. Reporting across them is impossible;
"All Opportunities" exists as a 36th type just to aggregate.

**Build implication:** for Bigul — ONE `Deal` entity with record types for Equity,
MF, Global Investments, Partner, Algo. Unified reporting, specific UX.

---

## PART 2 — DATA MODEL PATTERNS

### The core CRM object graph ✅
Verified from Object Manager and OWD settings:

```
Lead ──(Convert)──► Account ──< Contact
                       │           │
                       ├──< Opportunity ──< OpportunityLineItem ──► Product
                       │        │                                      │
                       │        └──► Pricebook ──< PricebookEntry ──────┘
                       ├──< Case
                       ├──< Contract ──< Order
                       ├──< Asset
                       └──< Activity (Task | Event)

Campaign ──< CampaignMember ──► Lead | Contact
Individual  (privacy/consent entity, links to Lead/Contact)
```

**Two patterns to steal:**

**(a) Lead → Account + Contact + Opportunity conversion** ✅
A single `Convert` action on the record page transforms a Lead into three records
in one transaction. Governed by explicit settings ✅:
- Require Validation for Converted Leads
- Preserve Lead Status
- Hide Opportunity Section of Convert Lead Window
- Select "Don't create an opportunity" by Default
- Create a Task During Lead Conversion when Subject is Blank

> This is a *modelled state transition*, not a status value that implies one.
> Bigul's "Lead becomes Customer" journey needs exactly this — today it's a
> stage value (`CUSTOMER`) with ~15 `mx_` fields trying to describe what happened.

**(b) `Individual`** ✅ — a separate object carrying privacy/consent, related to
Lead and Contact. Consent is modelled once for a *person*, not duplicated per
record. Relevant for SEBI/DPDP compliance where consent must survive the
lead-to-customer transition.

### Field type system ✅ (complete palette, verified)

**Derived:** Auto Number · Formula · Roll-Up Summary
**Relationship:** Lookup Relationship · External Lookup Relationship (+ Master-Detail on custom objects)
**Primitive:** Checkbox · Currency · Date · Date/Time · Email · Geolocation ·
Number · Percent · Phone · Picklist · Picklist (Multi-Select) · Text · Text Area ·
Text Area (Long, 131,072) · Text Area (Rich) · **Text (Encrypted)** · Time · URL
**Compound (standard only):** Name (Salutation+First+Last) · Address · Geolocation

Precision is part of the declared type: `Currency(16,2)`, `Text(120)`, `Percent(3,0)`.
Relationships are typed: `Lookup(Account)`, `Lookup(User,Group)`.

**Field properties beyond type:** Label, API Name, Required, Unique, External ID,
Default Value, Help Text, Description, **Controlling Field** (dependent picklists),
**Indexed** (surfaced to the admin), Field History Tracking.

> **Text (Encrypted) as a native type** matters for a broking CRM holding PAN,
> bank details and BOID. Encryption becomes a schema decision, not an
> application-layer afterthought.

> **Compound Address** replaces LeadSquared's six unrelated text fields
> (`mx_Street1`, `mx_Street2`, `mx_City`, `mx_State`, `mx_Country`, `mx_Zip`).

### Scale discipline ✅
A standard Opportunity ships with **~26 fields**. A standard Lead with ~30.
Compare LeadSquared's Lead at **338**.

The difference is not a technical limit — it is a governance culture. The platform
gives a deliberately small, well-chosen core and expects extension through a
gated process.

**Build implication:** a field-creation gate — naming convention check, duplicate
detection, required owner, stated purpose, review date. LeadSquared's 289 custom
fields with 8+ duplicate pairs and 4 test fields in production is what happens
without one.

---

## PART 3 — SECURITY MODEL (see `security-model.md` for full detail)

### Organization-Wide Defaults, as actually set in this org ✅

| Object | Internal | External |
|---|---|---|
| Lead | Public Read/Write/Transfer | Private |
| Account and Contract | Public Read/Write | Private |
| Contact | **Controlled by Parent** | Controlled by Parent |
| Opportunity | Public Read/Write | Private |
| Case | Public Read/Write/Transfer | Private |
| Campaign | Public Full Access | Private |
| Campaign Member | **Controlled by Campaign** | Controlled by Campaign |
| **Activity** | **Private** | Private |
| User | Public Read Only | Private |
| *(everything else)* | Private | Private |

Three design decisions worth copying:

1. **Internal and External access are separate columns.** Partners and portal
   users get a different baseline, declared once. Directly relevant: Bigul has
   partners/APs (`Bigul Partner`, `Activate B2B Partners`) who need a genuinely
   different floor than employees.
2. **`Controlled by Parent`** — child objects inherit access rather than
   redeclaring it. Avoids re-implementing access logic per child entity.
3. **`Transfer` is a right distinct from Read/Write.** Reassigning ownership is
   its own permission — exactly the "can see" vs "manages" distinction that
   LeadSquared's Sales Groups fudge (Bigul Dealer Team: 12 managers, 1 user).
4. **Activity is Private while Lead/Opportunity are public.** Interaction history
   is treated as *more* sensitive than the record. Worth a deliberate decision
   for Bigul, where call recordings and notes are involved.

### Constructs and their cardinality ✅

| Construct | Per user | Job |
|---|---|---|
| Profile | exactly 1 | Baseline: object CRUD, FLS, tabs, apps, login policy |
| Permission Set | many | Additive grants. Never subtracts. |
| Permission Set Group | many | Bundle of permission sets, **with muting** |
| Role | exactly 1 | Record visibility via hierarchy |
| Public Group | many | A *target* for sharing rules |
| Queue | many | An *ownership target* |

### Tooling that answers "who can see what?" ✅
- **Field Accessibility** — computed field visibility across profiles
- **View Setup Audit Trail** — every config change, with who and when
- **Delegated Administration** — scoped admin rights without full admin
- **Health Check** — security posture score against a baseline

> `View Setup Audit Trail` deserves emphasis. LeadSquared has no config change
> log, which is *why* its admins encode deploy dates into automation names
> (`Vcard Send When lead Stage Change As RTT 22April2025`). Give the new CRM a
> config audit log and that whole naming pathology disappears.

---

## PART 4 — UI COMPOSITION (see `ui-layer.md` for full detail)

### The layout separation ✅
Four independently-assignable concerns, each per profile **and** per record type:

| Concept | Controls |
|---|---|
| **Compact Layout** | The 4-5 fields in the highlights strip and mobile cards |
| **Page Layout** | Field arrangement, sections, related lists, buttons |
| **Lightning Record Page** | Which *components* appear where |
| **Search Layout** | Columns in search results, lookups, list views |

Plus **Field Sets** — named reusable field groupings addressable from code.

### Record page anatomy ✅ (verified on a live Lead record)

```
┌─ Highlights Panel ────────────────────────────────────────────┐
│ [icon] Lead / Ms. Bertha Boxer      [Follow][Convert][Edit][▾]│
│ Title · Company · Phone (2)▾ · Email       ← Compact Layout   │
├─ Path ────────────────────────────────────────────────────────┤
│ Open-Not Contacted › Working-Contacted › Closed › Converted    │
│                                    [Mark Status as Complete]   │
├──────────────────────────────┬────────────────────────────────┤
│ Tabs: Activity | Details |   │  Related                       │
│       Chatter                │  • Duplicate detection callout │
│  ┌ Activity composer ─────┐  │  • Campaign History (0)        │
│  │ Log a Call▾ New Task▾  │  │                                │
│  │ New Event▾  Email▾     │  │                                │
│  └────────────────────────┘  │                                │
│  Activity Timeline           │                                │
│  Filters: All time • All …   │                                │
└──────────────────────────────┴────────────────────────────────┘
[ Utility bar: To Do List ]                          ← persistent
```

**The Path component is the highest-value UI pattern for Bigul** ✅. It turns a
status picklist into a visible, guided journey with an explicit next action, and
supports per-step key fields and guidance text. Compare LeadSquared's 32-value
flat stage dropdown with no journey visualisation at all.

### List views as first-class objects ✅
A List View has its own name, filters, columns, chart, sharing scope, and display
mode (Table / Kanban / Split View), plus inline edit and per-view search.

> **This is the fix for the 4,810-list problem.** LeadSquared users export CSVs
> and re-import them as static lists because its Advanced Search only supports a
> flat Any/All across criteria rows. A live, shareable, permissioned saved view
> removes the reason to leave the product.

### Apps as personas ✅
An App = a named, branded bundle of tabs with its own nav. Users switch via App
Launcher; they can personalise their own nav within an app.

> Bigul's personas — presales, dealer, post-sales, partner RM, B2B, customer
> success — map directly onto Apps. Better than one giant menu with permission-based
> hiding.

---

## PART 5 — AUTOMATION (see `automation.md` for full detail)

### One engine, visible legacy, shipped migration path ✅
Flows (current) · Process Builder + Workflow Rules (legacy, visibly retained) ·
**Migrate to Flow** (a shipped migration tool) · **Flow Trigger Explorer**
(see everything that fires on an object) · **Paused And Failed Flow Interviews**
(a monitoring queue for broken runs).

### Assignment rules — verified platform text ✅
> "You can create multiple rules with different conditions, but **only one rule
> can be active at a time**."

One active rule containing *ordered entries*. Ordering is explicit and internal
to a single artefact, so it cannot race with itself.

> **This is the structural fix for LeadSquared's live race condition** — three
> "Lead Updated" automations firing on overlapping populations with undefined order.

### Duplicate management surfaced where it lands ✅
The Lead record page itself displays:
> "We found no potential duplicates of this Lead. **No duplicate rules are
> activated.** Activate duplicate rules to identify potential duplicate records."

**Design principle: surface unconfigured safety features at the point of
consequence, not buried in settings.** LeadSquared has zero dependent-field
relationships configured and nothing anywhere says so.

### Monitoring ✅
System Overview · Imports · Outbound Messages · Time-Based Automations ·
Automated Process Actions · Case Escalations · API Usage Notifications ·
Mass Emails · Jobs · Logs · Paused And Failed Flow Interviews.

> Build the automation failure queue from day one. LeadSquared's
> `Cube lead call dispose API` runs 27,000 calls/week with 17 errors and nothing
> surfaces it.

---

## PART 6 — THE MAPPING: LEADSQUARED PROBLEM → SALESFORCE PATTERN

**This is the core of the document.** Each row is a real, documented failure in
Bigul's production system, matched to the platform pattern that solves it.

| # | LeadSquared problem (from audit) | Salesforce pattern | Build implication |
|---|---|---|---|
| **1** | "Lead Stage" = 4 concepts in one 32-value enum (KYC progress + lifecycle + disqualification + partner journey) | **Record Types** binding a picklist subset + layout + business process, per profile. Plus separate objects for separate concepts. | Split into `lifecycle_stage` + `Application` child entity + `disqualification_reason` + concurrent `party_roles`. Use record types for business-line variants. |
| **2** | Opportunity used as generic work item — 35 pipelines mixing deals, support cases, segments, processes | **Distinct objects**: Opportunity / Case / Campaign+CampaignMember / (process object). One Opportunity object with **Record Types** per business line. | Four entities: `Deal`, `Case`, `Segment` (computed), `ProcessInstance`. Record types replace pipeline sprawl. |
| **3** | 14.1M-trigger automation mirroring activity from Lead to Opportunity | **Shared Activity model** — Task/Event relate polymorphically via `WhoId`/`WhatId`. No mirroring needed. | ONE `Interaction` entity referenced by all parent types. Never copy activity between records. |
| **4** | 6 automations exist purely to stamp timestamps (no field history) | **Field History Tracking** (per field, per object) + **View Setup Audit Trail** | First-class, queryable field-change history and stage entry/exit timestamps. Deletes ~6 automations and ~15 fields. |
| **5** | 3 automations write same fields, same trigger, undefined order → live race condition | **"Only one rule can be active at a time"** with ordered entries. Plus **Flow Trigger Explorer**. | Explicit rule priority; static conflict detection; a per-object "what runs when" view. |
| **6** | Notes concatenated into one text field with `\|` separators, no attribution or timestamps | **Activity Timeline** — each interaction is its own record with actor, timestamp, type, and body | Notes/outcomes attach to the interaction record. Never append to a parent text field. |
| **7** | Shared logins destroy attribution (`bigulcaller17`, `Presales Common Id`) | **Queue as ownership target** — `OwnerId` is `Lookup(User,Group)`; assignment rules target users *or* queues | Polymorphic owner; Queue entity; SSO; one identity per human. |
| **8** | 4,810 lists (CSV export → Excel → static re-import) because search is flat AND/OR only | **List Views** as first-class shareable objects + **Reports** with nested filter logic | Nested boolean query builder; live saved segments; list ownership + TTL. |
| **9** | Zero dependent picklists configured despite obvious parent/child fields | **Controlling Field** is a column in the field list; **Field Dependencies** is a toolbar action | Cascading picklists enforced at the **API** layer. Make unconfigured state visible. |
| **10** | No versioning → "- Clone" automations and date-stamped names | **Flow versioning** (activate one version, keep history) + **Migrate to Flow** for engine changes | Versioned, diffable automation and form definitions with an explicit "current" pointer. |
| **+** | 338 lead fields, 8+ duplicate pairs, permanent typos, 4 test fields live | **Label ≠ API name**; `__c` suffix contract; small standard core (~26 fields) | Two identifiers per field; field-creation governance gate. |
| **+** | Vendor names baked into entity types (Zoom Meeting, Kaleyra send SMS, Zipteams Notes) | Standard **Task/Event** with type + channel attributes; integrations write to the same objects | Model the event, not the vendor. `Interaction{channel, vendor_ref{}}`. |
| **+** | Workforce management (check-in, leave, shifts) bundled into CRM | Salesforce keeps this **out** of core CRM | Explicit decision: HRMS integration vs in-CRM. Don't let it default. |
| **+** | No approval concept anywhere | **Approval Processes** with entry criteria, approver hierarchy, record locking | Scope approvals for account closure, fee waivers, partner onboarding. |
| **+** | No config change log | **View Setup Audit Trail** | Config audit log from day one — it removes the date-stamped-naming pathology. |
| **+** | Consent fields scattered on the Lead record | **`Individual`** object holding privacy/consent, related to Lead and Contact | Model consent once per *person*, surviving lead→customer transition. |

---

## PART 7 — WHAT NOT TO COPY

Being a design reference does not mean copying everything. Deliberate non-goals:

1. **Do not copy the object count.** This org exposes 500+ standard objects, most
   of which are platform infrastructure (`ApiAnomalyEventStore`,
   `DevopsActivityLog`, `WorkPlanTemplate`). Bigul needs perhaps 15 entities.
2. **Do not copy Salesforce's legacy layering.** Profiles + Permission Sets +
   Permission Set Groups exists partly because Profiles came first and cannot be
   removed. A greenfield build should design *one* permission construct with
   composition, not three. Take the *cardinality discipline*, not the artefact count.
3. **Do not copy Page Layouts AND Lightning Record Pages.** That duality is also
   historical debt. Pick one composition model.
4. **Do not copy the Setup tree depth.** 15 top-level categories with 4 levels of
   nesting is only navigable because Quick Find exists. Build search-first admin.
5. **Do not copy governor limits.** Those are multi-tenant constraints, not design
   goals.
6. **Do not copy the sample data or the standard field sets literally.**
   `Main Competitor(s)`, `Current Generator(s)`, `Tracking Number` are artefacts
   of Salesforce's original market. Bigul's fields come from the LeadSquared audit.

---

## PART 8 — SUGGESTED TARGET ENTITY MODEL (revised)

This supersedes Part 7 of the LeadSquared reference by adding the Salesforce
patterns. Still a hypothesis to argue with, not a spec.

```
Party  (person or organisation)              ← "Individual"-style consent holder
├── identifiers: pan, boid, client_codes[]   ← child entity, not 6 columns
├── roles[]: Prospect|Customer|Partner|Employee   ← concurrent
├── lifecycle_stage: small stable enum
├── consent{}  ← modelled once per person, survives conversion
└── computed: score, rfm{}, engagement       ← FORMULA / ROLLUP, never stamped

Application  (was: 16 KYC stages + ~15 mx_ status fields)
├── record_type: Equity|MF|Partner|Reactivation|Shifting|GI
├── status + per-step timestamps             ← FIELD HISTORY, not automation
└── many per Party, concurrent

Account  (was: mx_Client_Code_1..6)
└── client_code, depository, segments_active[], activated_at per segment

Deal          ← ONE object, RECORD TYPES per business line (not 35 pipelines)
├── record_type: Equity|MF|GlobalInv|Partner|Algo
├── pipeline stage (subset per record type), value, close_date, owner
└── win_loss_reason

Case          ← was 7 "C.S-*"/"*Support" opportunity types
└── category, priority, sla_due, resolution, owner(User|Queue)

ProcessInstance ← was Client Profiling, KYC Reactivation, Fund Collection, MF App
└── definition_version, current_step, step_outcomes[]

Interaction   ← ONE shared timeline. Kills the 14.1M-trigger mirroring automation
├── channel: call|whatsapp|sms|email|meeting|chat|app_event
├── direction, occurred_at, duration
├── outcome{disposition, sub_disposition}    ← CASCADING, validated at API
├── notes  ← per-interaction, attributed, timestamped
├── actor: User (never a shared login)
├── vendor_ref{provider, external_id}        ← vendor detail quarantined
└── links: party, application?, deal?, case?, process_instance?

Task / WorkItem
└── type, due_at, sla, queue, assignee, status, escalation_policy

Queue         ← ownership target; users pull from it. NOT a shared login.

Segment       ← computed membership, nested boolean query, NOT stored rows
```

**Platform capabilities required (each traceable to a Part 6 row):**
Formula + rollup field types · field-change history · label/API-name split ·
OWD + grant-only layering · polymorphic owner (User|Queue) · record types ·
one active rule with ordered entries · automation failure queue · config audit
trail · nested query builder · cascading picklists enforced at API ·
versioned automation definitions · encrypted field type · duplicate rules
surfaced at point of consequence.

---

## PART 9 — WHAT THIS AUDIT DID NOT COVER

Stated plainly so nothing reads as more complete than it is.

- **Flow Builder internals** — the canvas would not render in this environment.
  Flow element types, trigger types (record-triggered before/after save,
  scheduled, platform-event, screen, autolaunched) were **not** individually
  verified. Confirm against Salesforce docs before designing the rules engine.
- **Validation rule syntax and the formula language** — not exercised.
- **Approval Processes internals** — surface confirmed, steps not built.
- **Record Type configuration screens** — surface confirmed, semantics ▫.
- **Reports & Dashboards builder** — not audited. Worth a dedicated pass; it is
  the answer to LeadSquared's reporting gaps.
- **The full standard object list** — 500+, mostly infrastructure; not enumerated.
- **Per-object field lists beyond Lead and Opportunity.**
- **Einstein / AI features** — relevant to an "AI CRM" but not examined.
- **API and integration layer** (REST/Bulk/Streaming/Platform Events/Change Data
  Capture) — names confirmed in Setup ✅, mechanics not exercised.
- **Mobile app behaviour.**

### Recommended next passes, in priority order
1. **Reports & Dashboards** — the biggest unexamined area, and directly relevant
   to the LeadSquared reporting problems.
2. **Flow Builder** — element and trigger vocabulary for the rules engine design.
3. **Record Types + Page Layout assignment** — the mechanism Part 6 leans on most.
4. **Platform Events / Change Data Capture** — the integration event contract.

### Companion files
`setup-tree.md` · `object-anatomy.md` · `field-types.md` · `security-model.md` ·
`ui-layer.md` · `automation.md`
