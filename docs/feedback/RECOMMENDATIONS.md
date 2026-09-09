# Recommendations on the open decisions

**Compiled:** 9 September 2026.
**Grounded in:** `docs/legacy-leadsquared/` (the audit of what Bonanza runs
today) and `docs/salesforce-reference/` (the platform pattern). Where I cite a
number it comes from those documents, not from memory.

Each decision below gives the options, what the market does, what Bonanza's own
data argues for, and my recommendation. **Every one is yours to overrule.**

---

## Decision 1 · N-7 — should group membership grant visibility?

The ticket (P3-07) says *"Data visibility and permissions inherit up the
hierarchy — a manager can see the records of the roles reporting to them."*
Today visibility inherits through `users.manager_id`; group membership routes
work but grants no sight of records.

### What the audit says

This is the single clearest finding in the LeadSquared audit, §4.4:

> `Bigul Dealer Team`: **12 managers, 1 sales user.**
> `Call & Trade Team`: **4 managers, 0 sales users.**
> The "Manager" slot is being used to grant *visibility*, not to express
> reporting lines. → **Separate "can see" from "manages" in the new model.**

A user in the current system carries *1 Role + N Permission Templates + 1 Team +
N Sales Groups*, and the audit's verdict is that "effective access is the
intersection/union of four systems" — an unanswerable access question.

### What Salesforce does

Two different constructs, deliberately:

- **Role hierarchy** grants record visibility upward. One role per user.
- **Public Group** is a *target* for sharing rules. It grants nothing by itself.

Plus a per-object **"Grant Access Using Hierarchies"** toggle, so upward
inheritance can be switched off for a specific object.

### What we have

Our manager chain *is* the role hierarchy — it grants visibility. Our groups are
closer to a Public Group — they route work. Two mechanisms, one job each.

### Recommendation — **do not make group membership grant visibility**

Making groups grant sight of records would give us two visibility mechanisms
that can disagree, which is precisely the inversion the audit told us not to
repeat. A supervisor who needs to see a team's book should be their manager;
that is one fact, in one place, and it answers "why can this person see this?"

**Instead, build the thing Salesforce has for exactly this case: a sharing
rule.** "Records owned by members of group X are visible to Y" — named,
explicit, auditable, and additive over the floor. It gives you every capability
the ticket's bullet asks for without a second implicit grant path.

That is a contained piece of work — the OWD floor and the grant layers already
exist — and it satisfies P3-07 honestly rather than by widening the manager
chain into something it is not.

**Question N-7a:** do you want the sharing rule, or is the manager chain enough
in practice? In your structure, is there a supervisor who must see a team's
leads *without* being those RMs' manager in the CRM?

---

## Decision 2 · N-4 — which large build first

Five are outstanding. They are not parallelisable at any sensible quality.

### What Bonanza's own usage says

Lifetime trigger counts from the audit, busiest first:

| Automation | Lifetime triggers |
|---|---:|
| Add Activity on Opportunity as per Lead | 14,140,741 |
| Activity on Lead — 28 Aug 2025 | 8,482,785 |
| Activity Score 07-06-2025 | 8,023,974 |
| Engagement Team Automation | 2,429,896 |

**Over 33 million executions across the top four.** Automation is not a
nice-to-have in this business; it is the load-bearing mechanism, and the current
builder in our CRM is — your words — "very basic".

By contrast the audit records: *"Reports/SIERA. The reporting layer was not
audited."* We have no evidence of which reports Bonanza actually runs.

### Recommended order

| # | Build | Why here |
|---|---|---|
| **1** | **P3-16 Automation builder** | Highest evidenced dependence in the business. It also completes work already done — P3-17 says templates must be selectable from automation actions, and the template builders are finished and waiting for a caller. |
| **2** | **P3-20 Connectors** *(absorbing P2-14, P2-23, P2-25)* | Four tickets, one surface. Unblocks the integrations workstream that has been stalled since Round 2 on A-3/A-4. |
| **3** | **P3-06 Reports** | Large, and I would be designing the predefined library blind — see the question below. |
| **4** | **P3-21 Internal communication** | Genuine value, but no evidence of it blocking anyone today. |
| **5** | **P3-19 LAPPS** | See the next decision — I recommend questioning whether to build it at all. |

**The immediate next step is not code.** P3-16's acceptance clause is *"The
builder design is presented to me for review before implementation begins"*
(Q10). So the next deliverable is a design document for your approval. Say the
word and I will write it.

**Question N-4a — for P3-06:** the audit never covered the reporting layer, so I
cannot benchmark against what you use. Can you either export the list of reports
your team runs in LeadSquared today, or name the ten that matter? Without that I
would be proposing a library from Salesforce's defaults, which the standing
project rule says not to do.

---

