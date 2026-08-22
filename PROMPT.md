# The prompt — paste this into Claude Code

Replace `[YOUR STACK]` and `[SCOPE & TIMELINE]` first.

---

I've completed research on two CRM systems and put both in this repo. Read them
before doing anything else.

**`docs/legacy-leadsquared/`** — a full audit of the CRM my business runs today
(LeadSquared). Bonanza Portfolio / "Bigul", retail stock broking in India,
SEBI-regulated. 495,118 leads, 83 active users. Read directly from the live
production tenant — every number, field name and entity code is real, not
estimated. Start with `LEADSQUARED-CRM-REFERENCE.md`.

**`docs/salesforce-reference/`** — a design reference from a Salesforce org,
documenting how a mature CRM platform solves the same problems. Start with
`SALESFORCE-DESIGN-REFERENCE.md`. **Part 6 of that document is a table mapping
each LeadSquared failure to the Salesforce pattern that solves it — that table
is effectively the design brief.**

I want the new CRM built with Salesforce-like architecture and configurability,
carrying none of LeadSquared's structural debt.

**Important:** the Salesforce org is vanilla with demo data. Trust it for
architecture — field type system, security layering, per-object configuration
uniformity, UI composition. Do NOT trust it for what a broking CRM should
contain. Business requirements come from the LeadSquared audit. The Salesforce
doc also has a "What NOT to copy" section (Part 7) — Salesforce carries its own
legacy debt and we should not inherit it.

**My current state:** [YOUR STACK]
**Scope and timeline:** [SCOPE & TIMELINE]

---

## Before you write or change any code, do these three things in order

**1. Read both document sets.** Master docs first, companion files for depth.

**2. Reconcile against what you've already built.** Produce `docs/gap-analysis.md`:
- Where does the current implementation already match the target model?
- Where does it contradict it? Specifically check whether the schema repeats any
  of the ten failure modes in Part 1 of the LeadSquared doc: a single overloaded
  status enum; opportunity used as a generic work item; stamped counters instead
  of computed aggregates; notes appended to the parent instead of attached to the
  interaction; flat-only AND/OR filters; vendor names embedded in entity types.
- What must be refactored now vs. what can wait — with reasoning about cost of
  delay, since schema refactors get more expensive once there's data in them.

Be blunt. If something you already built needs to be thrown away, say so plainly.
I would much rather hear it now.

**3. Propose the data model.** Part 8 of the Salesforce reference has a target
entity model that supersedes Part 7 of the LeadSquared doc. Treat it as a
hypothesis to argue with, not a spec to implement. Produce `docs/data-model.md`
with concrete entities, fields, types, relationships, indexes and constraints for
our stack. Where you disagree, say why.

---

## Hard constraints — non-negotiable

Each one comes from a specific documented failure in the current production
system, with a proven platform pattern that solves it.

- **One shared Interaction timeline** for calls, WhatsApp, SMS, email, meetings.
  Never mirror activity between parent records. LeadSquared runs an automation
  that has done exactly this 14.1 million times; Salesforce solves it with
  polymorphic parent references on a single Activity model.
- **Notes and outcomes attach to the interaction**, never appended into a text
  field on the parent. See LeadSquared Part 1 finding 6 for what happens
  otherwise — a real field contains months of notes from multiple agents
  concatenated with pipe characters.
- **Computed fields are a schema feature**, not automation. Formula and
  Roll-Up-Summary equivalents. This deletes LeadSquared's two busiest automations
  (14.1M and 8.0M lifetime triggers).
- **Field-change history and stage entry/exit timestamps are first-class and
  queryable** from day one. Six LeadSquared automations exist only because
  they aren't.
- **Label ≠ API name.** Two identifiers per field and per entity. Business users
  rename labels; integrations bind to the immutable API name. LeadSquared has
  permanent typos baked into schema names because it lacks this.
- **Uniform per-object configuration.** Every entity — standard or custom — gets
  the same configuration surfaces. See Part 1 item 1 of the Salesforce doc.
- **Access control: one floor, then only grants.** Org-wide defaults set the
  baseline restriction; every other layer can only widen. One primary role per
  user plus additive permission sets. Include a "simulate access as this user"
  capability.
- **Owner is polymorphic (User or Queue).** Queues are ownership targets that
  individually-authenticated users pull from — never shared login credentials.
  LeadSquared has six shared accounts that destroy attribution today.
- **Record types over pipeline sprawl.** One Deal entity with record types per
  business line, not 35 separate pipelines. Reporting stays unified.
- **Segments are live saved queries** with nested boolean logic
  `(A AND B) OR (C AND D)`, not stored membership rows. LeadSquared has 4,810
  lists because its search only supports flat AND/OR.
- **Cascading picklist validation enforced at the API layer**, not just the UI.
  Most writes arrive via API and automation.
- **Automation rules have explicit priority and ordering**, with static conflict
  detection and a per-object "what runs when" view. LeadSquared has a live race
  condition from three rules writing the same fields on the same trigger.
- **An automation failure queue.** Paused and failed runs must be visible to
  admins. A LeadSquared integration currently runs 27,000 calls/week with 17
  errors and nothing surfaces it.
- **A configuration audit log** — who changed what, when. Its absence is why
  LeadSquared admins encode deploy dates into automation names.
- **Vendor detail quarantined** behind a normalised event contract. Model the
  event, not the vendor — "Meeting Held, channel=Zoom", never a "Zoom Meeting"
  entity type.
- **Encrypted field type** available at schema level. Relevant for PAN, bank
  details and BOID in a regulated broking context.

---

## Do not

- Carry over `mx_` field naming, or the duplicate/typo'd/test fields catalogued
  in Part 2.3 of the LeadSquared doc.
- Assume LeadSquared's structure is correct because it's in production. Most of
  it is workaround accumulated under platform constraints.
- Copy Salesforce's own legacy debt — see Part 7 of the Salesforce doc.
- Start implementing until I've reviewed the gap analysis and data model.

---

## Ask me questions

Some things need a business decision from me, not a technical one from you:
- Does workforce management (attendance, shifts, leave) belong in the CRM or an
  HRMS? LeadSquared bundles it and it's actively used.
- What's in scope for approvals? LeadSquared has no approval concept at all.
- Part 9 of both documents lists what the audits did not cover.

Flag anything ambiguous rather than guessing.
