# The last Bigul automations, read

**Read 12 October 2026** in the Bigul tenant (`app-in21`, account 57437), live,
via Live Edit. Nothing was changed: every flow was opened, read and left
published exactly as it was.

These are the automations the earlier pass did not reach. With them, the Bigul
automation audit is complete.

---

## 1 · Engagement Team Automation — 23 March 2026

| | |
|---|---|
| Trigger | New Activity on Lead → **WhatsApp Message** |
| Scope | Global · Published 23 Mar 2026 · Kapildeo Agrawal |
| Runs | **3,532,760** — the busiest automation in the tenant |

One `Multi If/Else` evaluating on latest data, eleven branches and an Else.
Every branch is the same shape:

> Triggered Activity is **WhatsApp Message** **and** Direction is **Inbound**
> **and** Notes **contains** *&lt;keyword&gt;* → **Add Opportunity**

| # | Notes contains | Opportunity created |
|---|---|---|
| 1 | Smart Investor | Dealer Support |
| 2 | Equity | Dealer Support |
| 3 | Commodity | Dealer Support |
| 4 | Smart Options Trader | Dealer Support |
| 5 | Smart Intraday Trader | Dealer Support |
| 6 | Algo Strategies | Dealer Support |
| 7 | **Reactivation** | **Dormant** → then **Distribute Opportunity** |
| 8 | Segment Activation | Dealer Support |
| 9 | Stock Basket | Dealer Support |
| 10 | Option Calls | Dealer Support |
| 11 | YES | Dealer Support |
| — | *Else* — no condition met | flow ends, nothing created |

**What it really is.** A keyword router on the text of an inbound WhatsApp.
The customer replies to a campaign with a word, and that word opens an
opportunity of a given type. Only the Reactivation branch is also distributed
to somebody.

**For the new CRM.** This is not eleven rules. It is one table —
*keyword → opportunity type → distribute yes/no* — read by one rule. Built as
eleven branches it cannot be changed by the business without an automation
edit, and the eleventh keyword ("YES") shows the cost: a bare acknowledgement
from any campaign lands in the same Dealer Support queue as a product enquiry.

---

## 2 · The DIY journey — four automations that are one journey

| Automation | Trigger | Runs |
|---|---|---|
| DIY Journey 1 — 30 Dec 2023 | Lead Created | 762,365 |
| DIY Journey 2 — 30 Dec 2023 | Sub Automation | 72,080 |
| DIY Journey 3 — 29 Dec 2023 | Sub Automation | 27,010 |
| DIY Drop Off (Distribute Lead Only) — 23 Jul 2024 | Sub Automation | 623,445 |

**DIY Journey 1** reads:

```
New Lead (lead created)
  └─ If Lead Stage is ESIGN DONE or …        → (yes) stop
     └─ No → Wait 4 minutes
        └─ Multi If/Else on latest data
           ├─ Lead Stage is PROSPECT          → Send to Sub-Automation:
           │                                     DIY Drop Off (Distribute Lead Only)
           ├─ Lead Stage is CONTACT INFO …    → Wait 4 min  → Multi If/Else (again)
           ├─ Lead Stage is PAN SUBMITTED     → Wait 8 min  → Multi If/Else (again)
           ├─ Lead Stage is DIGILOCKER/AWA…   → Wait 5 min  → If/Else (again)
           └─ Else                            → Send to Sub-Automation:
                                                 DIY Journey 2 — 29 Dec 2023
```

Journey 2 picks up at `Lead Stage is PERSONAL INFO…` → wait 5 minutes →
`Multi If/Else` and carries on down the same staircase; Journey 3 continues it.
The nesting runs four levels deep inside Journey 1 alone.

**What it really is.** A poller. Every few minutes it re-reads the applicant's
stage, and when they have stopped moving it hands them to **DIY Drop Off**,
whose only job is to distribute the lead to a human. The split across three
automations is not a design — it is the flow outgrowing what one LeadSquared
automation can hold.