## Decision 3 · P3-19 LAPPS — my recommendation is to challenge the ticket

The ticket asks for a JavaScript sandbox running on Node 22, equivalent to
LeadSquared's LAPPs, and its own acceptance clause requires a feasibility
assessment covering *"purpose, business value for Bonanza, and the security and
execution model"* **before any implementation**. Here is that assessment in
short.

**Why LAPPs exist in LeadSquared:** because it is a closed SaaS platform. When
the product cannot do something, the only route is to run your own code inside
it. LAPPs are an escape hatch from a system you do not control.

**We control this codebase.** Anything a LAPP would do, we can build as a
first-class feature — or expose as a webhook, which already exists.

**What it would cost.** A scripting sandbox in a system holding client PII, at a
SEBI-regulated broker, under your own standing rule that client data must not
leave India, is a large and permanent security surface. Arbitrary JavaScript
with access to CRM data needs resource limits, a permission model, egress
control, code review, and an answer to "who approved this script and what does
it read". That is a security project, not a feature.

**Recommendation:** do not build LAPPS as specified. Instead, ask the team which
LAPPs they actually run in LeadSquared today and what each one does. My
expectation is that the list is short and that each item is either (a) an
integration the connectors work covers, or (b) a small feature worth building
properly. If something genuinely needs arbitrary code, a webhook to a service
you own is the safer shape — the code runs on your infrastructure, under your
review, not inside the CRM.

**Question N-3a:** can you get the list of LAPPs currently in use, with what
each does? That single list probably decides this ticket.

---

## Decision 4 · Q6 — the AI summary button actions

Described in `DELIVERABLES.md`. Each card state has one action; permission-blocked
actions are shown with the reason rather than hidden; the one state with nothing
to do renders no button at all.

**Recommendation: ratify as built.** The mapping follows the card lifecycle you
already approved, and the "never a decorative button" rule is enforced on the
server rather than by convention.

**Question Q6a:** when someone clicks **Request a Product RM**, should the
product RM be notified — and if so, by what? Today it raises the request; I do
not want to add a notification channel on an assumption.

---

## Decision 5 · Q8 — the three homepage tiles

Overdue follow-ups · Unattended over 48h · Approvals waiting on you. Each opens
the screen that lists exactly what it counted.

**Recommendation: ratify as built,** with one caveat worth your eye. These are
all *chase* metrics — things going wrong. For an Admin or Super Admin homepage
that is right; for a Sales Head it might be worth one *performance* tile
alongside them.

**Question Q8a:** is the Admin homepage the right audience for these three, or
do you want a different set for a Business Head / Sales Head login?

---

## Decision 6 · N-1 — the P3-19 label

The handover feature is real work and is not in any feedback document.

**Recommendation:** give it its own ID outside the feedback numbering — `OPS-01`
— and leave P3-19 meaning LAPPS. Renumbering into the feedback series would make
your document and the repo disagree about what a number means, which is the
problem we just spent a session untangling.

---

## Decision 7 · N-5 — connectors as one build

**Recommendation: yes, one.** P2-14 (connectors screen), P2-23 (adapters and
vendor endpoints), P2-25 (Outlook) and P3-20 (apps marketplace) describe one
surface. Salesforce has one AppExchange/connected-apps surface, not four.
Building them separately gives four screens for one job and four places to
configure a credential.

---

## Decision 8 · N-8 — Back button on Setup screens

**Recommendation: no.** Setup has a persistent sidebar; Salesforce Setup
navigates by tree, not by back button. The complaint in P3-26 was about record
screens — Active Partner in particular — and those are fixed. Adding a back
button beside a sidebar gives two ways to do one thing.

Overrule me if Setup navigation is actually annoying you in practice; you use it
more than I do.

---

## Decision 9 · N-9 — click-through evidence for the sixteen buttons

**Recommendation: yes, but folded into the next browser session** rather than as
a standalone task. I will report per button. It is worth doing because P3-29's
defect — a dropdown missing a product the lead already had — is exactly the kind
of thing that passes a code read and fails a click.

---

## The questions, collected

| # | Question |
|---|---|
| **N-7a** | Is there a supervisor who must see a team's leads without being those RMs' manager in the CRM? If yes, I build the sharing rule; if no, the manager chain is enough. |
| **N-4a** | For P3-06 — can you export or name the reports your team runs in LeadSquared today? The audit never covered reporting. |
| **N-3a** | For P3-19 — can you get the list of LAPPs in use and what each does? |
| **Q6a** | Should "Request a Product RM" notify the product RM, and by what channel? |
| **Q8a** | Are the three chase tiles right for Admin, or do you want a different set for a Sales Head? |
| **N-4b** | Confirm the build order: automation → connectors → reports → internal comms, with LAPPS challenged. |
