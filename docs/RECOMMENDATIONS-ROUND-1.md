# Recommendations on the open questions

You asked me to recommend rather than wait. Each item below is a **decision I am
prepared to build to**, with the reasoning and the standard practice behind it.
Override any of them and I will build what you say instead.

Two of these **reverse my own earlier proposal**. They are marked ⟲ and I have
said why I changed my mind.

---

## ENH-08 — the seven uncertain cells

| # | Cell | Recommendation | Why |
|---|---|---|---|
| 1 | Marketing Manager → **Leads** | **Visible, read-only, masked** | They must be able to sanity-check a segment before sending. Denied, they build blind and ask an RM to check for them, which is worse and leaks more. Give the tab, withhold `lead.edit` and `lead.contact`, keep PII masked per Q-16. |
| 2 | Sales Supervisor → **Partners** | **Visible, read-only** | A large share of broking volume is sub-broker / Authorised Person sourced. A supervisor asking why the team's numbers moved needs to see which partner sourced the leads. Read-only keeps onboarding — which carries its own AP-code and registration trail — with Partner RM. |
| 3 | Customer Care → **Market** | **Hidden** | A service desk is measured on handle time and resolution; market data is not part of resolving a ticket. More importantly, an agent glancing at a price move and offering a view is unsolicited investment advice. Only registered persons may advise. Keep the temptation off the service desk. |
| 4 | Marketing Manager → **Market** | **Visible** | Campaign timing genuinely keys off market events — Budget day, a large IPO, a volatility spike. Marketing has no client contact, so the advice risk in #3 does not arise. |
| 5 | Customer Care → **Team / Incentives** | **Both hidden. Keep KRA.** | The role is an *agent*, not a supervisor, so Team does not apply. Incentives here is revenue-linked payout; a service agent would see zero forever, which is worse than not showing it. KRA stays, repurposed to service measures — CSAT, first-response time, resolution rate. If Bonanza does pay service incentives, tell me and this flips. |
| 6 ⟲ | Sales RM → **Revenue / Reports** | **Both visible, scoped to self** | I proposed *no*. I was wrong. Every major CRM gives a rep their own numbers, and hiding them creates a standing dependency on the supervisor for trivial questions — which is how teams end up back in Excel. The real risk is an RM seeing *other people's* numbers, and that is a scope question the API already enforces, not a tab question. |
| 7 ⟲ | **Approvals** — who | **Four, not five: Superadmin, Admin, Sales Supervisor, Product Supervisor.** Partner RM read-only. | I had Partner RM as an approver. That lets the same person raise *and* approve a partner elevation. Maker-checker separation is the norm in Indian financial services and among the first things an auditor tests. Partner RM raises, a supervisor or admin approves, and Partner RM can still watch the status of their own requests. |

**Control model** (already confirmed): role-level defaults with per-user override,
every change written to the config audit log.

**Worth restating:** hiding a tab is navigation, not security. The API enforces
capability independently. The two work together and neither substitutes for the other.

---

## Q-05 — summary-card drill-through

| Question | Recommendation |
|---|---|
| Same tab or new? | **Same tab**, built as a real `<a href>` so Ctrl-click and middle-click still open a new one. Forced new tabs proliferate and break the back button. |
| Filter visible on the destination? | **Yes, and removable** — shown as a chip, `Stage = Warm ✕`. A filtered list that does not say why it is filtered reads as a bug: "where did my other leads go?" |
| Editable? | **Yes.** The drill-through is a starting point, not a destination. Let them widen or narrow it in place. |
| Saveable as a view? | **Yes — offered, never automatic.** A "Save as view" button on the filter bar. This is how Salesforce list views work, and it turns a one-off drill into a reusable working list, which is exactly the input Lead Lists (BUG-25) needs. |

---

## Q-10 — scope of the "Product Cards → Products" rename

**Recommendation: display labels only. Do not touch API names, database columns or object keys.**

- The metadata layer already separates label from API name. That separation exists
  precisely so business terminology can change without a migration.
- Renaming internals means a data migration, breaks any integration built against
  the old names, and invalidates saved reports and filters that reference them.
- Salesforce's own guidance is the same: rename labels freely, never rename API
  names once anything integrates against them.

**The cost asymmetry is the argument.** Label rename: a config change, minutes,
reversible. Internal rename: migration plus integration breakage plus regression
risk across every module.

Apply the label everywhere user-visible — tab, nav, page titles, buttons, empty
states, notification text, report column headers. In Setup, show it as
`Products (API: product_card)` so a developer reading the field list is not misled.

---

## Q-24 — dashboard metrics per role

### Default date range

**Month to date, compared against the same period last month.**

Broking sales targets in India run monthly, and MTD is what an RM is judged on.
Not "last 30 days" — a rolling window does not align to a target period, so the
dashboard number would disagree with the incentive statement, and the incentive
statement always wins that argument.

Range picker: **Today · MTD · QTD · FYTD · Custom**, with the financial year
**starting 1 April**.

### Per role

Every tile is clickable and drills through per Q-05, and every tile is scoped by
the same `leadScope` — so a number can never exceed what the user is allowed to open.

