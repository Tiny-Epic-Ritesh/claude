# Cross-book data exposure — findings, exposure window and remediation

**System:** Bonanza AI CRM (internal replacement for LeadSquared)
**Environment affected:** UAT
**Found:** 30 August 2026, during a scheduled debugging pass
**Remediated:** 30 August 2026, commit `e725599`; two further routes 31 August 2026
**Amended:** 31 August 2026 — four more affected routes found: F-11, F-12 (record)
and F-13, F-14 (list)
**Author:** Ritesh Thakur (development), with Claude
**Status:** **Remediated in code. Impact assessment incomplete — see §6.**

> **This document is not yet complete and should not be circulated as a
> closed matter.** The technical findings and the fix are established and
> verified. What is *not* established is whether anyone actually read another
> book's records during the exposure window, and the application cannot answer
> that on its own. §6 lists exactly what must be determined and by whom.
>
> Ritesh has confirmed that **real client records have been present in the UAT
> database**. That makes this an exposure incident rather than a pre-production
> review finding, and Compliance should see it before any external party does.

---

## 1. Summary in one paragraph

The CRM separates two businesses — Bonanza (full-service) and Bigul (discount)
— and a user in one must not see the other's records. **Thirteen routes did not
enforce that.**

Eleven were record routes: they loaded a record by id and returned it without
checking which business owned it, so any authenticated user who knew or guessed
an id could read the other book's tickets, saved lists, partner book,
product-card history, lead next-action briefings and KYC journeys. One went
further and allowed a **write** — a Bigul supervisor could approve a bulk
reassignment of Bonanza leads.

Two more were **list** routes, which had been assumed safe: `/api/tasks`
returned every task in the system, and `/api/tickets` the whole case queue,
each carrying the client's name.

All thirteen are fixed, with regression tests confirmed to fail against the
unfixed code.

**How each was found matters, because it says what to trust.** Nine were found
by hand on 30 August. Two more on 31 August by a conformance test that
enumerates record routes from the source — written precisely because finding
them by hand had already proved unreliable, and it found both within seconds.
The last two were list routes: one surfaced because a dashboard figure would
not reconcile with its own drill-through, the other once that same test was
extended to cover lists. **Manual review found nine of thirteen and then
stopped finding them; the tests found the remaining four.**

## 2. What an attacker needed

| Requirement | Detail |
|---|---|
| A valid CRM login | **Yes.** None of these were reachable unauthenticated. The exposed population is people who held a working UAT account. |
| Knowledge of a record id | Sequential integers. `/api/tickets/1`, `/api/tickets/2` … enumeration is trivial. |
| Any special tooling | No. A browser address bar or `curl` with the session token. |
| Elevated permissions | For most findings, no. Three findings additionally required a capability (`partner.view`) that Admin, Partner RM and Sales Supervisor hold — and those roles exist in **both** businesses, which is precisely why the capability check did not substitute for a book check. |

This is **cross-tenant privilege escalation by an authenticated user**, not an
anonymous internet-facing data breach. That distinction matters for severity
and it should not be lost when this is summarised.

## 3. Findings

Severity is stated in plain terms with the reasoning, rather than a CVSS score
this assessment is not in a position to defend.

### F-01 — KYC journey exposed the applicant's resume token · **Critical**

`GET /api/kyc/journeys/:id` returned the full journey record for any id,
including `resume_token`, the applicant's mobile and their email.

`resume_token` is a **bearer credential for the public DKYC portal** — the
value an applicant uses to re-enter their own part-completed account opening
without signing in. Handing it across the book boundary converts an
authenticated internal read into potential control of a stranger's KYC
application: their identity documents, bank details and e-sign step.

This is the only finding that escalates outside the authenticated CRM.

### F-02 — Approvals could be decided across the boundary · **Critical**

The approvals engine gated decisions on capability and self-approval, but never
on business. Demonstrated during the investigation: a **Bigul sales supervisor
saw a pending Bonanza request in their queue with `can_decide: true`, and
`decide()` honoured it.** The scope proven was `bulk_reassign` — moving a book
of Bonanza leads to a different owner.

The only finding permitting a **write** to the other book. Four surfaces were
affected: `queueFor` (the queue), `byId` (the detail), `history` (per record)
and `decide` (the action itself).

### F-03 — `orgsFor()` failed open to Bonanza · **High**

The function resolving which businesses a user may see defaulted a **missing**
`sales_org` to `'BONANZA'`. Two call sites constructed partial user objects
from an id and a capability set; both were silently granted the larger book.

