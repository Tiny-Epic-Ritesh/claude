# What both LeadSquared accounts report on (read 15 Oct 2026)

Companion to [QA-16-REPORTS-DESIGN.md](QA-16-REPORTS-DESIGN.md). Ritesh signed in to each account in their own
Chrome and I read it, read-only: nothing was created, saved, scheduled, exported or deleted, and the
report and dashboard builders were opened and cancelled. Recorded here: structure only -- report names,
columns, filters, groupings, charts. No client data.

## Bonanza Portfolio Ltd (tenant 63762)

### Where it lives
More (⋮) → Analytics → Reports | Dashboards. "View profile as: My Space".
Reports: Pinned, All, Scheduled; grouped by tags.

### Report catalogue (All Reports, by tag)
- Untagged (custom): Lead Source Report; Meeting Report V2
- Account Insights: Automations Trend Analysis; Connectors Trend Analysis; Users Trend Analysis
- Administrative: Database Size; Lead Activity Count Activity Owners Wise; LeadSquared Usage Report;
  LeadSquared Users Report (users, groups, group managers); List of Users; Meeting Report v1;
  Monthly User Login Activity; User Login History
- Audit Logs: Apps and Connectors Audit; Automation Audit Log; Deleted Automations Audit;
  Deleted Lead List; Lead Assignment History; Lead Field Changes Audit Log;
  Permission Template Assignment Audit; User Audit Log; User Deactivation History
- Custom: Lead Activity Count Activity Owners Wise; Lead Opportunity Report; Meeting Report v1; Opportunity Count
- Customer Analysis: Customer Conversion Analysis (by lead fields); Time taken to win a customer (month on month)
- Emails and Marketing Automation: Email Campaign Statistics (sent/delivered/open...);
  Email Campaign Subject Line Analysis; Sent Email Analysis (one-to-one and to lists)
- Field Sales Tracking: Distance Travelled Report; Location History Tracker
- Large Exportable: Activity count by Leads; Activity List by Opportunity; Custom Activity List by Leads;
  Leads Without Opportunities; Users Check-in and Check-out History
- Lead Insights: All Leads Details; Campaign Tracking Analysis (UTM); Custom Activity List by Leads;
  Lead Aging Analysis (by created date); Lead Assignment By Stage; Lead Assignment History;
  Lead Distribution Analysis [Tabular] (by owner/stage/source...); Lead Growth; Lead Pipeline (by stage);
  Lead Trend Analysis; Leads Not Contacted; List of Duplicate Leads (by fields, exportable); List of Merged Leads
- Lead Source Analysis: Lead Capture Analysis by Source (first and repeat captures);
  Lead Distribution Analysis [Tabular]; Lead Source Audit Report (source changes); Lead Source Report
- Lead Stage Analysis: Lead Activity Analysis by Stage (with/without activity); Lead Distribution Analysis [Tabular];
  Lead Stage Change History Report; Stage Change Analysis by Users
- Opportunity Management: Activity List by Opportunity; Opportunities Trend Analysis;
  Opportunity Distribution Analysis (owner/status/product); Opportunity Master Data; Opportunity Revenue Analysis;
  Opportunity Stage Change History; Task Status Report (Opportunity); User Productivity Report (Opportunity)
- Sales and Revenue: Revenue Analysis Report (Lead)
- Sales Group-Wise Analysis: Customer Conversion Analysis; Lead Activity Analysis by Stage;
  Lead Capture Analysis by Source; Lead Stage Change History Report; Leads Not Contacted
- Task Analysis: Completed Tasks Report; Task Status Report (Lead) (completed/pending/overdue by user);
  Tasks Distribution by Task Type; Tasks Status and Count by Owners; Tasks Trend Analysis
- Telephony and SMS: Calls by Status (answered/missed...); Day-wise Calling Data (weekday);
  Hourly Call Data; Phone Call Metrics by Users (inbound/outbound)
- User Activity Reports: Activities by Users; Activities Trend Analysis; Activity Analysis Report;
  Activity count by Leads; Activity Distribution by Activity Type; Attendance Report (month or range);
  Check-in and Check-out History; User Productivity Report (Lead) (activities and tasks); Users Attendance Analysis
- Website and Landing Pages: Campaign/City/Country/Daily traffic; Landing Page Group-wise;
  Landing Pages Conversion; Landing Pages Trend Analysis; Medium Analysis; Source Analysis (UTM)

Scheduled (emailed), both Active, owner Admin: "User Activity Analysis Partner Team Report"
(last run 1 Oct 2026) and "MF Team Lead Stage Count" (last run 14 Oct 2026).

### Custom reports seen (structure only)
- Lead Source Report (classic): total leads, share from top 3 sources; table Source | New leads added
  with % bar; date range (last 30 days). ~80% of leads show source "Unknown".
- Meeting Report V2: List report on leads: Owner, First/Last name, Mobile (shown unmasked),
  No. of Connects, No. of Not Connected, Not Connected reason, No. of Joint meetings;
  filters Created On (This Month), Sales Groups, Owner; rows per page; Save As / Apply.

### The report builder (Create Report)
- Data source first: LEAD (Leads, Lead Assignment History, Lead Delete History, Lead Merge History),
  ACTIVITY, OPPORTUNITY, TASK, USER, WEBCONTENT, ... (searchable)
