# Round 4 QA handoff — working checklist

**What this tracks:** the independent QA handoff of 1 October 2026
(`BONANZA_AI_CRM_QA_HANDOFF_2026-10-01.md` and its evidence zip), point by
point, plus the work in flight beside it.

**Checked against the code on 18 November 2026** (commit `d56bbf2`):

- The handoff Ritesh re-sent on 18 Nov is the report already kept here as
  [ROUND-4-source.md](ROUND-4-source.md), word for word (the repo copy only
  adds a 26-line reading note at the top). The zip is
  [ROUND-4-evidence/](ROUND-4-evidence/): all 114 files identical by SHA-256.
  Nothing in it was missing from the repo.
- The full test suite passes: unit tests 0 failures, end-to-end 632/632.
- GitHub Actions run #296 deployed the last October build (`5019787`, 16 Oct)
  to UAT, and it succeeded. So every fix struck out below is on labs, as far
  as GitHub can show. **I cannot see labs.tinyepic.in from this session.**
- Per-ID detail, with the reasoning behind each fix, stays in
  [ROUND-4-TRIAGE.md](ROUND-4-TRIAGE.md).

**How to read it — proposed, waiting on Ritesh's confirmation:**

- `[x]` ~~struck through~~ = fixed in code, and an automated test for it
  passes on 18 Nov.