**For the new CRM.** We already model this properly and do not need to port any
of the four: the KYC journey has a per-step timer, the sweep marks a step
stalled, an hour of stall abandons it, and the Product RM is notified to take
over. What we *should* take from these flows is the **tuning**: the legacy
thresholds are per stage (4 minutes at contact info, 8 at PAN submitted, 5 at
DigiLocker), where ours are per step in `MASTER_STEPS`. Worth comparing the two
lists before go-live.

---

## 3 · Product to Pitch based on campaign

| | |
|---|---|
| Trigger | New Lead (lead created) |
| Scope | Global · Published 9 May 2024 · Vikrant Dale |
| Runs | **735,604** |

A single `Multi If/Else` whose first branch is
`Source Campaign contains Easy_Options → Update Lead: Prod to Pitch`, and whose
Else opens an `If/Else` on `Source Campaign contains Algo_Trading`, whose No
opens another on `Source Campaign contains Direct…` — and so on. **Fourteen
levels deep**, a diagonal staircase down the canvas, every rung a string match
on the campaign name setting one field.

**For the new CRM.** This is a lookup table written as control flow: *campaign
name contains X → product to pitch is Y*. It belongs in the campaign-to-product
mapping on the campaign record, maintained by marketing, not in an automation
that needs a developer and fourteen edits to add a product.

---

## 4 · Trading Activity Created — 28 Aug 2024

| | |
|---|---|
| Trigger | New Activity on Lead → **Trading Activity** |
| Scope | Global · Published 27 Sep 2024 · Pritee Mahore |
| Runs | **243,876** |

Two things happen in parallel on every trade:

1. **Update Lead** — `Trades Placed Last…` (a recency/count field on the lead)
2. **If `First Traded Date` contains data** → **No** → **Update Lead:
   `First Traded Date`**

**For the new CRM.** This is **gap 3 of the migration mapping**, found in the
wild and with its field names: *"funds transferred" and "first business" are
client facts, not lead stages*. The legacy tenant maintains first-trade date by
automation on the **lead**; we proposed recording first funding and first trade
on the **client**. This flow is the evidence that the data exists and is
already being kept — and the reason it must move: a lead-level date cannot
survive the lead becoming a client.

It is also a roll-up written as an automation, which non-negotiable 3 of
`CLAUDE.md` says is schema, not automation.

---

## 5 · Interested client Distribution — 14 July 2025

| | |
|---|---|
| Trigger | Activity Added |
| Scope | Global · Published 24 Jul 2025 · last modified by **System** |
| Runs | **147,556** |

A wide `If / Else If` fan, branches keyed on a mixture of
`Triggered Activity of the Lead is…` and `Lead Stage is ACCOUNT OPENED or…`,
each creating an opportunity — mostly **Dealer Support**, at least one
**Sales Support Opportunity**.

**For the new CRM.** Same shape as the Engagement Team flow and the same
answer: a routing table, not a branch per case. Worth noting that its branches
mix two different questions — what the customer did, and where the lead is —
which is why the list has grown: every combination needs its own rung.

---

## What this changes

1. **Four of the eight do not need porting at all.** The DIY journey family is
   a hand-rolled version of the per-step timer and stall sweep we already have.
2. **Three are tables pretending to be flows.** Engagement Team, Product to
   Pitch and Interested client Distribution are each a lookup the business
   should own. Ported as automations they would be unmaintainable here too.
3. **One is a schema change we had already proposed.** Trading Activity Created
   is mapping gap 3, with the field names confirmed.
4. **Trigger volumes are worth keeping.** 3.5M, 762k and 735k runs are the
   three biggest; whatever replaces them has to carry that load, and the
   WhatsApp keyword router is the one to design for first.

## Still to read

Nothing in Bigul. The Bonanza tenant's two Cube LAPPs and its forms/processes
are the remaining legacy unknowns — see `BONANZA-TENANT-AUDIT.md`.
