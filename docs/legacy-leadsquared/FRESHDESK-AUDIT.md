# Freshdesk, read — and what replacing it would mean

**Read 12 October 2026** in the live Bonanza Freshdesk (`bonanza.freshdesk.com`,
"Helpdesk : Bonanza Portfolio"), admin portal, **read only**. Nothing was
created, changed or deleted. Every number below was read from the live account.

---

## 1 · The numbers, first

| | |
|---|---:|
| Open tickets | **34,442** |
| Unassigned | **34,232** |
| Overdue | **33,705** |
| Due today | 282 |
| Average first response time | **16h 13m 54s** |
| Unassigned chats | 221 |

**99.3% of open tickets have no owner. 97.9% are overdue.** That is not a
backlog, it is an unworked queue — and section 3 explains why nothing is
chasing it.

| | |
|---|---:|
| Agents (across groups) | **62** |
| Groups | 11 |
| Support mailboxes | 17 |
| Automation rules | **129** |
| SLA policies | 7 |
| Customer portals | 6 (2 live) |

---

## 2 · What is actually configured

### Portals — customers self-serve today

| Portal | Product | URL | Status |
|---|---|---|---|
| Bonanza Portfolio (primary) | — | bonanza.freshdesk.com | **Enabled** |
| Bigul | Bigul | bigul.freshdesk.com | **Enabled** |
| Assisted Broking | Assisted Broking | bonanzagroup.freshdesk.com | Disabled |
| Mutual Fund | Mutual Fund | bonanzaonline.freshdesk.com | Disabled |
| Partner Experience Desk | Partner | bigul-help.freshdesk.com | Disabled |
| Wealth | Wealth | — | — |

Two live customer-facing portals, and a product split — Assisted Broking,
Bigul, Mutual Fund, Partner, Wealth, Global — that maps onto the two books plus
the product lines. **Any replacement has to carry the portals**, not just the
agent view.

### Groups — 62 agents

Bigul 15 · Bonanza Assisted Broking 18 · Bonanza Wealth 10 · Bonanza Customer
Care 7 · Bigul Partner 3 · Bonanza Mutual Funds 3 · TECH 2 · Global Investments
1 · HR 1 · IT Support 1 · Marcomm 1

All eleven run on **Default business hours** — per-group hours exist in
Freshdesk and nobody uses them.

### Mailboxes — 17, and six are not working

Every address converts mail into a ticket. Six are not in a verified state:

| Address | Group | Status |
|---|---|---|
| pmscustomercare@bonanzaonline.com | Bonanza Wealth | **Re-authorize** |
| advantage@bonanzaonline.com | Bonanza Wealth | **Re-authorize** |
| nridesk@bonanzaonline.com | Bonanza Wealth | **Re-authorize** |
| customercare@bonanzagroup.com | Bonanza Assisted Broking | **Re-authorize** |
| mf@bonanzaonline.com | Bonanza Mutual Funds | **Verify** |
| partner.support@bonanzawealth.com | — | **Verify** |

Those are customer-facing addresses — NRI desk, PMS customer care, Advantage.
**Worth checking today whether mail to them is reaching anybody**, regardless
of what happens with the CRM.

And the one that matters most for compliance:

> **`grievances@bonanzaonline.com`** → group *Bonanza Assisted Broking*,
> **no dedicated SLA policy**. SEBI's investor-grievance clock is running on
> mail arriving here and nothing in the configuration knows that.

### SLA policies — 7, none of them SEBI

1. Priority Urgent — "a/c info, statement request" — resolve immediately
2. Priority – High — same day: charges calculation, dispute, any request
3. customer Care – Bonanza — all customer-care queries
4. Priority – Medium — needs investigation/approvals
5. Tech Reminders
6. HR
7. Default

### Ticket fields

Default: Subject · Category/Type · Source · Status · Priority · Group · Agent ·
Internal Group · Internal Agent · Product · Description · Company

Custom: `leadsquaredcheck` · `Customer Name` · `Mobile Number` · `Client Code` ·
`Remarks` · `Archived` · `Assign Myself` · `Remarks_id` · `Category`

