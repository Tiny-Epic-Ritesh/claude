# QA-02 — rules that fire once per change, not once per sweep

**Status:** signed off 13 October 2026 with the four recommended answers, and
**built the same day** — see "As built" at the end. The page Ritesh signed off
from: https://claude.ai/artifact/XcSKDBwboMni8cVtGM6miJ

## What happens now

`index.js` calls `runEnabledRules()` every five minutes. `runRule()` takes
**every lead** in the database, asks whether it matches the rule's conditions
*right now*, and runs the rule's actions for every lead that does
(`engine/rules.js`, `runRule`). Nothing records that a rule has already acted
on a lead, so a lead that stays in a matching state is acted on again at every
sweep — twelve times an hour, for as long as it stays there.

That is the whole of QA-02. The auditor's numbers follow from it directly:

| Rule | Fired | What each firing does |
|---|---:|---|
| Warm → notify Product RM | 10,431× | A notification to the Product RM **and a new 4-hour task** for the owner |
| KYC escalation waterfall | 48,243× | **A WhatsApp to the client** and a notification to the Product RM |
| transfer lead to post sales team | 47,526× | Created on labs, not in the seed; an assignment |

With 41 leads, that is 10,477 tasks, 48,443 activities, 29.5 MB of `rule_runs`
and 17.1 MB of notifications — and Priya's cockpit showing 10,000 overdue
follow-ups, all the same "Contact lead — warm MF card".

### The part that matters most

The KYC waterfall **messages the client**. On labs every provider is simulated,
so the 48,243 WhatsApps went nowhere. In production, an applicant whose KYC
stalls would get *"Hi Aarav, your Bonanza application is one step from done"*
every five minutes. A stall is normally abandoned an hour later, which stops it
at about twelve; a journey that stays Stalled gets **288 a day** with no limit.
On labs five journeys stayed Stalled for days. One known cause is an open High
or Critical case on the card, which freezes the KYC clock — so the applicants
most likely to be messaged without end are the ones who have complained. For a
SEBI-regulated broker that is a complaint, a DND breach and a reputational
event, and it would happen on day one.

**Until this is fixed, the waterfall should not be enabled anywhere a real
WhatsApp provider is configured.** It is enabled in the seed.

## What it should do

**A rule fires when a lead starts to match, and not again until it has stopped
matching and started again.** Edge-triggered, not level-triggered.

- A Warm MF card with direct contact produces **one** task and one
  notification — when it becomes Warm. If it goes cold and comes back Warm, the
  rule fires again, because that is a new event.
- A KYC journey that stalls produces **one** WhatsApp. If it is resumed and
  stalls again, one more.

Some rules genuinely want repetition — a reminder every 24 hours while
something is still stuck. That becomes a **per-rule setting, "repeat every N
hours while it still matches"**, off by default, so repetition is a decision
somebody made and can see on the rule rather than an accident of the sweep
interval.

## How

1. **A firing ledger.** A new table, `rule_firings (rule_id, lead_id, armed_at,
   fired_at, cleared_at)`, one open row per rule and lead while the lead
   matches. Each sweep:
   - matches, no open row → **fire**, open a row;
   - matches, open row, and the rule repeats and is due → **fire**, stamp it;
   - matches, open row, otherwise → **nothing**;
   - no longer matches, open row → close it (`cleared_at`), so the next match
     is a new event.
2. **Idempotency.** `UNIQUE (rule_id, lead_id, armed_at)` on the firing, and
   each action's side effect carries the firing's id — a task records
   `rule_firing_id` — so a sweep that crashes halfway and runs again cannot
   create a second task for the same firing.
3. **Bounded retries.** A failed action is retried on the next sweep up to
   three times, then left in the existing `rule_failures` queue for a person —
   instead of failing silently forever or retrying forever.
4. **`rule_runs` only when something happens.** Today it writes a row for
   every match at every sweep, which is the 29.5 MB. It will write on a firing
   or a failure, and keep 90 days unless told otherwise.
5. **`fire_count` counts firings**, not matches-per-sweep, so the number on the
   rule builder means what it says.

The automation builder (P3-16) has its own run path and is not changed by this.

## The data already there

On labs.tinyepic.in there are about 10,000 duplicate open tasks and their
notifications. They are identifiable: rule-created tasks have `created_by` NULL,
and the duplicates share a lead, a title and an assignee.

Proposed: a **preview first** — a script that lists, per lead, the duplicate
open rule tasks and keeps the oldest — then, on approval, closes the rest with
a reason, *"Duplicate created by the scheduler (QA-02)"*, leaving them in
history rather than deleting them, so the auditor's evidence survives. The
same for notifications. Nothing is touched on labs without an explicit yes, and
I do not run it myself — it is a change to the deployed database.

