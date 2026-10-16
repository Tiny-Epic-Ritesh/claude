# QA-16 — Reports and dashboards: what to build

**Status:** **approved by Ritesh, 15 Oct 2026** ("Pls go ahead"). Built in the order of
section 6. The questions in section 5 (definitions, schedule recipients, the first ten) are
asked as the step that needs each one is reached.
**Covers:** QA-16 (Round 4), `P3-06` (report builder), `P2-17` (dashboard creation).
**Answers `N-4a`** ("which reports does the team actually run?"): on 15 Oct 2026 Ritesh
signed in to both LeadSquared accounts and I read every report and dashboard, read-only.
What I found is in [QA-16-LEADSQUARED-REPORTS.md](QA-16-LEADSQUARED-REPORTS.md).

---

## 1. What the auditor saw, and what is actually there

The auditor opened **Reports** (eight fixed views and a date window) and **Dashboards**
(the Home figures with date presets). They found no report builder and no way to make a
dashboard. Both observations are right about those two screens.

What they did not find, because nothing leads to it from either screen:

- **My Dashboards** (`/boards`, P2-17b) already exists. Anyone can build a dashboard of
  panels; publishing one to a role needs `report.team`. A panel is a saved question over
  **Leads, Clients, Cases or Interactions**: count, total, average, highest or distinct
  values, grouped by a field, split into up to six series, trended by day, week or month.
  It is drawn as a bar, line, area, pie, donut or treemap. Every viewer runs the same
  question through their own scope, so sharing a dashboard shares the question, never the
  answer.
- **No report builder exists.** No list reports, no export of a built report, no schedule,
  no drill-down from a figure to its records (outside the Home tiles), and no sources
  beyond the four above.

## 2. What the two businesses use LeadSquared for

From reading both accounts (details in the companion file):

| What they use | Bonanza | Bigul |
|---|---|---|
| LeadSquared's standard catalogue (about 90 reports) | yes, mostly as shipped | yes, mostly as shipped |
| Reports the team built itself | 6: lead source, meeting connects, activity counts by owner, opportunity counts | 20+: RTT (ready to trade) leads by date, zero-month clients, presales caller and TL reports, post-sales lead state, SIERA performance, Weekly MIS, total margin, call insights |
| Scheduled emails | 2 (partner team activity, MF team lead-stage count) | the zero-month client report, daily |
| Dashboards | 5 (sales productivity, sales user, landing pages, database, meeting) | 7, each someone's Home (LSQ sales v1 and v2, post sales, sales productivity, sales user, landing pages, database) |

The builder they use offers: Summary or List reports; up to 5 row groupings, 1 column
grouping and 25 values; up to 15 filters the viewer can change; bar, column, line, area,
pie, donut, funnel and combo charts; conditional formatting; drill-down to records; a
"linked insight" that opens another report with the clicked context; scheduling by email;
dashboards of up to 25 widgets, each a saved report.

Three things in how they use it shape the design:

1. **Bigul runs post-sales from it.** Its post-sales dashboard sums trading and margin
   figures per RM (ready to trade, last traded, current and total margin). That data comes
   from the back office. In this CRM the trading feed (OD-06) is still simulated, so those
   reports can be designed now but will show real figures only once it is connected.
2. **Daily mailers are real work**, not a nicety: a report emailed every morning is how a
   team lead sees yesterday.
3. **Teams copy reports to filter them** ("v2", "Post Sales Team", "Presales TL"). That is
   the LeadSquared workaround the project rules say not to repeat: here a team is a filter
   on one report, saved as a view.

## 3. The proposal: one builder, reports first, dashboards built from reports

### 3.1 A report is a saved question

