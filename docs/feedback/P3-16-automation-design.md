# P3-16 · Automation builder — design for approval

**For:** Ritesh · **Date:** 9 September 2026
**Status:** proposal. The ticket's acceptance clause is *"The builder design is
presented to me for review before implementation begins"* — this is that, and
nothing is built until you approve or correct it.

---

## Why this is first

Your top four automations in LeadSquared have run **33,077,396 times** between
them:

| Automation | Lifetime triggers |
|---|---:|
| Add Activity on Opportunity as per Lead | 14,140,741 |
| Activity on Lead — 28 Aug 2025 | 8,482,785 |
| Activity Score 07-06-2025 | 8,023,974 |
| Engagement Team Automation | 2,429,896 |

Automation is the load-bearing mechanism in how Bonanza runs today. It is also
the place the audit found a **live race condition**: three "Lead Updated"
automations firing on overlapping populations with no defined execution order.

---

## 1 · The decision that shapes everything else

**What exists today is a rule. What you have asked for is a flow.**

| | Today (`engine/rules.js`) | What P3-16 describes |
|---|---|---|
| Shape | A filter: conditions → actions, evaluated in one pass | A canvas: trigger → branches → waits → actions |
| Lifetime | Stateless. Runs, finishes, forgets. | **Durable.** A lead can sit inside a Wait card for three days. |
| Branching | None — one condition set, one action set | If/Else, Multi If/Else, Split test |
| Trigger | A sweep over enabled rules, plus a schedule | Four trigger families with sub-options |

The Wait cards are the whole architectural difference. *"Wait 2 days, then if
they still have not replied, send an SMS"* means the system must remember that
this lead is at step 4 of automation 7, wake it at the right moment, and resume
— surviving restarts.

**That makes this a state machine with durable execution, not a bigger filter.**
It is the single largest piece of work in the ticket and the reason I would not
start it without your sign-off on the shape.

**Recommendation: build the flow, but keep the existing rule engine running
beside it during migration.** Salesforce's own lesson, from the reference:

> Salesforce has three generations of automation engine. Rather than leaving
> them all running silently, it names the current one clearly, keeps legacy ones
> visible but marked, **ships a migration tool**, and provides a Flow Trigger
> Explorer so you can see everything that fires on an object in one place.

Your tenant today has V3 and V4 of the same form both live and "- Clone"
automations with no way to see what touches a field. I want to avoid recreating
that.

---

## 2 · Triggers

The ticket names four families. I propose these, cross-checked against the
trigger vocabulary actually in use in your LeadSquared tenant.

| Family | Events | In use today? |
|---|---|---|
| **Lead** | Created · Updated *(field-specific)* · Added to a list · Stage changed · Owner changed | Lead Created, Lead Updated ✅ |
| **Activity** | Logged on a lead · Disposition recorded · Call outcome ⋅ Email opened/clicked | Activity Added ✅ (the busiest trigger you have) |
| **Task** | Created · Due · Overdue · Completed | — |
| **User** | Start of workday · End of workday · Check-in · Check-out | On WorkDay End ✅ |
| **Schedule** | At regular intervals · On a date | At Regular Intervals ✅ |
| **Sub-automation** | Called by another automation | Sub Automation ✅ |

**Two deliberate differences from the ticket:**

1. **"Opportunity" triggers become product-card triggers**, because that is our
   model. The audit's verdict on the 35 opportunity types was to use one object
   with record types, not a pipeline per business line.
2. **Field-specific update triggers.** "Lead Updated" firing on *any* change is
   how you end up with 8.5 million executions where a few thousand were meant.
   A trigger should name the fields it cares about.

**Question A1:** does anything need to trigger on a *client* or *ticket* event,
or is lead + activity + task + user enough for now?

---

## 3 · The canvas — conditions and flow control

The ticket lists eight cards. My proposal, with a recommendation on each:

| Card | Recommend | Note |
|---|---|---|
| If / Else | **Build** | The core branch. Uses the nested AND/OR condition tree that already exists in `engine/conditions.js` — this part is done. |
| Multi If / Else | **Build** | N branches with a fallthrough. Same evaluator. |
| If lead exists | **Build** | Cheap; it is a condition with a friendlier name. |
| Wait | **Build** | Fixed delay. The durable-execution work lands here. |
| Wait (Advanced) | **Build** | Delay honouring business hours, weekends and the holiday calendar — all of which already exist in `engine/calendar.js`. |
| Wait until activity | **Build** | "Wait up to 3 days for a reply, then continue." Needs a timeout arm or it is a leak. |
| Wait until workday | **Build** | Ties to the check-in work from P3-09. |
| Split test | **Defer** | See below. |

**On Split test — my recommendation is to defer it, not to build it now.**
A/B testing needs a holdout population, a success metric and enough volume for
the result to mean anything. It is a marketing-experimentation feature, and
building it into the first version buys a card nobody can yet interpret. It is
straightforward to add once the flow engine exists.

**Question A2:** do you disagree? If there is a live A/B need, it changes the
priority.

---

## 4 · Actions

We have nine actions today. The ticket asks for roughly twenty.

| Category | Have | Add |
|---|---|---|
| **Messaging** | WhatsApp · SMS · Email | Opt-in email |
| **Lead** | Update lead field · Update product card | Add activity · Add to list · Remove from list · Star lead |
| **Sales execution** | Create task · CRM notification · Assign to role queue | Distribute lead *(round-robin / least-loaded)* · Notify owner by SMS |
| **Custom** | — | Webhook · Nudge users |
| **Meetings** | — | Zoom *(see below)* |
| **Composition** | — | Send to sub-automation |

**Every messaging action already has its template builder.** P3-17 shipped
WhatsApp, Email and SMS builders with provider validation, and its own
acceptance clause says templates must be selectable from automation actions.
That work is finished and waiting for this caller — a real reason to do
automation before the other large builds.

**Three I recommend against, or with conditions:**

- **Call a LAPP** — depends on P3-19, which I have recommended challenging. If
  LAPPS is not built, this becomes **Webhook**, which is the safer shape anyway:
  the code runs on infrastructure you own and review, not inside the CRM.
- **Zoom** — a connector, so it belongs to P3-20 rather than here. The action
  becomes available when the connector is.
- **Distribute lead** — worth care. This is assignment, and Salesforce is
  explicit: *"only one rule can be active at a time"*, with ordering internal to
  a single artefact so it cannot race with itself. If automations can also
  assign, we have two assignment mechanisms and the race returns. **Recommend:
  an automation may hand a lead to the assignment engine, never pick an owner
  itself.**

---

## 5 · Ordering, conflicts and failure — mostly already built

Non-negotiable #12 is *"explicit automation ordering + conflict detection +
failure queue"*, and `engine/conflicts.js` already provides `detectConflicts`,
`ambiguousOrdering` and `healthReport`. The flow engine inherits them.

What I would add, taken from the Salesforce reference:

- **A "what runs when" explorer per object.** One screen answering "everything
  that fires on a lead, in order". The audit's complaint about your tenant is
  that no such view exists.
- **Paused and failed runs as a first-class screen** — Salesforce has *Paused
  And Failed Flow Interviews*. With Wait cards, a paused run is normal and needs
  somewhere to be seen.

---

## 6 · Reporting

The ticket asks for leads affected and leads triggered, per automation. I
propose per automation and **per step**, because "1,000 entered and 40 finished"
is only useful if you can see which card they are stuck on.

| Metric | Why |
|---|---|
| Entered | How many were caught by the trigger |
| Currently waiting | Live runs, by the step they sit on |
| Completed | Reached the end |
| Exited early | Failed a condition — with which one |
| Failed | Errored — with the reason, linked to the failure queue |

---

## 7 · What I recommend NOT building

| Item | Why |
|---|---|
| Split test | No population or success metric yet. Add later. |
| Call a LAPP | Depends on P3-19; a webhook is the safer equivalent. |
| Zoom action | Belongs to the connectors build. |
| Automation picking an owner directly | Recreates the assignment race the audit found. |

---

## 8 · Migration

