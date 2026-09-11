# Outstanding — what is not done, across all three feedback rounds

**Compiled:** 9 September 2026, from the three source documents now in this folder.
**Method:** every ticket ID cross-referenced against git history and the code. Where
the evidence is a commit message rather than a re-test, that is said.

The three source documents are checked in beside this one:

| Round | Source | Items |
|---|---|---|
| 1 | `ROUND-1-source.md` | 43 |
| 2 | `ROUND-2-source.md` | 25 |
| 3 | `ROUND-3-source.md` | 44 |

---

## 0 · One ticket is mislabelled, and it is mine

**`P3-19` in the source document is *LAPPS — scriptable custom app framework*.**

Commit `56de104` is titled *"P3-19: hand a book over when somebody leaves"*. That
work — bulk reassignment of a departing RM's book — appears in **none** of the
three feedback documents. It was asked for in conversation and given the label
P3-19, and I built it under that label without checking the number against the
document.

So:

- the handover feature is **built and working**, but it is not P3-19
- **the real P3-19 (LAPPS) is not started**

**Resolved 9 Sep:** the handover work takes its own ID, **`OPS-01`**, outside the
feedback numbering. `P3-19` means LAPPS and nothing else. Commit `56de104` keeps
its title — rewriting a pushed commit message would be worse than a footnote —
and this table is the mapping.

| Label | Means |
|---|---|
| `P3-19` | LAPPS — scriptable custom app framework. **Dropped 10 Sep** in favour of building the native features the LAPPs in use are compensating for. |
| `OPS-01` | Hand a book over when somebody leaves. Built, commit `56de104`. |
| `OPS-02` | Automations that run on a **client** rather than a lead. Opened 10 Sep out of A1 — see `P3-16-automation-design.md`. **Not started; needs scoping.** |

---

## 1 · Round 1 — nothing outstanding

All 43 items are recorded Done in `docs/FEEDBACK-ROUND-1.md`. That is a status
document maintained as the work was done, not an independent re-test.

---

## 2 · Round 2 — four outstanding, all waiting on someone else

| ID | Title | Status | Waiting on |
|---|---|---|---|
| P2-03 | UAT and Production with promote/rollback | **Not started** | Production does not exist. Standing it up is infrastructure work that comes first (your decision, A-5) |
| P2-14 | Connectors screen (Facebook, Google, CUBE, Smartping) | **Not started** | A-4 — which vendor accounts and credentials are available. *Partly answered 10 Sep: all four are in scope, in the order Meta → CUBE → SMS → Google, and SMS is **more than one gateway, split by book** — Bonanza and Bigul send through different ones, so that connector is book-scoped exactly as the DLT headers are. Still needed: the gateway names, and who owns each vendor account.* |
| P2-23 | Adapters and vendor endpoints | **Not started** | Same as P2-14 |
| P2-25 | Outlook configuration from Setup | **Not started** | A-3 — SMTP was chosen first; per-user Outlook waits on Compliance ruling on Graph |

**These four are one piece of work, not four.** P2-14, P2-23, P2-25 and the
Round 3 ticket P3-20 all describe the same connectors surface from different
angles. Building them separately would produce four screens for one job.

---

## 3 · Round 3 — eight outstanding

### 3a · Blocked on the CUBE credential

| ID | Title | Blocked by |
|---|---|---|
| P3-44 | CUBE telephony end-to-end verification (`Bonanza_APITest`) | The tenant UserID and password |
| P3-13 | Phone call form (configurable disposition form) | P3-44 |
| P3-14 | Call recording, transcription and AI call summary | P3-44, P3-13 |

P3-44 is the verification that the pipeline works at all. Until a call can be
placed through CUBE and a recording come back, P3-13 and P3-14 cannot be
honestly built or tested.

### 3b · The five large builds — none started, each gated on your approval

Every one of these has a "present the design before implementation" clause, and
each has an unanswered open question against it. That is why none is started.

| ID | Title | Gate | Open question |
|---|---|---|---|
| P3-06 | Reports module — predefined library + custom builder | Module design and the predefined report list approved before build | **Q9** |
| P3-16 | Advanced automation builder | Builder design presented before implementation | **Q10** |
| P3-19 | LAPPS — scriptable custom app framework | Feasibility assessment — value, security model, sandbox — before *any* build | **Q11** |
| P3-20 | Apps marketplace / connectors | Feasibility assessment naming which connectors are viable this phase | **Q12** |
| P3-21 | Internal communication module | Module design reviewed before implementation | **Scoped 11 Sep — option C, three phases (~24 days).** Decisions recorded in `P3-21-internal-comms-design.md`. Open, not blocking phase 1: what a lead escalation means; message retention (compliance officer). |

