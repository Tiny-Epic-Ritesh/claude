# Smart Views, Tasks, Lists, Field Sets

## SMART VIEWS — 14 configured
Source: Settings > Leads > Views > Smart Views
Structure: each Smart View has a Code, is assigned to Teams, and contains N Tabs.
A "Tab" is a saved filtered queue the agent works through.

| Smart View | Code | Assigned Teams | Tabs | Modified By | Modified |
|---|---|---|---|---|---|
| Trade Team | 19 | (none listed) | 1 | Apoorva Goel | 01/28/2026 |
| Pre sales Smart View | 1 | Digital Onboarding Team 1, OS-Sales-Team Bhopal, OS Sales Hyderabad, Bonanza Group 1 | 11 | Manjushri Bajwa | 12/24/2025 |
| My Tasks | 18 | (none) | 1 | System | 12/05/2025 |
| Postsales Team | 5 | Client Onboarding Team | 8 | Apoorva Goel | 11/25/2025 |
| Pre Admin Smart View | 3 | Admin | 11 | Apoorva Goel | 11/24/2025 |
| Intent | 14 | Bonanza Group, Bigul, Digital Onboarding Team, Customer Success Team, Cross Sales Team, Bonanza Wealth, SmartPing Test Team, Smart View Access for Intent Leads, GSM Calling | 4 | Apoorva Goel | 11/24/2025 |
| Support tickets | 12 | (none) | 1 | Vikrant Dale | 04/28/2025 |
| Dealers Opportunity | 10 | (none) | 2 | Pritee Mahore | 03/26/2025 |
| Opportunity Dashboard | 9 | (none) | 4 | Pritee Mahore | 09/11/2024 |
| All opportunities | 8 | (none) | 1 | Vikrant Dale | 03/28/2024 |
| Navi Mumbai smart view | 7 | Navi Mumbai team | 7 | Pritee Mahore | 03/11/2024 |
| Supervisor Smart View | 6 | (none) | 1 | madhushree prabhu | 11/21/2023 |
| Client Onboarding Team | 4 | (none) | 11 | Pritee Mahore | 11/17/2023 |
| Telecaller Smart View | 2 | (none) | 10 | madhushree prabhu | 07/21/2023 |

**Teams referenced** (partial org map derived from Smart View assignment):
Digital Onboarding Team, Digital Onboarding Team 1, OS-Sales-Team Bhopal,
OS Sales Hyderabad, Bonanza Group, Bonanza Group 1, Bigul, Bonanza Wealth,
Client Onboarding Team, Customer Success Team, Cross Sales Team, Navi Mumbai team,
Admin, SmartPing Test Team, Smart View Access for Intent Leads, GSM Calling

**Observations**
- 9 of 14 Smart Views have NO team assigned — either dead or relying on
  permission templates instead. Access control is inconsistent.
- Smart View "codes" (1-19) are non-contiguous: 11, 13, 15, 16, 17 are missing → deleted views.
- Naming is inconsistent: "Pre sales Smart View" vs "Pre Admin Smart View" vs
  "Telecaller Smart View" vs "Intent" vs "Trade Team".
- Tab counts of 10-11 (Telecaller, Client Onboarding, Pre sales, Pre Admin) indicate
  agents work from many parallel queues — a strong requirement for the new CRM's
  work-queue design.

## TASK TYPES

### To-Do types (2)
| Name | Modified By | Modified |
|---|---|---|
| Follow-Up | Ritesh Thakur | 05/13/2026 |
| Phone Call | System | 01/19/2022 |

### Appointment types (2, + "Default")
| Name | Modified By | Modified |
|---|---|---|
| Meeting | Apoorva Goel | 05/13/2026 |
| Client Support On Call | Pritee Mahore | 05/13/2026 |

**Observation**: Task/appointment modelling is *minimal* (4 types) while
Activities (54) and Opportunities (35) are enormous. Work that should be
"a task assigned to a person with a due date" is instead being modelled as
Opportunities and Activities. In the new CRM, a proper Task/Work-item entity
with due dates, SLAs, queues and escalation would absorb a large share of
what is currently mis-modelled.