51 published automations exist in LeadSquared, and our own rule engine has rules
running now. Ours convert mechanically — a rule is a flow with a trigger, one
condition card and one action card. I would ship that converter with the engine,
the way Salesforce ships *Migrate to Flow*, so nothing is hand-retyped and the
old engine can be switched off on a date rather than by attrition.

**Question A3:** do the 51 LeadSquared automations need porting, or is this a
clean start where the team rebuilds what still matters? Porting 51 blind would
carry over the clones and the dead ones — the audit found V3 and V4 of the same
thing both live.

---

## 9 · Roughly what this costs

| Piece | Relative size |
|---|---|
| Durable execution — run state, scheduler, resume, restart safety | **Largest.** The core. |
| Canvas UI — drag, connect, configure, validate | Large |
| Trigger layer | Medium |
| Actions — eleven new ones | Medium, mostly mechanical |
| Reporting | Small |
| Migration from the current engine | Small |

This is the biggest single item in Part 3. I would rather say that now than
discover it at the end.

---

## Questions

| # | Question |
|---|---|
| **A1** | Do client or ticket events need to trigger automations, or is lead + activity + task + user enough? |
| **A2** | Split test — defer, or is there a live A/B need? |
| **A3** | Port the 51 LeadSquared automations, or clean start? |
| **A4** | Confirm: an automation may hand a lead to the assignment engine but never pick an owner itself. |
| **A5** | Confirm the trigger list in §2, particularly that "Lead Updated" must name the fields it watches rather than firing on any change. |

---

## 10 · What is built, as of 10 September

The estimate in §9 held: durable execution was the largest piece and the canvas
is the one still outstanding.

### Working

| Piece | Notes |
|---|---|
| Durable execution | Run position lives in `automation_run`, so a lead asleep in a Wait card survives a deploy. One live run per lead per automation — the safeguard against the 14-million-execution shape. |
| Triggers | Nine of ten fire. A minute-tick scanner asks the database what is new rather than a `fire()` call at each of the 46 write sites, so a lead arriving from Facebook is caught the same as one typed in by hand. |
| Actions | Nineteen, in the six categories §4 lists. Zoom deferred to P3-20; "Call a LAPP" became Webhook. |
| Validation | A flow cannot go live wired to nothing, looping, waiting zero, calling itself, pointing at a paused sub-automation, or on a trigger nothing fires. |
| Reporting | Per automation and per step, as §6 proposed. |
| Explorer | "Everything that runs on this trigger, in order" — the screen §5 said was missing from the legacy tenant. |
| Migration | Converts a rule into a draft flow, and refuses when a condition would be lost. |

### The safeguards worth knowing about

**The scanner starts at now, not at zero.** A watermark it has never seen is set
to the current maximum. Starting at zero would treat all 495,118 existing leads
as new and enter every one of them into every automation, on a timer, at three
in the morning. There is a test that fails when that safeguard is removed.

**Converting a rule refuses rather than widens.** Three of the six rules in the
system lose every condition in translation — `kyc_journey_status`,
`contact_flag` and a per-product card state have no equivalent in the flow
builder's vocabulary. A tree with no leaves is true for everybody, so those
rules would become flows acting on the whole book. The converter refuses them
by name and says why.

**Every send now checks consent.** It did not before, on either engine. Every
*route* did; the engines did not, which is precisely the hole `consent.js`
describes in its own header — and the engines are where a segment-sized send
actually happens.

### Not built

| Piece | Why |
|---|---|
| **The drag-and-drop canvas** | The flow is assembled and wired card by card, which runs and validates. Drawing it is the layer on top. This is the largest piece left in P3-16. |
| `user.workday_end` | Not lead-shaped: a workday ends for a person, and which of their leads should enter a flow is a business question. Marked unavailable in the builder and refused at activation rather than left to look live — **question A6 below**. |
| Split test | §7 recommended against it without a population or a success metric. |
| Zoom | A connector; belongs to P3-20. |

### One more question

| # | Question |
|---|---|
| **A6** | "A user ends their workday" — when Priya ends her day, which leads should walk into the flow? Every lead she owns, the ones she did not reach today, or the ones with a task still open? Until this is settled the trigger stays unavailable rather than silently doing nothing. |