| Role | Tiles | Charts |
|---|---|---|
| **Sales RM** | New leads MTD · Calls logged today · Follow-ups due, overdue in red · Accounts opened vs target · Brokerage MTD · Conversion % | Funnel (Lead→Contacted→Interested→KYC→Active) · 30-day activity sparkline · Product mix |
| **Sales Supervisor** | Team attainment % · **Leads unattended >48h** · KYC stuck >7 days · Team conversion · Aging pipeline · Headcount active today | RM leaderboard · Funnel by RM · Attainment trend |
| **Caller** | Calls today vs target · Connect rate · Callbacks due · Dial list remaining · Avg talk time | One hourly call bar, nothing more. A caller's screen should be almost entirely the work list. |
| **Dealer** | Active clients · Orders today · **Dormant 30 days** · Margin and ledger alerts · Open service requests | Dormancy trend · Client segment mix |
| **Partner RM** | Active partners · Onboarded MTD · Partner-sourced leads · Commission payable · **Inactive 30 days** · Onboarding stalled | Commission trend (ENH-28a) · Partner leaderboard |
| **Product RM / Supervisor** | Cards assigned · By stage · Conversion by product · **Untouched 7 days** · Revenue by product | Stage funnel · Product comparison |
| **Customer Care** | Open by priority · **SLA breaches** · First-response time · Resolved today · CSAT · Reopened | Volume by category · FRT trend |
| **Marketing** | Leads by source MTD · Cost per lead · Campaign performance · Opt-out rate · List health · Channel mix | Source-to-conversion funnel · Spend vs leads |
| **Admin / Superadmin** | Active users · Logins today · Integration health · Failed jobs · Data quality (duplicates, missing PAN) · Audit events | Consent opt-out trend · Usage by role |

The bolded tiles are the ones I would build first in each case. They are the
"something is wrong and nobody has noticed yet" metrics, and they are what makes
a dashboard get opened a second time.

---

## Q-25 — Lead Lists

### (a) The three list types

| Type | Membership | Use it for |
|---|---|---|
| **Static** | Fixed at the moment of creation. Changes only by manual add/remove or re-import. | Event attendees, an imported list, a call-blitz assignment. Frozen means auditable — you can prove exactly who was in it. |
| **Refreshable** | Built from a saved filter, but re-evaluated only on demand or on a schedule. | "Warm leads, no contact in 7 days", refreshed each Monday. The value is that it does **not** change underneath a running campaign. |
| **Dynamic** | Evaluated live, every time it is opened. | Working queues and dashboards — "my overdue follow-ups". Always current, never stale. |

**Cadence.** Dynamic needs none: it evaluates at query time, which is cheap because
the condition tree already compiles to SQL. Refreshable gets **a scheduled refresh
at 06:00 IST plus a manual Refresh button**, with "last refreshed" always on screen.
06:00 so lists are current before the market opens and calling starts.

**One rule I would enforce in code: a campaign may only send to a static or
refreshable list, never a dynamic one.** If membership shifts mid-send, the send log
and the list disagree, and you lose the ability to state precisely who was contacted.
For a regulated firm that is not a nice-to-have.

### (b) Bulk actions

Reassign owner · Bulk stage update · Add to campaign or nurture · Add to or remove
from another list · Bulk task creation · Bulk SMS / WhatsApp / email · Bulk tag · Export

Guardrails I would build alongside them, not afterwards:

- **Consent filtered before send**, with an honest preview: *"412 of 500 will receive this. 88 suppressed — 61 opted out, 27 no valid mobile."*
- **One audit row per record**, not one per action, so "was this client contacted" stays answerable.
- **Export behind its own capability**, logged with who, what and when. Bulk export is the main data-exfiltration path in a broking CRM and should be the most closely watched button in the product.
- **A confirmation showing the exact count** before anything executes.

---

## Q-26 — what defines a Client

**Recommendation: a separate object, not a lead status.**

Today `client_code` (the UCC) is a column on `leads`, so a client is currently a
lead that happens to have a UCC. I would change that, for three reasons:

1. **They are different things with different lifecycles.** A lead is a prospect
   record owned by sales. A client is a live account with a UCC, a demat/DP ID, a
   KYC record, a nominee, a risk profile and a ledger. Retention rules differ too:
   client records must be retained for years after closure, while a prospect can be
   erased on request. One object cannot honour both obligations.
2. **The relationship is not one-to-one.** The same PAN may enquire twice and
   produce two leads. One lead may open equity *and* commodity, or an account on
   Bonanza *and* on Bigul. A status flag cannot represent that; a linked object can.
3. **It fixes a real operational complaint.** While a converted client is still a
   lead row, it keeps surfacing in prospecting lists and campaign segments — which
   is how a firm ends up sending acquisition offers to its own customers.

**Shape:** a `clients` object keyed on PAN + UCC, with `converted_from_lead_id`
preserving attribution back to the originating lead, and to the partner who sourced
it. **Conversion fires when the account activates and the UCC is generated** — not
when KYC starts, because a KYC in progress is not a customer.

**Which roles see the Clients tab**

| Sees it | Scope |
|---|---|
| Superadmin, Admin | All |
| Sales RM | Own book |
| Sales Supervisor | Team |
| Dealer | Assigned clients |
| Product RM / Supervisor | Clients holding their product |
| Customer Care | All — service needs it |

| Does not see it | Why |
|---|---|
| Caller | Works a dial list of prospects. A client appearing in that list is a mis-dial waiting to happen. |
| Partner RM | Sees a partner's clients **inside the partner record**, read-only. Not the global tab. |
| Marketing | Segments and sends; does not open individual client records (Q-16). |

The `sales_org` scope applies here exactly as it does to leads: **Bigul users must
not see Bonanza clients, and the reverse.**

---

## What I would confirm first

If you confirm nothing else on this page, confirm **Q-26**. It is the only
architectural decision here — Clients as its own object changes the data model, and
BUG-25, BUG-26, ENH-24 and the Pipeline module all sit on top of it. Every day it
stays open is a day those four cannot start.

Everything else here is reversible configuration.