This is the root cause behind F-02 surviving a first remediation attempt, and
it is the most important line in this document for anyone reviewing the
codebase: a security boundary defaulted to *access* rather than to *nothing*.
It now returns an empty set, which makes the scope SQL fail closed.

### F-04 — Service tickets readable across books · **High**

`GET /api/tickets/:id` returned the full ticket for any id. Ticket bodies carry
free-text case notes — a client describing a failed SIP debit, a login problem,
a complaint — in their own words, alongside the linked lead's name and mobile.
The most directly client-identifying of the read findings.

### F-05 — Saved lists shared by role crossed the firm · **High**

`mayReadList()` checked ownership and `shared_with`, which holds **role names**.
A role name says nothing about which business its holder is in, so a Bonanza
list shared with `sales_rm` was readable by every sales RM in the firm, Bigul
included. The check was missing from all **11** call sites, which included the
write, refresh and delete paths, not only the read.

### F-06 — Partner book and partner report readable across books · **High**

`GET /api/partners`, `GET /api/partners/:id` and `GET /api/reports/partners`
had no business filter at all. A Bigul supervisor could list every Bonanza
partner with their partner code, commercial state and commission totals.

Notably, an earlier probe in the same investigation reported these as clean —
because it used a Bigul *sales RM*, who lacks `partner.view` and was refused on
the capability. The capability check masked the missing book check. Probes must
use a role that actually holds the capability, or they prove nothing.

### F-07 — Product-card state history readable across books · **Medium**

`GET /api/cards/:id/audit` had no scoping. `card_audit` carries no owner and no
business of its own — it hangs off the card, which hangs off the lead — so the
join was simply never written. Exposed state transitions, timestamps, free-text
notes and the **names of staff** who made each change.

The sibling route `/api/cards/:id/detail` was correctly scoped. One of a pair
was missed.

### F-08 — Lead next-action briefing readable across books · **Medium**

`GET /api/ai/leads/:id/next-action` assembled its advice from the lead's open
tickets, product cards and KYC state. The response described the record about
as thoroughly as the record itself: lead name, ticket references, KYC progress
and suggested talking points.

### F-09 — Lead name via market context · **Low**

`GET /api/market/context/:leadId` returned the lead's name alongside index
levels. Small surface, same root cause; the name is the part that was not ours
to hand over.

### F-11 — Partner insight readable across books · **High**

`GET /api/partners/:id/insight` had no business filter. The sibling route
`GET /api/partners/:id` was fixed on 30 August and this one was not — the same
"one of a pair" slip as F-07.

The insight names the partner and summarises their sourcing volume and accrued
commission, so it gives away most of what the record itself holds.

### F-12 — KYC coaching readable across books · **Medium**

`GET /api/kyc/journeys/:id/coach` had no business filter, for the same reason:
`/journeys/:id` was fixed and its sibling was not. The response quotes the
applicant's stalled step and the words to say to them, so it describes the
journey without returning the record.

Unlike F-01 it does not expose `resume_token`.

**Both were found by the conformance test, not by review.** Two rounds of manual
probing had already gone over these routes and missed them, which is the
argument for the test rather than for more care.

### F-13, F-14 — Two list routes, found 31 August · **High**

`GET /api/tasks` had no lead scope at all. With `all=true` a Bigul supervisor
was returned every task in the system — forty of them on Bonanza leads, each
labelled with that client name. `GET /api/tickets` likewise returned the other
book: subject, description, and the client name and mobile joined in.

**Both are the same shape as F-06, F-07, F-11 and F-12: one of a pair fixed.**
`/tickets/:id` was scoped on 30 August and the list beside it was not.

Neither was found by review. The tasks one surfaced because a dashboard figure
would not reconcile with its own drill-through; the tickets one because the
conformance test was then extended to cover list routes.

**Why they were missed for a week:** the 30 August work scoped record routes and
built a conformance test for record routes. List routes were assumed already
filtered, on the strength of a probe that checked leads, lists and approvals —
and stopped there. The assumption was never written down as a test, so nothing
challenged it.

`test/bookscope.test.mjs` now requires every list route to be classified too,
and probes each classified one across the boundary on every run.

### F-10 — The test suite was asserting the defect · **Process finding**

`server/test/approvals.test.mjs` selected its fixture partner with
`SELECT id FROM partners LIMIT 1` and no `ORDER BY`. SQLite returned a **Bigul**
partner, and the suite then had a **Bonanza admin** approve commission changes
to it — the exact cross-book decision F-02 describes. Every assertion passed,
because nothing checked.

This is recorded deliberately. For seven days the suite reported green while
encoding the defect as expected behaviour, so "the tests pass" carried less
assurance than it appeared to. It has been pinned to one book, and a separate
test now proves the boundary.

---