- *Your retest* is blank until you re-run the auditor's reproduction on labs
  and tell me it holds (the report's §7 retest gate). Then it gets ✅.
- `[ ]` = not done. `[~]` = done in code but not yet on GitHub/labs.
- Nothing is struck on a visible button alone (the report's §6, step 8).

---

## A · Pending — my work, in proposed priority order

The order is a proposal. Tell me if you want it changed.

| # | Item | From the report | State |
|---|---|---|---|
| A1 | `[~]` **OPS-46** — typed times saved 5½ h late; the office calendar ran on UTC | Not in the report (found 16 Oct, Part 4 item 8.4) | Fixed and tested, commit `d56bbf2`. **Not on GitHub yet:** the push from this session was refused (403). |
| A2 | `[ ]` **The P0 permission gate** — direct API allow/deny tests for all 11 internal roles and the partner role, in both businesses, covering allowed, denied, masked and exported values. Includes `N-12`: put every POST and PATCH route that takes a record id under the business-boundary test, then fix what that finds | §1 "P0: 11 roles and API-enforced permissions"; §5 "direct API negative tests"; §6 steps 1 and 7 | Not started. The largest open item. |
| A3 | `[ ]` **OPS-47 to OPS-54** — find the eight unrecorded defects again, write each down, fix each in its own commit | Not in the report | Not started. They were never written down, so what is found may not be the same eight. |
| A4 | `[ ]` **QA-10** (P1) — the call panel: opaque, scrolls, End call always visible, actions that follow the call's state, both themes | §2 QA-10; Part 4 item 9 | Not started. Ruled 15 Oct: keep the panel and redesign it. Waiting on B6. |
| A5 | `[ ]` **BRD gate checks the auditor could not run** — (a) the 60-second Product RM notification after a Warm handoff; (b) DKYC step timers, abandonment, and a Product Supervisor's override written with a reason and audited; (c) SLA sweep, reopen by a portal reply, CSAT submission, a case with more than 50 messages; (d) a Caller's and a Dealer's full disposition through to the Sales RM handoff; (e) a partner's full activation — eight steps, a separate Admin approval, portal sign-in | §1 P1–P4; §5 | Not started. The real dialler's 90 s / 120 s timing is blocked on the CUBE credential (B12). |
| A6 | `[ ]` **Pilot gates, with evidence** — credential hashing, session expiry and revocation, server-side authorisation, partner isolation, KYC document encryption and retention, consent and DND, India residency, the pilot database, response time and availability: a write-up and an automated test for each | §1 last paragraph; §6 step 9 | Not started as an evidence exercise. Some exist in code (passwords hashed, PAN encrypted). The database gate waits on B7. |
| A7 | `[ ]` **QA-14** (P2) — Pipeline: choose several products; quick filters in each stage by name or mobile, owner, days in stage, last contacted | §3 QA-14; Part 4 items 10–11 | Not started. Filters ruled 15 Oct. |
| A8 | `[ ]` **QA-16** (P2) — custom report builder and dashboard creation (`P3-06`, `P2-17`) | §3 QA-16 | Not started. Design approved 15 Oct: [QA-16-REPORTS-DESIGN.md](QA-16-REPORTS-DESIGN.md), built in the order of its §6. The largest build. |
| A9 | `[ ]` **What the auditor could not confirm from earlier rounds** — check each, then fix what is missing: (a) `P3-10` geolocation: the stored activity's location and the denied-permission path; (b) `P3-18` Meta: account, page and permission management, notification and report controls; (c) `P3-33/34/41` import: the four-step upload and mapping route, and its updated-count behaviour; the Data Tools CSV path does not update duplicates; (d) Round 1 login alignment and dark-mode contrast, Part 2 chart types, Part 3 AI summary buttons; (e) a click-test of every button on the 28 Setup screens | §4 | Not started. `P3-07` is a question for you (B11). |
| A10 | `[ ]` **Before/after evidence for each fix** — screen, role, business, URL, local date and time, record id | §6 "Minimum test evidence" | Partly. Batch one, QA-07, QA-15 and Part 4 have screens in [ROUND-4-fix-evidence/](ROUND-4-fix-evidence/); the rest have tests only. |
| A11 | `[x]` ~~Correct the stale lines in ROUND-4-TRIAGE.md~~ — the counts paragraph still said 5 open, and the deploy row said "pending deploy" | — | Done with this checklist. |

---

## B · Needs your confirmation, decision or action

Nothing here is built or changed until you answer.

| # | What is needed | Why | Type |
|---|---|---|---|
| B1 | `[ ]` **Retest on labs.** P0s first: QA-01, 02, 03, 33. Then QA-28, 30, 32, 34, 36, as the report orders them. Then the rest. | §7 retest gate. Every fix is in code, tested, and deployed per GitHub. Nobody has re-run the auditor's reproductions. | Your action |
| B2 | `[ ]` **Close QA-02's old duplicate tasks on labs.** Actions → "QA-02 duplicate-task cleanup (labs)" → Run workflow. Leave *Apply* unticked to preview; tick it to close them. The database is snapshotted first. | GitHub shows this workflow has **never been run**, so the 10,477 duplicates the auditor counted are presumably still there. | Your action |
| B3 | `[ ]` **Confirm partner #9 can no longer sign in** to the portal on labs. | The fixed build withdraws every `partner<id>` password and its sessions when it first starts (`OPS-15`). Nobody has looked since. | Your check |
| B4 | `[ ]` **After the retest, retire the auditor's synthetic records** in Setup → Test records: leads #40–44, cases #9–11, lists #3–4, campaigns #3–4, partners #9–10, rule #6, automation #2, the QA library item and content. | §9. Until then, nothing may touch them: they are the reproductions. | Your action |
| B5 | `[ ]` **OPS-46: tasks saved on labs before the fix** still show 5½ h late. Correct them, or leave them as test data? | Old rows cannot be told apart from system-made ones with certainty, so a correction would be a judgement call. | Decision |
| B6 | `[ ]` **QA-10: do you want a design preview (both themes) before I build the call panel?** | Ruled "keep and redesign"; whether you sign off a design first was not said. | Decision |
| B7 | `[ ]` **The pilot database.** The BRD makes PostgreSQL a pilot gate; the build runs on SQLite. Move before the pilot, or stay on SQLite for UAT and decide later? | §1 pilot gates; A6 depends on it. | Decision |
| B8 | `[ ]` **QA-22: which news provider?** Headlines become links as soon as a feed supplies the URL. | Open since 15 Oct. | Decision |
| B9 | `[ ]` **QA-34: who on the trading-platform side receives the nomination pop-up spec**, and when the half-yearly nomination reminders should be switched on (off for both businesses). | Open since 15 Oct. | Decision |
| B10 | `[ ]` **QA-24: when will the account-opening feed reach the CRM?** "A lead is marked Won only once its account is opened" stays off until it does. | Open since 13 Oct. | Dependency |
| B11 | `[ ]` **P3-07: is the hierarchy as built what you asked for?** The configurable tree is under Sales groups; the auditor looked in Roles & permissions, found a flat list of 11 roles, and marked it partial. | §4. Built as a configurable tree with branches under Bonanza and Bigul, as you answered on `Q3`; whether that meets the ticket is yours to say. | Decision |
| B12 | `[ ]` **Environment proofs the report says not to infer from the simulator:** real CUBE, Smartping, email, Meta and DKYC callbacks; consent and DND; data residency; mobile geolocation; performance at 100k leads; UAT → Production rollback. | §7. Blocked on the CUBE credential (`N-6`), vendor accounts (`A-4`) and a production environment (`P2-03`). | Blocked on others |

---

## C · Done — struck out

### C1 · The 43 findings: 39 fixed, 1 closed by ruling, 3 open

| ID | Pri | Finding | Fixed in | Test | Your retest |
|---|---|---|---|---|---|
| QA-01 | P0 | ~~Routing overrode the Sales RM's "Assign to me"~~ | `84c2c2f` | round4, round4h | |
| QA-02 | P0 | ~~Scheduled rules repeated against the same records~~ | `1c3b18c` | rulefiring, helpline | |
| QA-03 | P0 | ~~Bonanza partner support assigned across the business boundary~~ | `84c2c2f` | round4 | |
| QA-04 | P1 | ~~Cockpit numbers did not drill through to their records~~ | `eaf4743` | round4b | |
| QA-05 | P1 | ~~Customer Care counts and case filters disagreed~~ | `eaf4743`, `de27e4a` | round4b, round4e | |
| QA-06 | P1 | ~~Marketing PII policy contradicted itself~~ | `9aa78bf` | piimasking, e2e | |
| QA-07 | P1 | ~~Case changes skipped the review/confirmation step~~ | `4e63d3c` | round4g, bookscope | |
| QA-08 | P1 | ~~Tasks accepted an unlinked record~~ | `84c2c2f` | round4, supervisor | |
| QA-09 | P1 | ~~Partner client stage and live-account measures disagreed~~ | `a3be2c1` | statusdefinitions | |
| QA-10 | P1 | The call panel is hard to use in both themes — **open, A4** | — | — | |
| QA-11 | P1 | ~~Email merge fields stayed unresolved~~ | `eaf4743` | round4b | |
| QA-12 | P1 | ~~API access screen told users to use HTTP for secrets~~ | `eaf4743`, `de27e4a` | round4b, round4e | |
| QA-13 | P1 | ~~Cross-business referral and DKYC branding~~ (ruled 13 Oct) | `ca7d4ee`, `0efa39b`, `32278d2` | businesspolicy, kycrulings, e2e | |
| QA-14 | P2 | Pipeline multi-select and per-stage filters — **open, A7** | — | — | |
| QA-15 | P2 | ~~Lead list had no pagination and few sortable columns~~ | `46e31ed` | round4f | |
| QA-16 | P2 | Report builder and dashboard creation — **open, A8** | — | — | |
| QA-17 | P2 | ~~Dates not in DD-MM-YYYY~~ | `de27e4a` | round4e, e2e | |
| QA-18 | P2 | ~~App Launcher stayed open; Marketing offered the Service Console~~ | `de27e4a` | round4e | |
| QA-19 | P2 | ~~Marketing Home "Create list" said "still in build"~~ | `eaf4743` | round4b | |
| QA-20 | P2 | ~~Tasks and Tickets counts did not match what they listed~~ | `eaf4743` | round4b | |
| QA-21 | P2 | ~~Product RM handoff acknowledgement was generic~~ (60 s timing: A5) | `eaf4743` | round4b | |
| QA-22 | P2 | ~~Market headlines were static text~~ (live links: B8) | `de27e4a` | round4e | |
| QA-23 | P2 | ~~Residency "Sent" label overstated egress~~ | `eaf4743` | round4b | |
| QA-24 | P2 | ~~"Won" meant different things~~ (the Won policy: B10) | `a3be2c1` | statusdefinitions | |
| QA-25 | P2 | ~~Copilot breach answer did not state its scope; drawer covered cards~~ | `eaf4743`, `de27e4a` | round4b, round4e | |
| QA-26 | P1 | ~~Empty lead name exposed a database error~~ | `84c2c2f` | round4 | |
| QA-27 | P2 | ~~Soft delete left a "Lead not found" page~~ | `eaf4743` | round4b | |
| QA-28 | P1 | ~~AI-created compliance case had no category or SLA~~ | `84c2c2f`, `f54c4f6` | round4, compliancedesk | |
| QA-29 | P2 | ~~Static list stayed empty after an import~~ | `b9b3807` | round4d | |
| QA-30 | P1 | ~~Campaign could send without approved content~~ | `84c2c2f` | round4, e2e | |
| QA-31 | P2 | ~~Product minimum allowed only multiples of ₹1,000~~ | `eaf4743` | round4b | |
| QA-32 | P1 | ~~Product creation failed on the promised generated code~~ | `84c2c2f` | round4 | |
| QA-33 | P0 | ~~Superadmin could activate a partner at 0/8 onboarding~~ | `84c2c2f`, `826ae09` | round4, emergencyelevation | |
| QA-34 | P1 | ~~DKYC accepted invalid identity, bank and nominee values~~ | `d34bb6b`, `a3be2c1`, `88c2c67`, `b0c97b8`, `ce5b6d0` | round4c, kycrulings, nominees, nominationduties | |
| QA-35 | P2 | ~~KYC-complete lead said "no active products" beside an Active card~~ | `a3be2c1` | statusdefinitions | |
| QA-36 | P1 | ~~Sales edit dialog revealed masked contacts~~ — **closed by your ruling, 13 Oct**: the editor shows them without a click, audited | ruling | — | |
| QA-37 | P2 | ~~Configurable entities lacked a full lifecycle~~ | `69f8d16`, `de28b1c`, `9224a07`, `2f628d6`, `6fc4f64`, `32278d2` | lifecycle1–5, templates, referralretention | |
| QA-38 | P2 | ~~Opted-out lead's email entry points applied different rules~~ | `eaf4743` | round4b | |
| QA-39 | P2 | ~~Manual message timeline said "system"~~ | `eaf4743` | round4b | |
| QA-40 | P2 | ~~Monitoring counters said zero beside thousands of rows~~ | `eaf4743` | round4b | |
| QA-41 | P2 | ~~A refused Admin API tab stayed at "Loading"~~ | `eaf4743` | round4b | |
| QA-42 | P1 | ~~Dealer's "Start engaging" produced no visible result~~ | `b9b3807` | round4d | |
| QA-43 | P1 | ~~Product Supervisor's KYC list showed a journey its detail refused~~ | `eaf4743`, `de27e4a` | round4b, round4e | |

Test names are files in `server/test/` (`round4` is `round4.test.mjs`, and so
on). Every one passed on 18 Nov.

### C2 · The report's other points

- [x] ~~Per-ID status back against the report and earlier IDs~~ (§7) — [ROUND-4-TRIAGE.md](ROUND-4-TRIAGE.md), and this checklist.
- [x] ~~Every ruling the report asked for~~ (§7) — QA-13, QA-09/24/35, QA-06's export, QA-37, QA-33, QA-28, QA-34, QA-36, QA-42, given 13–16 Oct. What is still open sits in B.
- [x] ~~The fixes deployed to labs~~ (§7) — GitHub Actions run #296, 16 Oct, success. Seen from GitHub only.
- [x] ~~A scoped, auditable cleanup for test records the UI cannot retire~~ (§9) — Setup → Test records, built in QA-37 batch 5. Running it is B4.
- [x] ~~Revoke partner #9's portal access — in code~~ (§9) — `OPS-15`, plus *Withdraw portal access* on the partner's page. Confirming it on labs is B3.
- [x] ~~Ritesh's Part 4, items 1–8~~ — items 9–11 are QA-10 and QA-14 above.
- Steps 1–7 of the report's implementation sequence (§6): every QA ID under them is fixed. Step 1's "tests for every lead creator" and step 7's "role-based view/export/API tests" are only proven for the cases tested, so they carry on in A2. Steps 8 and 9 are A4, A7, A8, A9 and A6.