## Tests

- Ten sweeps over a lead that stays Warm produce **one** task.
- A lead that leaves the state and re-enters produces a **second**.
- A repeating rule set to 24 hours fires once in a sweep, not again 5 minutes
  later, and again after the interval.
- A sweep that throws after creating the task and is re-run creates no second
  task.
- The waterfall sends **one** WhatsApp per stall.

Each written to fail on the current code, as the Round 4 tests are.

## Four answers needed

1. **For each live rule — once per change, or repeat? If repeat, how often?**
   *Warm → notify Product RM* reads as once. *KYC escalation waterfall* is
   described as "WhatsApp now, then SMS, then RM alert" (BRD §7.7) — a staged
   escalation with timings, of which the current rule does only the first
   message and the alert. What are the stages and their timings?
2. **"transfer lead to post sales team"** was created on labs and is not in the
   seed. What is it meant to do, and should it run at all?
3. **How long to keep `rule_runs`?** 90 days is proposed.
4. **The ~10,000 duplicate tasks on labs: close them as duplicates (kept in
   history), or delete them?** Closing is proposed; it needs a task status for
   it, which tasks do not have today (QA-37 found no cancel or close).

## Answered 13 October

1. Every rule fires once per change. The waterfall: a WhatsApp at the stall,
   an SMS 30 minutes later if still stalled, an assisted-completion task for
   the Product RM at abandonment, and no client message while a High or
   Critical case is open on the card.
2. "transfer lead to post sales team" stays on labs and fires once per lead.
3. `rule_runs` is kept 90 days.
4. The duplicates are closed, not deleted — preview first, and run on labs
   only after a yes.

## As built, 13 October

- **`rule_firings`** (`db.js`), one open row per rule and lead, with a partial
  unique index so two sweeps cannot arm the same lead twice. `runRule`
  (`engine/rules.js`) arms on the first match, clears when the lead stops
  matching, and in between runs only what is due: a delayed stage, a retry, or
  a repeat the rule asked for. Each lead's firing — the row, every side effect
  and the run record — is one transaction, and a task records its
  `rule_firing_id`.
- **Stages.** An action may carry `after_minutes`; it runs that long after the
  firing's first actions actually ran, and only if the lead still matches. The
  builder offers straight away, 30 minutes, 1 hour, 4 hours or 1 day.
- **Repeat** is the schedule's `repeat_hours`, off unless chosen; the builder
  has a WHEN block for it.
- **The schedule is read at last.** Every seeded rule carried
  `business_hours`, `skip_weekends` and `max_per_day: 3`, and nothing read them.
  A firing due outside office hours (the office calendar), at a weekend, or
  over the daily limit for that lead waits for the next sweep that may act. The
  builder shows and edits all three.
- **Retries.** A failing action is tried at the next sweep up to three times,
  then left once in the failure queue. *Retry* there puts it back and runs it,
  and counts as resolved only if it actually ran.
- **The run log** is written only on a firing or a failure, stamped with the
  sweep's own time, and is a retention kind of its own — *Automation runs*, 90
  days — purged with the other logs and readable on the Logs screen.
- **No burst at deploy.** The first time the table is created, every lead a rule
  has already run against is taken as fired (`adoptRuleHistory`), so the first
  sweep after the deploy does not send one more WhatsApp to every stalled
  applicant.
- **The waterfall**, as answered: `kyc_journey_status = Stalled` and the new
  condition *KYC paused by an open High or Critical case* = no; a service
  WhatsApp and the Product RM notified, then a service SMS after 30 minutes.
  The messages name neither business, since one rule serves both. A second
  seeded rule, *KYC abandoned → assisted completion*, gives the Product RM on
  the journey's card one High-priority task (the new assignee *the Product RM on
  the lead's KYC journey*).
- **Dry run** says, per lead, whether the rule would act now, already has, is
  waiting (and why), or has a later stage to come — and writes nothing.
- **The duplicates on labs:** `server/scripts/qa02-duplicate-tasks.mjs`. Run as
  it is, it lists what would close and changes nothing; with `--apply` it closes
  every duplicate open rule task as **Cancelled** with the reason *"Duplicate
  created by the scheduler (QA-02)"*, keeping the oldest of each, and marks the
  duplicate automation notifications read. It is for Ritesh to run on labs.

`server/test/rulefiring.test.mjs`, 16 tests, drives the engine the way the
tick does with the clock passed in.

Not changed: the automation builder's own run path (P3-16), as planned. Found
while building: the `notify` action, given a role, notifies everyone in that
role in **both** businesses — recorded as `OPS-30`, not widened into this.