## 4. Exposure window

| Event | Commit | Date |
|---|---|---|
| Vulnerable routes introduced | `81504d8` | 23 Aug 2026, 00:18 IST |
| First deployment commits | `838e9cf`, `37d7dff` | 24 Aug 2026 |
| Remediation pushed | `e725599` | 30 Aug 2026, 23:15 IST |

**Working window: 24 – 30 August 2026, approximately seven days.**

All eleven routes date to the initial platform commit; none were introduced by
a later change. F-11 and F-12 were live one day longer than the rest — until
31 August — because the 30 August remediation missed them. The window opens at deployment rather than at commit, and the
**exact deploy timestamps still need confirming from the GitHub Actions run
history** — the `gh` CLI was not available on the development machine, so this
was read from commit dates rather than from deploy records.

The window may be shorter in practice if real client data entered UAT after
24 August. **That date is not yet established** (§6).

## 5. What we can and cannot evidence

This section matters more than the findings list, and it should not be softened.

### The application does not log reads

There is **no HTTP request logging** in the server. `audit()` has 79 call sites
and every one records a *write* — `lead_updated`, `approval_granted`,
`campaign_created`. **A cross-book read leaves no trace in the application at
all.** For F-01, F-04 through F-09 the CRM cannot say whether anyone did this.

### Three evidence sources do exist

| Source | Covers | Where |
|---|---|---|
| `audit_log` where `action IN ('approval_granted','approval_rejected')` | F-02 — the only cross-book **write** path | UAT database |
| `audit_log` where `action = 'pii_unmasked'` | Any deliberate PII unmask, with the request path recorded in `detail` | UAT database |
| nginx access logs | Every request path, if retained for the window — **the only source that can evidence plain reads** | UAT host |

Queries for the first two are in §7. The third is a request to whoever
administers the UAT host; **retention should be checked before anything rotates
them out.** That is time-sensitive and is the single most useful action
available right now.

## 6. What must still be established

Remediation is done. Impact assessment is not. None of the following can be
answered from the source repository.

| # | Question | Owner |
|---|---|---|
| 1 | **When did real client records first enter the UAT database, and how many?** Determines whether the window is seven days or shorter, and the size of the affected population. | Ritesh |
| 2 | **Are nginx access logs retained for 24–30 August?** The only way to evidence reads. Preserve them now. | UAT host administrator |
| 3 | **Which accounts held working UAT logins during the window, and which businesses were they in?** A single-business user population would sharply narrow exposure. | Ritesh |
| 4 | **Was the UAT host reachable from the public internet, or LAN/VPN only?** It sits behind Cloudflare, which suggests internet-reachable; that should be confirmed rather than assumed. | IT |
| 5 | **Do the audit queries in §7 return anything?** A definitive answer for the write path and for PII unmasking. | Ritesh |
| 6 | **Does this meet a notification threshold under SEBI or DPDP?** A judgement for Compliance, not for engineering. | Compliance |

## 7. Queries to run against the UAT database

Read-only. Run on the UAT copy, not on a reseeded development database — the
development database has been reseeded repeatedly and holds none of this.

```sql
-- (a) F-02: was any approval ever decided across the book boundary?
-- Empty result = the write path was never exploited.
SELECT a.id, a.scope, a.entity, a.entity_id, a.status,
       a.decided_at, u.email AS decided_by, u.sales_org AS decider_org,
       COALESCE(p.sales_org, l.sales_org) AS record_org
  FROM approvals a
  JOIN users u ON u.id = a.decided_by
  LEFT JOIN partners p ON a.entity = 'partner' AND p.id = a.entity_id
  LEFT JOIN leads    l ON a.entity = 'lead'    AND l.id = a.entity_id
 WHERE a.decided_by IS NOT NULL
   AND COALESCE(p.sales_org, l.sales_org) IS NOT NULL
   AND u.sales_org <> COALESCE(p.sales_org, l.sales_org);
```

```sql
-- (b) Every deliberate PII unmask in the window, with who and what.
-- Cross-check decider_org against the record's business by hand.
SELECT al.created_at, u.email, u.sales_org, al.entity, al.entity_id, al.detail
  FROM audit_log al
  JOIN users u ON u.id = al.user_id
 WHERE al.action = 'pii_unmasked'
   AND al.created_at BETWEEN '2026-08-24' AND '2026-08-31'
 ORDER BY al.created_at;
```

```sql
-- (c) Who actually signed in during the window, and from which business.
-- Sessions expire after 12 hours; rows survive only if nothing has pruned
-- them, so run this FIRST — it is the most perishable evidence in the database.
SELECT s.created_at AS signed_in_at, s.last_seen_at,
       u.email, u.role, u.sales_org
  FROM sessions s
  JOIN users u ON u.id = s.user_id
 WHERE s.created_at BETWEEN '2026-08-24' AND '2026-08-31'
 ORDER BY s.created_at;
```