These are the largest items in the document. P3-06 and P3-16 in particular are
each comparable in size to everything delivered in Round 1.

### 3c · Built, awaiting your sign-off

| ID | Title | State |
|---|---|---|
| P3-40 | Lead Details layout and UI rework | Built and committed (`5642968`). **10 Sep — Ritesh wants to look again before signing off.** Pointed at the live screen rather than at another image. |

---

## 4 · Acceptance clauses I cannot confirm I met

These tickets have working code and a commit, **and** an acceptance bullet
requiring something to be sent to you. My earlier context was compacted, so I
cannot tell from the repo whether the deliverable actually reached you. Each is
a one-message deliverable, not a rebuild.

| ID | The clause | Sent? |
|---|---|---|
| P3-28 | "A list of every AI summary button and the action it now performs is shared with me for review" | Unverified |
| P3-29 | "Every other action button on the Lead Details page has been retested for the same class of defect, and the results are reported back to me" | Unverified |
| P3-02 | "The field set has been benchmarked against LeadSquared and Salesforce, and the proposed list has been shared with me before implementation" | Unverified |
| P3-03 | "The proposed field list has been shared with me for confirmation before it is built" | Commit `102d42d` is titled *"P3-03 + your four answers"*, so something was agreed — but not what |
| P3-26 | "A list of screens audited and fixed is shared with me" | Unverified |
| P3-27 | "Propose what should occupy the reclaimed space before building it" | Unverified |
| P3-07 | "The proposed hierarchy model is reviewed with me before implementation" | Partly — you corrected the example roles and asked for a configurable tree; whether a model was formally reviewed is unclear |
| P3-38 | "Confirm the mandatory list with me before building" | Unverified |
| P3-17 | "The proposed structure for the Email and SMS builders is shared with me before implementation" | **Yes** — shared, and you replied "start with WhatsApp and share the email/sms structure" |
| P3-40 | "A design preview is shared with me before the change is finalised" | **Yes** — shared, awaiting sign-off |

**All ten are now produced in `DELIVERABLES.md`, in this folder.** Three of the
questions above turned out to carry your decision in the code itself (Q2 in
`db.js`, Q5 in `location.js`, Q7 in `columns.js`), so those reached you at the
time. Two did not — see below.

---

## 5 · Open questions still unanswered

From `ROUND-3-source.md`, the twelve questions that were to be answered before
the affected tickets are built.

**Answered 10 September:**

| # | Ticket | Answer |
|---|---|---|
| Q10 | P3-16 | **Approved as built, with changes to come.** The ticket stays open until Ritesh lists the corrections. |
| Q11 | P3-19 | **Drop LAPPS.** Build the missing native features instead. Still needs `N-3a` to know which features those are. |
| Q12 | P3-20 | **All four connectors in scope** — Meta, CUBE, the SMS gateway, Google — built in that order. Still needs `A-4`, and which SMS gateway is actually live. |
| A3 | P3-16 | **Clean start, then port ten flows.** The list, and why "the top ten by execution count" is the wrong ten, is in `P3-16-automation-design.md` §8. |
| A6 | P3-16 | **Leads with a task due today or earlier.** Built and shipped — see the same document. |

**Still outstanding — this one gates the last large build:**

| # | Ticket | Question |
|---|---|---|
| Q9 | P3-06 | Approve the predefined report list and the module design before build — blocked behind `N-4a` |

**Answered during the work:**

| # | Ticket | Answer given |
|---|---|---|
| Q3 | P3-07 | The example roles do not exist at Bonanza; build a configurable tree with branches under Bonanza and Bigul |
| Q4 | P3-09 | Close an abandoned session at last recorded activity |

**Resolved by reading the code — your decision is recorded in it:**

| # | Ticket | Question |
|---|---|---|
| Q1 | P3-01 / P3-22 | Answered by the build — one Audit Log screen carries both filters and export |
| Q2 | P3-02 / P3-03 | `db.js` — "benchmarked against the LeadSquared user grid and the Salesforce User object, confirmed by Ritesh on 4 Sep" |
| Q5 | P3-10 | `location.js` — "Ritesh settled this on 4 Sep: the activity saves regardless" |
| Q7 | P3-38 | `columns.js` — "Ritesh settled the mandatory set on 4 Sep: the lead's name and nothing else" |

**Still mine rather than yours — these two need ratifying:**