## LISTS — 4,810 lists (!!)
Source: LEADS > Manage Lists
Total leads in system: **495,118** (per the "All Leads" dynamic list)

List types available: **Static**, **Dynamic**, **Refreshable**

Sample rows:
| List | Members | Type | Owner | Created |
|---|---|---|---|---|
| All Leads | 495,118 | Dynamic | System | 12/14/2021 |
| B2B BA & DSA Combined List_050526 | 12,519 | Refreshable | Ketki Naik | 05/05/2026 |
| All Active Clients 210826.csv | 21,379 | Static | Siddharth Sanghvi | 08/21/2026 |
| Vacant ID-DM61,86 to presales common id | 6,398 | Static | Manjushri Bajwa | 08/21/2026 |
| Pledge Rejected 210826.csv | 65 | Static | Siddharth Sanghvi | 08/21/2026 |
| Starred Leads | 1 | Static | Ritesh Thakur | 01/05/2026 |
| Call back replies - 4 PM – 6 PM | 1 | Dynamic | Himanshu Masurkar | 08/17/2026 |
| Call back replies - 2 PM – 4 PM | 1 | Dynamic | Himanshu Masurkar | 08/17/2026 |

**This is the single clearest governance failure in the tenant.**
4,810 lists against 495,118 leads. Names like `All Active Clients 210826.csv` and
`Pledge Rejected 210826.csv` show the dominant pattern: someone exports a CSV,
re-imports it as a static list, uses it once, and never deletes it. Date-suffixed
CSV names (`210826` = 21/08/26) confirm this is a *daily* habit.

### Implications for the new CRM
1. **Static lists are snapshots that rot.** A static list of "active clients" is
   wrong the next day. The new CRM should make *saved queries* (always-live) the
   default and make snapshots an explicit, expiring, audited artefact.
2. **The CSV round-trip is the real signal.** People are exporting to Excel,
   manipulating, and re-importing because the CRM can't express what they need
   in-product. Worth interviewing those users (Siddharth Sanghvi, Ketki Naik,
   Manjushri Bajwa) about *what* they do in Excel — that is a direct requirements
   backlog for the new system.
3. **Lists need ownership, TTL and lifecycle.** Auto-archive unused lists;
   require an owner and a purpose; expire static lists by default.

## CUSTOM FIELD SETS — 8
| Name | Description | Modified By | Modified |
|---|---|---|---|
| mxCallInsights | CustomFieldSet for CallInsights | System | 10/15/2025 |
| Opportunity | — | System | 10/09/2025 |
| Presales Profiling | — | System | 10/09/2025 |
| Geolocation | CustomFieldSet for Geolocation | System | 11/12/2024 |
| mx_Source | — | madhushree prabhu | 08/11/2023 |
| Post Sales Details | — | madhushree prabhu | 07/06/2023 |
| Activity Score | — | madhushree prabhu | 06/08/2023 |
| mx_Status | — | madhushree prabhu | 06/08/2023 |

## DEPENDENT LEAD FIELDS — **ZERO CONFIGURED**
Source: Settings > Leads > Dependent Lead Fields — "No records to display."

**This is a significant data-quality finding.** The tenant has
`mx_Disposition` (Connected / Not Contactable / Other / Invalid data) and
`mx_Sub_Disposition`, plus `mx_Objection_or_Concern_Category` /
`mx_Objection_or_Concern_Handling`, `mx_Non_Contactable_Reason(s)`,
`mx_Not_Interested_Reason` — all of which are *logically* child fields.
None are linked. So an agent can record Disposition = "Connected" together with
Sub-Disposition = "Number not reachable" and nothing prevents it.

**Requirement for the new CRM**: cascading/dependent picklists must be a
first-class, enforced feature — with validation at the API layer too, not just
in the UI, since a large share of writes here arrive via API/automation.