- **Source** (what the rows are): Leads, Product cards (LeadSquared's "opportunities"),
  Interactions (calls, meetings, messages), Tasks, Cases, Clients, KYC journeys, Partners
  and commission, Campaign sends, Users and attendance. Each source has exactly one scope
  function, the one the rest of the CRM uses, so a report can never see more than its
  viewer may.
- **Two types**, as they use today:
  - **Summary**: up to 3 row groupings and 1 column grouping (a field, or day/week/month,
    as in Bigul's "Date Wise RTT Leads"); up to 10 values (count, distinct, total, average,
    highest, lowest of a number field).
  - **List**: chosen columns, sort and filters, paged. Field security and masking apply as
    on every other screen.
- **Filters**: up to 10, each either fixed or "the viewer may change this" (date range,
  owner, team, business, product, stage). Dates are India days.
- **Charts**: table, figure (KPI), bar, column, line, area, pie, donut, funnel; and simple
  conditional formatting (colour a cell above or below a value).
- **Every figure opens its records.** A cell, a bar or a KPI opens the list of exactly the
  records it counted, through the same filter contract the Home tiles now use (QA-04,
  QA-05). LeadSquared's "linked insight" becomes: clicking a figure may open another report
  with the clicked value as a filter.
- **Shared questions, never shared answers.** Publishing a report to a role or a team shares
  its definition; each viewer runs it as themselves. This is how My Dashboards already
  works, and it stays the rule.
- **Folders and owners**, not tags: a report lives in a folder, has an owner, and can be
  pinned. Every change goes in the configuration audit.

### 3.2 Exports and schedules

- **Export** of a list report is the existing `export.<object>` capability, masked or
  unmasked by the same rules as every other export (including Marketing's policy), and
  audited.
- **Schedule**: email a report daily, weekly or monthly at an India time to users or a
  role. It is **run once per recipient, as that recipient**, so each person receives only
  their own scope. That is what makes a team lead's daily mailer safe to send to RMs too.
  Mail goes through the business's own SMTP (data stays in India).

### 3.3 Dashboards

- A dashboard is a grid of up to 20 widgets, each a saved report (as a chart, table or
  figure), with one filter bar (date range, business, team) applied to all of them.
- A dashboard can be set as **Home for a role**, as both businesses do now.
- My Dashboards moves into the Dashboards area with a **New dashboard** button, so the
  auditor's path finds it. The existing panels become widgets built from saved questions;
  nothing already built is lost.

### 3.4 What is deliberately not copied

- Per-team copies of the same report: one report, a team filter, saved views.
- 25 values in one report, 15 filters, 25 widgets: capped lower (10, 10, 20), because past
  that a report is an export, not something anyone reads.
- Reports that mix leads and users in one list with no scope: every source has a scope.

## 4. A starter library, mapped from what they run today

Shipped as ready-made reports in a "Standard" folder, each one editable as a copy:

- **Leads:** by source; pipeline by stage; ageing by created date; not contacted; stage
  changes (history and by user); assignment history; duplicates and merges; activity by
  stage.
- **Calls and activity:** calls by status, by hour, by weekday; phone call metrics by user;
  activities by user and by type; first response time on new leads.
- **Tasks:** status by owner; overdue; completed; trend.
- **Product cards:** distribution by owner, product and state; value by stage (LeadSquared's
  opportunity revenue); stage change history.
- **Clients:** conversion by source and time to first account (LeadSquared's "time taken to
  win a customer").
- **People:** attendance; check-in history; logins; productivity (logins, tasks, activities).
- **Marketing:** campaign sends, delivery and opens; source, medium and campaign (UTM).
- **Bigul post-sales** (needs the trading feed for the money figures): RTT leads by date,
  zero-month clients, lead state by RM with trading and margin.

## 5. What I need from you as the build reaches it

1. ~~**Approve this approach**~~ — approved 15 Oct.
2. **Definitions** for the reports I saw only by name: Weekly MIS, SIERA performance, RTT
   data, zero-month client, presales caller and TL reports, call insights. Either tell me
   what each counts, or allow me to open each one's configuration in LeadSquared, read-only
   as before.
3. **Scheduled emails:** may a report be scheduled to people outside the reader's own team
   (for example, a team lead's report to the business head)? Each recipient would still
   see only their own scope.
4. **Which ten matter most** in the starter library, to build first.

## 6. Build order, once approved

1. Summary reports on the existing panel engine, with drill-down to records.
2. List reports and their export.
3. The further sources (product cards, tasks, KYC, partners and commission, campaigns,
   attendance).
4. Dashboards from saved reports; Home per role; New dashboard on the Dashboards page.
5. Schedules.
6. The starter library.
7. The post-sales reports, when the trading feed is connected.

Each step ships with its own tests, and with before/after evidence for the Round 4 retest.