```sql
-- (d) If (c) returns nothing because sessions were pruned, fall back to the
-- full account list: everyone who could have held a login in the window.
SELECT id, email, role, sales_org, active, created_at
  FROM users
 ORDER BY sales_org, role;
```

For nginx, the cross-book reads would appear as requests to these paths from a
session belonging to the other business. Path patterns worth grepping:

```
/api/kyc/journeys/    /api/tickets/    /api/lists/
/api/partners/        /api/cards/      /api/ai/leads/
/api/market/context/  /api/approvals/  /api/reports/partners
```

## 8. Remediation and how it was verified

**Commit `e725599` — "Hold the book boundary on record routes".**

| Finding | Change |
|---|---|
| F-01 | Journey scoped through its lead; refusal returns no token |
| F-02 | `orgOf()` derives the business from the record the request is about; `queueFor`, `byId`, `history` and `decide` all scoped |
| F-03 | `orgsFor()` returns an empty set for a missing `sales_org`; both stub call sites now pass the whole user |
| F-04 | `mayUseOrg` check on `ticket.sales_org` |
| F-05 | Book check moved into `mayReadList()` **before** ownership and sharing, covering all 11 call sites at once |
| F-06 | Business filter on the partner list, detail and report |
| F-07 | Same scope as the sibling `/detail` route |
| F-08, F-09 | Lead-scope check before the record is loaded |
| F-11 | Business check on the partner, matching `/partners/:id` |
| F-12 | Lead-scope check on the journey, matching `/journeys/:id` |

Design note on F-02: the business is **derived** from the record rather than
copied onto the `approvals` table. A copied column drifts from its source; a
derived one cannot. It fails closed for any entity type with no mapping, so a
future approval scope over a new entity breaks visibly instead of quietly
becoming readable across both books.

### Verification

- **The regression tests were run against the unfixed code first.** Five of six
  failed as intended. The sixth passed for the wrong reason — it had picked a
  list shared with nobody, so the refusal proved nothing — and was re-pinned to
  a list actually shared with the reader's role.
- A 27-record cross-book probe covering every record route: **12 leaks before,
  0 after.**
- New coverage: e2e suites 49 and 50, plus a boundary test in
  `approvals.test.mjs`.
- Full suite green: **684 checks** — 461 end-to-end, 223 unit.

### Two caveats on that verification

1. The probe and the tests use the **seeded development dataset**. They prove
   the code refuses correctly; they say nothing about what happened on UAT.
2. Two earlier passes of this same investigation produced **false positives** —
   one probe treated a Bigul record as a Bonanza one, another truncated a
   templated URL and reported a 404 that did not exist. Both were caught and
   corrected before this document was written, but they are the reason every
   finding here was re-verified against database ownership rather than against
   an API response.

## 9. Recommendations

1. **Preserve the UAT nginx logs now**, before rotation. Time-sensitive, and
   nothing else can evidence reads.
2. ~~**Add request logging** before production.~~ **Done, 31 August.**
   `engine/accesslog.js` records every API request — who, which business,
   method, full path, status, duration, IP — with no request bodies and no query
   strings, kept 90 days. `GET /api/admin/access-log/cross-book` answers the
   question this incident could not, and Admin can ask "who read this record"
   and "what did this person touch" directly.

   **It does not close §6.** The log starts from 31 August; the exposure window
   is 24–30 August, and nothing was recording reads then. The nginx logs remain
   the only possible evidence for that period.
3. ~~**Make the boundary structural, not per-route.**~~ **Done, 31 August.**
   Eleven routes each needed the same check remembered independently, and eleven
   times it was not. There are now two things instead of the reminder:
   `engine/bookscope.js` gives a new record route a one-line safe path, and
   `test/bookscope.test.mjs` reads every parameterised route out of the source
   and requires each to be declared either as a record route — in which case the
   boundary is probed live on every build — or as something else, with a reason.
   A new record route that skips the check fails the build whether or not its
   author used the accessor. This is what found F-11 and F-12.
4. **Treat a missing scope as no access, everywhere.** F-03 is the pattern to
   hunt for elsewhere in the codebase.
5. **Do not treat a green suite as assurance of a boundary that has no test.**
   F-10 is the caution.
6. **Complete §6 before the VAPT engagement**, so the external testers are
   told what is already known rather than rediscovering it.

---

*Findings and fix verified 30 August 2026. Impact assessment open.*