- Report type: Summary | List
- Data tab: Rows (group by) up to 5, Columns (pivot) up to 1, Values (aggregates) up to 25,
  date bucketing on fields (e.g. "First Name..."/date format selector), pagination
- Filters tab: report filters up to 15, "visible to the users" (runtime filters); defaults
  Created On (date presets), Sales Groups, Owner (with Switch)
- Visualise: table settings (conditional formatting rules, subtotals, summary row, wrap header);
  charts: none, bar, column, line, area, pie, donut, funnel, combo
- Drilldown: configure drilldown (row -> records), "Linked Insight" (click navigates to another
  report carrying the context)
- Preview on a limited data set; Save / Cancel; Save As on existing reports; Pin; Schedule (email)

### Dashboards
- Untagged: Meeting Report v2; Administrative: Database Usage Dashboard;
  Sales Dashboard: Sales Productivity Dashboard (Home), Sales User Dashboard;
  Website and Landing Pages: Landing Pages Pro Dashboard
- Sales Productivity (Home): KPI Total Leads, Engaged Leads; Lead Growth (area, daily);
  Lead Pipeline (column by stage); KPI Total/Pending/Overdue/Completed Tasks; Leads by Sources (donut);
  Leads Distribution by Owner (table); Team Tasks Summary (table by owner: total, overdue, pending,
  due today, completed)
- Sales User Dashboard: KPI Total Calls, Total Call Duration, Avg Call Duration, Calls Connected,
  Inbound Missed, Outbound Unanswered; Hourly Call Data (bar by hour); Calls Status Breakup (bar);
  Day-wise Call Data (bar by weekday); Activity Distribution (pie by activity type); KPI Leads Added,
  Leads Called, Leads Answered, Total Tasks, Overdue Tasks, Tasks Completed Today, Due Today,
  Due Tomorrow, Due This Week; Lead Pipeline (column by stage); Pending and Overdue Task
  Distribution (stacked column by task type)
- Builder: up to 25 widgets; a widget is "from a report" (a saved report rendered as KPI/chart/table)
  or "from an external source" (embed); dashboard-level filter bar; each widget has its own filter
  indicator and an open-as-report link; Home dashboard per user; pin; tags.

## Bigul (tenant 57437; its organisation name in LeadSquared is "Bonanza Portfolio Limited")


### Differences from Bonanza
- Pinned: Bonanza Portfolio - Performance Report (SIERA); Database Size; Date Wise RTT Leads;
  Number of Leads Converted by User; Phone Call Metrics by Users/Post Sales Team; Zero Month Client Report
- Untagged (custom): Performance Report (SIERA); Calls by Status v2; Hourly Call Data V2 dashboard
  ("for dashboard creation"); Lead count with activity count (BIGUL); Lead Source Report;
  Phone Call Metrics by Users/Post Sales Team; source by lead stage ("at what stage the lead source is");
  Total Margin (over a period); User Login Report; Users Check-in and Check-out History; Weekly MIS Report 2025
- Custom tag: Activity Distribution by Activity Type v2; Performance Report (SIERA); Call Insights;
  Date wise lead; Date Wise RTT Leads ("Ready to Trade leads with post sales team");
  Lead Distribution by Team Analysis; Lead state analysis - post sales; Opportunity Stage and Owner;
  Presales Caller Test Report; Presales TL Report; RTT Data; User and Lead Stage;
  Zero Month Client Report ("Zero Month Client Activity Report for daily mailer")
- Administrative adds Lead Field Audit Report (old/new values); Sales Group-Wise adds User Productivity
  Summary (logins, tasks completed, activities); User Activity adds Average Time for First Activity on
  New Leads, Number of Leads Converted by User, User Productivity Summary. System catalogue otherwise
  the same as Bonanza's.
- Scheduled (emailed): Zero Month Client Report, twice (two schedules), Active, last run 15 Oct 2026.
- Dashboards (7, each a Home for someone): LSQ Sales Dashboard; Post sales ("for the post sales team");
  Database Usage Dashboard; v2 LSQ Sales Dashboard; Sales Productivity Dashboard; Sales User Dashboard;
  Landing Pages Pro Dashboard.
- Post sales dashboard widgets: Phone Call Metrics by Users/Post Sales Team (multi-series line per user:
  calls, inbound, outbound, answered...); Lead state analysis - post sales (table per owner: count of
  leads, Ready to trade, Last trade in current month, Last traded today, Sum(Current margin),
  Sum(Total margin), Count of clients w..., Sum(No of connects), Sum(No of not connected), ...);
  KPI Total Margin, Unique Leads; Calls by Status v2 (table user x status, subtotals); Date Wise RTT Leads
  (pivot: rows by stage change, columns by date); Performance Report (SIERA) (pie by owner);
  KPI Inbound / Outbound / Inbound missed / Outbound unanswered / Inbound answered / Outbound answered calls.

## What this says for the builder
- Post-sales reporting is built on trading and margin fields synced onto the lead (RTT, last traded,
  current/total margin). The CRM's builder needs those as summable values, which needs the back-office
  feed (OD-06, today simulated).
- Pivots by date (columns = days) are in real use (Date Wise RTT Leads).
- Daily mailers (scheduled emails) are in real use in both businesses.
- Per-team variants of the same report (v2, Post Sales Team, Presales TL) suggest saved views with
  team filters rather than copies.