| # | Ticket | What I decided without you |
|---|---|---|
| Q6 | P3-28 | The action behind each AI summary button |
| Q8 | P3-27 | The three tiles that replaced the homepage activity log |

Both are described in `DELIVERABLES.md`. The code shipped on my judgement where
the ticket asked for yours.

---

## 6 · The whole outstanding list, in one place

| # | ID | Title | Round | Why not done |
|---|---|---|---|---|
| 1 | P3-44 | CUBE end-to-end verification | 3 | Credential |
| 2 | P3-13 | Phone call form | 3 | Blocked by P3-44 |
| 3 | P3-14 | Recording, transcription, AI summary | 3 | Blocked by P3-44 |
| 4 | P3-06 | Reports module | 3 | Design approval — Q9 |
| 5 | P3-16 | Automation builder | 3 | Design approval — Q10 |
| 6 | P3-19 | LAPPS | 3 | Feasibility approval — Q11 |
| 7 | P3-20 | Connectors marketplace | 3 | Scope confirmation — Q12 |
| 8 | P3-21 | Internal communication | 3 | Design review |
| 9 | P2-03 | UAT / Production | 2 | Production does not exist |
| 10 | P2-14 | Connectors screen | 2 | Vendor accounts — A-4. Same work as #7 |
| 11 | P2-23 | Adapters and vendor endpoints | 2 | Same work as #7 |
| 12 | P2-25 | Outlook configuration | 2 | A-3 / Compliance |

Plus **P3-40** awaiting sign-off, and the ten acceptance clauses in section 4.

**Deduplicated, that is nine distinct pieces of work**, because #7, #10 and #11
are one connectors build and #12 sits beside them.

---

## 6b · Decided on 10 September, and now waiting on me

Fifteen of the twenty-seven open points were answered on 10 September. Ten of
those answers turned into work that nobody is blocked on any more.

**Agreed to start first — small, one pass:**

| Item | Work |
|---|---|
| `N-8` | A Back button on every Setup screen, top-level included |
| `Q6a` | "Request a Product RM" notifies that RM — in-app plus SMS, and not on the client's timeline |
| `A1` (tickets) | `ticket.created`, `ticket.sla_breached`, `ticket.resolved`, `ticket.changed` |
| `N-9` | All sixteen Lead Details buttons click-tested, folded into the same browser session |

**Then, in no fixed order yet:**

| Item | Work | Size |
|---|---|---|
| `Q8a` | A Sales Head tile set for the homepage — I propose it, Ritesh confirms | **Done** — `60cb5be`, corrected `c962c1d` |
| `N-7a` | Group membership grants visibility, on top of the manager chain. Touches the access floor. | **Done** — `b5ad96b` |
| `A3` | Port the ten flows in `P3-16-automation-design.md` §8 | Needs the definitions out of LeadSquared |
| `P3-21` | Internal communication — option C, phase 1 first (option B's scope) | Phase 1 ~9 days; phases 2–3 ~15 more |
| `OPS-02` | Automations that run on a client rather than a lead | Large; needs scoping |
| `Q10` | Corrections to the automation builder | Unknown until named |

**Still blocked on someone else:** `P3-06` behind `N-4a`, the connectors behind
`A-4`, and the three CUBE tickets behind `N-6`.

---

## 7 · Questions I need answered

| # | Question |
|---|---|
| ~~N-1~~ | **Resolved** — handover is `OPS-01`; `P3-19` stays LAPPS. |
| **N-2** | Of the ten acceptance clauses in section 4, which did you actually receive? I will re-send any you did not. |
| **N-3** | Q6 and Q8 shipped on my judgement where the ticket asked for yours. Ratify or correct them — both are in `DELIVERABLES.md`. Q1, Q2, Q5 and Q7 are resolved. |
| ~~N-7 / N-7a~~ | **Answered 10 Sep — yes.** There are supervisors outside the reporting line, so group membership must grant visibility on top of the manager chain. Work item against P3-07. |
| ~~N-8~~ | **Answered 10 Sep — everywhere in Setup**, top-level screens included. Ritesh chose consistency over the narrower recommendation. |
| ~~N-9~~ | **Answered 10 Sep — yes**, folded into the next browser session rather than run as a standalone task. |
| ~~N-4~~ | **Resolved** — order approved: automation, then connectors, then reports, then internal comms, with LAPPS challenged. `P3-16-automation-design.md` is with you for approval. |
| ~~N-5~~ | **Resolved** — one connectors build, absorbing P2-14, P2-23, P2-25 and P3-20. |
| **N-6** | Are the CUBE tenant credentials available yet? Three tickets sit behind them. |