Three of those — **Customer Name, Mobile Number, Client Code** — exist only
because Freshdesk cannot see the CRM. The customer is re-keyed onto every
ticket by hand, which is why a ticket cannot be trusted to find its lead.
`Remarks` + `Remarks_id` is a note living in a field, which is the second
non-negotiable in `CLAUDE.md`. And `Category` appears twice — default and
custom.

### The knowledge base is empty — all five portals

Read portal by portal, 12 October:

| Portal | Categories | Articles | **Published** |
|---|---:|---:|---:|
| Bonanza Portfolio Limited | 5 | 14 | **0** |
| Bigul | 0 | 0 | **0** |
| Assisted Broking | 0 | 0 | **0** |
| Mutual Fund | 0 | 0 | **0** |
| Partner Experience Desk | 0 | 0 | **0** |

**Not one published article in the whole account.** Bonanza's fourteen are all
drafts, sitting in Freshdesk's own sample structure — *Getting started with us*,
*Your account*, *Your documents*, *Files and folders*, *Premium club*, *Trial
FAQs* — with three drafts last edited **five years ago** ("Professional plan",
"Bulk downloading", "Business plan"). That is the out-of-the-box demo content,
never replaced.

So the two live portals let customers raise and track tickets, and offer them
nothing to self-serve with. Every question becomes a ticket, which is part of
why there are 34,442 of them.

**What this changes:** there is **no content to migrate**. Stage 3 below is
therefore a ticket-raising and tracking portal, not a content project — and a
knowledge base, if you want one, is a *new* capability rather than a
replacement. Five years of nobody writing one is also worth reading as a
signal about how much appetite there is to maintain it.

---

## 3 · What is broken, and why the queue is unworked

### The hourly rules fire on nothing

All six hourly-trigger rules report **"Impacted tickets (last 7 days): --"**:

| Rule | Firing |
|---|---|
| Automatically close resolved tickets after 48 hours | **0** |
| When a ticket has been overdue for a long time (Assisted Broking) | **0** |
| When a ticket has been overdue for a long time (Bigul) | **0** |
| Customer reminder (Waiting on Customer, 24h) | **0** |
| Algo Activation Pending over 2 hours | **0** |
| HR | **0** |

The page header explains it: *"Executes all matching rules for tickets updated
within 30 days."* The backlog is older than 30 days, so **every escalation and
auto-close rule is blind to exactly the tickets that need them**. The 33,705
overdue tickets are not being chased by anything, and never will be while they
sit untouched.

### 129 rules, most of them dead

78 on ticket creation, 45 on ticket update, 6 hourly. Of the first 30 creation
rules, 19 report zero impacted tickets in a week. The live ones are few:
Account Problems (1,291/week), Assisted Broking routing (623), Wealth (421),
Bigul (154), high-priority cases (97).

Three patterns in the rest, all familiar from the LeadSquared audit:

- **Rules named after people.** *"If Description contains Aditi Surve → assign
  to Aditi Surve"*, same for Sakshi Pundge, same for Afsara Shaikh — and
  Afsara's rule exists **twice** (rules 3 and 27). Routing is hardcoded to
  individuals, so it breaks the day somebody changes desk.
- **Personal email addresses inside automations.** Around fifteen rules
  (`DKYC-ESIGN-RELATED`, `SEGMENT ACTIVATION…`, `PAYMENT GATEWAY-REALTED`,
  `PARTNER DASHBORD-BACKEND-RELATED` and the rest) forward to named individuals
  — `mahesh.jannepalli@`, `shital.hande@`, `tripti.pal@` … When one of them
  leaves, the rule keeps forwarding into a dead mailbox and nobody is told.
- **Rules nobody has touched in years.** *"Lead Assignment → Mark as Spam and
  Close"* was last modified five years ago. Several are three and four years
  old. Typos are frozen into the names (`REALTED`, `DASHBORD`, `REACTIVTION`).

---

## 4 · What Freshdesk gives you that the CRM does not

Measured against the Cases module as it stands today:

| Freshdesk capability | In the CRM? |
|---|---|
| Ticket ref, subject, priority, category, status, channel | ✅ built |
| Linked to the lead, product card and partner | ✅ built — *and better: real links, not re-keyed text* |
| SLA: response + resolution targets, first-response stamp, breach flag | ✅ built |
| Business hours, per product + priority policies, versioned | ✅ built |
| Pause the clock while waiting on the customer | ✅ built |
| Merge, CSAT, assignment, AI summary | ✅ built |
| **Inbound email → ticket** (17 mailboxes, threading, DKIM) | ❌ **the big one** |
| **Customer self-service portal** (register, raise, track) | ❌ |
| **Knowledge base / FAQ** | ❌ |
| **Canned responses** and scenario macros | ❌ |
| **Groups with round-robin / load-balanced assignment** | ❌ (groups exist; auto-assign within them does not) |
| Per-group business hours | ❌ |
| CSAT surveys (beyond the score column) | ❌ |
| Widgets, Facebook, chat, phone channels | ❌ |

**The honest summary:** the ticket *model* and the SLA engine are already there
and are better connected than Freshdesk's. What is missing is the whole
customer-facing half — email in, portal, knowledge base — plus the agent
conveniences.

---

## 5 · The argument nobody has made yet: SEBI

Bonanza is a SEBI-regulated broker. Investor grievances carry statutory
timelines that no generic helpdesk knows about:

- The complaint goes first to the firm's **designated compliance / investor
  grievance officer**
- The firm must resolve it and file an **Action Taken Report within 21 calendar
  days**
- The investor may seek a **review within 15 days**; a revised ATR follows
  within 10
- Unresolved, it proceeds to **SCORES** and then **Smart ODR** — conciliation,
  mediation, arbitration

Today, `grievances@bonanzaonline.com` drops into a group with the same SLA as
everything else, in a system where the overdue rules fire on nothing. **That is
the strongest argument for building in-house** — and it is not about features:

- Our SLA engine already does business-hours countdowns, pause states, breach
  flags and versioned policies. A 21-day ATR clock is one more policy.
- Our tickets already link to the lead, the client, the product card and the
  partner. A regulator asking "show me everything about this complainant" is a
  record, not a search.
- The configuration audit log (non-negotiable 13) already records who changed
  what, which is the part an inspection actually asks for.

Freshdesk can be made to do this with custom fields and hope. The CRM can hold
it as schema.

---

## 6 · Recommendation

**Build it, in three stages, and do not switch anything off until stage 2 is
live.**

**Stage 1 — make the regulator safe (small).** A complaint record type with the
SEBI clock: 21-day ATR, 15-day review, 10-day revised ATR, the compliance
officer as a required role, SCORES/ODR reference fields. This is mostly SLA
policy configuration on an engine that exists. It is also the piece that is
genuinely risky to leave as it is.

**Stage 2 — take the email channel (the real work).** Inbound mail to ticket,
threading, the 17 mailboxes, and routing rules expressed as *data* — a table of
address → group → product → SLA — rather than 129 branches. This is what
actually replaces Freshdesk for the agents.

**Stage 3 — the customer-facing half.** The two live portals, per product: a
customer registers, raises a ticket and tracks it. Smaller than it first looked,
because there is no knowledge base to carry across — see section 2. Still the
biggest of the three, and still the place where Freshdesk has polish worth
respecting, so it is worth considering whether the portals stay on Freshdesk
for a while even after stages 1 and 2 land.

A knowledge base is a separate question from the migration. Nobody has written
one in five years, so I would not assume it is wanted; if it is, the ticket
data itself is the best possible source for what the first twenty articles
should say.

**What not to port:** the 129 rules. Of the live ones, almost all are
"keyword → group" or "address → group", which is a routing table the support
manager should own. The rules naming individuals should not survive migration
at all.

---

## 7 · What I need from you

1. ~~Does the knowledge base have real content?~~ **Answered by reading it:
   no. Zero published articles across all five portals.** Nothing to migrate.
2. **Is the LeadSquared ↔ Freshdesk integration live?** There is a
   `leadsquaredcheck` ticket field. If tickets are syncing to LSQ today, that
   link has to be re-pointed, not dropped.
3. **Who is the designated investor grievance officer**, and what is the
   current process when something arrives at `grievances@`? I want to model
   what you actually do, not what I assume.
4. **Six mailboxes need re-authorising** — separately from any of this. Worth
   someone checking today whether NRI desk, PMS customer care and Advantage
   mail is reaching anybody.
5. **HR and IT Support are in here too.** Internal staff tickets on the
   customer helpdesk. Do they come across, or do they stay behind?

---

*Read only. Nothing in Freshdesk was created, modified or deleted.*
