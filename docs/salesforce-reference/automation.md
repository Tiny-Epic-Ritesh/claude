# Salesforce Automation & Process Layer

> **Provenance note:** items marked ✅ were read directly from this org.
> Items marked ▫ are standard platform behaviour not individually verified in
> this session — treat them as "confirm before relying on exact semantics".

## THE AUTOMATION TOOL LADDER (Setup > Process Automation) ✅

Read from the Setup tree:
- **Flows** ✅ — the current, strategic tool
- **Flow Trigger Explorer** ✅ — a dedicated view showing *what runs when* on an object
- **Approval Processes** ✅
- **Next Best Action** ✅
- **Paused And Failed Flow Interviews** ✅ — first-class error/suspension monitoring
- **Post Templates** ✅
- **Process Automation Settings** ✅
- **Automation App** ✅ — a Lightning app that is "your central hub for all
  Salesforce Automation", adding: search across automations, richer list-view
  sorting, **categories and subcategories**, an **Actions Hub**, low-code
  connectors, RPA, and document processing
- **Process Builder** ✅ *(legacy, retained)*
- **Workflow Rules** ✅ *(legacy, retained)*
- **Migrate to Flow** ✅ — a shipped migration tool from the legacy engines
- **Workflow Actions** ✅

### The single most important lesson here
Salesforce has three generations of automation engine. Rather than leaving them
all running silently, it:
1. names the current one clearly (Flow),
2. keeps legacy ones visible but marked,
3. **ships a migration tool** (`Migrate to Flow`),
4. and provides `Flow Trigger Explorer` so you can see everything that fires on
   an object in one place.

> LeadSquared's tenant has V3 and V4 of the same form both live, "- Clone"
> automations, and no way to see everything that touches a field. The new CRM
> needs (a) one automation engine, (b) a per-object "what runs when" explorer,
> and (c) an explicit deprecation + migration path when the engine changes.

## RULE TYPES BY OBJECT ✅

From the classic Setup nav:
- **Lead Assignment Rules** ✅ · **Case Assignment Rules** ✅
- **Lead Auto-Response Rules** ✅ · Case Auto-Response Rules
- **Escalation Rules** ✅
- **Lead Processes** / **Sales Processes** ✅ (record-type-bound stage subsets)
- **Validation Rules** ✅ (per object, incl. Task and Event)
- **Triggers** ✅ (Apex, per object)
- **Big Deal Alert** ✅ · **Update Reminders** ✅
- **Duplicate Management** ✅ (+ Duplicate Error Logs, Duplicate Record Sets)
- **Territory Management** ✅

### Assignment Rules — verified text from the org ✅
> "Automatically assign leads to users or **queues** based on criteria you define.
> You can create multiple rules with different conditions, but **only one rule can
> be active at a time**."

**This one sentence is the fix for LeadSquared finding #5.** Bigul currently has
three "Lead Updated" automations firing on overlapping populations with undefined
execution order — a live race condition. Salesforce's answer is structural:
*one active assignment rule, containing ordered rule entries.* Ordering is
explicit and internal to a single artefact, so it cannot race with itself.

Also note assignment targets **users or queues** — reinforcing the queue-as-owner
pattern rather than shared logins.

## VALIDATION RULES ▫
Declarative constraints evaluated on save. A rule is a boolean formula plus an
error message and an error location (field-level or page-level). They run on
every save path — UI, API, import, automation — which is precisely the
"enforce at the API layer, not just the UI" requirement from the LeadSquared audit.

## RECORD TYPES + PROCESSES ✅ (surface verified, semantics ▫)
`Record Types` is one of the 19 per-object configuration surfaces ✅, and
`Lead Processes` / `Sales Processes` appear in Setup ✅.

The pattern: a **Record Type** on one object binds together
- a **picklist value subset** (e.g. only the stages relevant to this business line),
- a **page layout** assignment,
- a **business process** (the ordered stage set),
per profile.

> **This is the answer to LeadSquared's 35 opportunity "types" and 32-value stage
> enum.** Instead of creating a new pipeline object per business line, you keep
> ONE Opportunity object and give each business line a Record Type with its own
> stage subset and layout. Reporting stays unified; the UX stays specific.
> For Bigul: one `Deal` object with record types for Equity, MF, Global
> Investments, Partner, Algo — not five pipelines.

## APPROVAL PROCESSES ✅ (surface verified, semantics ▫)
Multi-step record approval with entry criteria, approver assignment (user, queue,
manager hierarchy, or dynamic), field updates on approve/reject/recall, and record
locking while pending. `Mass Transfer Approval Requests` exists as a companion
admin tool ✅.

> LeadSquared has no approval concept at all. For a SEBI-regulated broker,
> approval + record locking on things like account closure, fee waivers, or
> partner onboarding is likely a genuine requirement worth scoping.

## DUPLICATE MANAGEMENT ✅
Surfaced proactively **on the record page itself** — the Lead record showed:
> "We found no potential duplicates of this Lead. **No duplicate rules are
> activated.** Activate duplicate rules to identify potential duplicate records."

Two-part model ▫: **Matching Rules** (how to compare records) +
**Duplicate Rules** (what to do on match — allow with warning, or block).
Plus Duplicate Error Logs and Duplicate Record Sets ✅.

> Note the UI *tells the admin the feature is off*. Compare LeadSquared, where
> zero dependent-field relationships are configured and nothing anywhere says so.
> **Design principle: surface unconfigured safety features where the consequence
> lands, not buried in settings.**

## MONITORING ✅
From the classic Monitor menu: System Overview · Imports · Outbound Messages ·
**Time-Based Automations** · **Automated Process Actions** · Case Escalations ·
Entitlement Processes · API Usage Notifications · Mass Emails · Email Snapshots ·
Jobs · Logs. Plus **Paused And Failed Flow Interviews** in Process Automation ✅.

> A dedicated, admin-visible queue of *failed and paused automation runs*.
> LeadSquared shows lifetime trigger counts but no failure surface — the
> `Cube lead call dispose API` LAPP is running 27,000 calls/week with 17 errors
> and nothing surfaces that. **Build the failure queue from day one.**
