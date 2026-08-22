# Users, Roles, Teams, Sales Groups & Permissions

## LICENSING
- 132 active users allowed | **83 currently active**
- 5 active mobile users allowed
- 0 Marvin users, 0 MarvinLite users (feature licensed off)
- 50 sales groups allowed | **9 created**

## THE FOUR OVERLAPPING ACCESS-CONTROL MECHANISMS
LeadSquared layers **four** independent constructs. This is the key thing to
understand — and the key thing to simplify in the new CRM.

| Mechanism | What it controls | Count here |
|---|---|---|
| **Role** | Coarse persona; determines the base feature set | 4 |
| **Permission Template** | Granular feature/field permissions, assignable to users *or* groups | 12+ |
| **Team** | Hierarchical org unit; drives Smart View assignment & reporting rollup | 16 |
| **Sales Group** | Lead-access sharing / visibility group with Managers + Sales Users | 9 |

A single user therefore carries: 1 Role + N Permission Templates + 1 Team +
N Sales Groups. Effective access is the intersection/union of four systems with
no single screen showing "what can this person actually see?".

## ROLES (4 — fixed, not extensible)
| Role | Permission Template bound at role level |
|---|---|
| Administrator | (none — implicit full access) |
| Marketing User | Permission Template-Anup Sir Marketing |
| Sales Manager | (none) |
| Sales User | (none) |

Only 4 roles exist and they cannot be extended — every real-world persona
(dealer, telecaller, supervisor, post-sales, partner RM, B2B manager) has to be
expressed via Permission Templates instead. **The new CRM needs extensible roles.**

## PERMISSION TEMPLATES (Non-Admin category)
| Name | Assigned To | Modified By | Modified |
|---|---|---|---|
| Sales User Supervisor Permissions | 4 Users, 1 Group | Ritesh Thakur | 08/17/2026 |
| Administrator Permissions | **Not assigned yet** | Ritesh Thakur | 06/17/2026 |
| Bigul Dealer Permissions | 16 Users, 4 Groups | Ritesh Thakur | 06/05/2026 |
| Bigul DOT Template | 25 Users, 2 Groups | System | 06/03/2026 |
| Sales Manager Permissions | 3 Users, 1 Group | Manjushri Bajwa | 05/26/2026 |
| Test Permission Template | **Not assigned yet** | Ritesh Thakur | 03/30/2026 |
| all users | **Not assigned yet** | System | 03/16/2026 |
| Sales Manager GI Opportunity Viewing Permission | 1 User | System | 03/16/2026 |
| UAT Permission Template | **Not assigned yet** | System | 03/16/2026 |
| Marketing Manager Permissions | 1 User | System | 03/16/2026 |
| B2B Manager Permissions | 2 Users | System | 03/16/2026 |
| Permissions for Service Administrators | **Not assigned yet** | System | 03/16/2026 |
| Permission Template-Anup Sir Marketing | (bound to Marketing User role) | | |
| Admin Templates | (in use — seen on user records) | | |

**5 of 12+ templates are unassigned** — dead config. Names include a person
("Anup Sir"), an environment ("UAT"), and a literal "Test".

## TEAM HIERARCHY (16 teams, tree structure)
```
Bonanza Group                          (250 cumulative users / 44 direct)
├── Bigul                              (180 cumulative / 5 direct)
│   ├── Digital Onboarding Team
│   │   └── Customer Success Team
│   ├── Digital Onboarding Team 1
│   │   ├── Navi Mumbai team
│   │   ├── OS-Sales-Team Bhopal
│   │   └── OS Sales Hyderabad
│   ├── Client Onboarding Team
│   └── Cross Sales Team
├── Bonanza Wealth                     (3 / 3)
├── Admin                              (7 / 7)
├── Bonanza Group 1                    (0 / 0)   ← empty
├── SmartPing Test Team                (1 / 1)   ← test
├── Smart View Access for Intent Leads (0 / 0)   ← empty; a team used as an ACL hack
└── GSM Calling                        (15 / 15)
```
Note "Cumulative Users" (250) exceeds the 132 user licence — cumulative counts
include historical/inactive members.

**Observations:**
- "Smart View Access for Intent Leads" is a *team* created purely to grant view
  access — the team construct is being abused as an ACL because the permission
  model can't express it directly.
- "Bonanza Group 1" and "Digital Onboarding Team 1" — "1"-suffixed duplicates,
  a classic sign of someone re-creating rather than editing.
- Geography (Navi Mumbai, Bhopal, Hyderabad, Indore) is encoded in team names
  rather than as a location attribute. The new CRM should model location as data.

## SALES GROUPS (9 of 50)
Each group has Managers and Sales Users; controls lead access.

| Sales Group | Managers | # Sales Users | Modified |
|---|---|---|---|
| Bigul Dealer Team | 12 (Apurva Madage, Swapnil Kadam, Ravi Kumar, bigulcaller17, Gaurav Satange, Aarti Nirmal, Gaurav Patel, Bigulcross.RM1, Ram bharat kurmi, Harshad Jain, BigulCaller11, Ankit Gupta) | 1 | 11/27/2025 |
| Bigul Techno Team | 4 (Swapnil Kadam, bigulcaller17, Harshad Jain, BigulCaller11) | 1 | 01/01/2024 |
| Call & Trade Team | 4 (Swapnil Kadam, bigulcaller17, Harshad Jain, BigulCaller11) | 0 | 09/08/2025 |
| Client Onboarding Team | 5 (Apurva Madage, Swapnil Kadam, bigulcaller17, Harshad Jain, BigulCaller11) | 1 | 02/19/2026 |
| Post Sales Team | 10 (Kushe Saifee, Abhishek Jaiswal, Apurva Madage, Harish Khatri, Vishal Pare, Rahul Paliya, Apoorva Joshi, Simran Sachdev, Shreya Nagda, Riya Sharma) | 6 | 02/18/2026 |
| Presales Team - DM Indore | 6 (Swapnil Kadam, bigulcaller17, Bigulcallerdm81, Presales Common Id, Harshad Jain, BigulCaller11) | 23 | 07/06/2026 |
| Presales Team - Navi Mumbai | 5 (Swapnil Kadam, bigulcaller17, Presales Common Id, Harshad Jain, BigulCaller11) | 2 | 12/31/2025 |
| Reactivation Team | 0 | 1 | 05/30/2026 |
| Supervisor sales group view all location lead | 1 (Presales Common Id) | 0 | 10/20/2025 |

**Manager-heavy inversion**: Bigul Dealer Team has **12 managers and 1 sales user**.
Call & Trade Team has 4 managers and 0 users. This is not an org chart — the
"Manager" slot is being used to grant *visibility*, not to express reporting lines.

## SHARED / GENERIC ACCOUNTS — a security finding
Named accounts that are clearly shared logins, not individuals:
`bigulcaller17`, `BigulCaller11`, `Bigulcallerdm81`, `Bigulcross.RM1`,
`Biguldealer5@bonanzaonline.com`, `Presales Common Id`, `BigulCaller11`.

**Consequences in the current system:**
- Activity attribution is wrong — you cannot tell which human made a call.
- Audit trails are useless for these accounts.
- Offboarding is impossible (credential is shared).
- The `mx_` disposition/attempt fields attributed to these users are unusable
  for individual performance measurement.

**Requirement for the new CRM**: one identity per human, SSO-backed, with
delegation/queue models replacing shared logins. If a shared *queue* is needed
(e.g. "Presales Common"), it should be a **queue entity** that individually
authenticated users pull from — never a shared credential.

## USERS GRID — available columns
Name, Email Address, Role, Permission Templates, CampaignID, CampaignID 2,
Sales Groups, Created On, Phone (Mobile), Is Active, User Type
Filters: Type, Role, Status, Team. Actions menu + Create + Advanced Search + Export.
User Type values seen: **Regular** (others exist per licence tiers: mobile/marvin).

Note: `CampaignID` and `CampaignID 2` on the *user* record (values like
`BonanzaOnline_Postsales`, `Bigul_B2B_MUM`) — campaign attribution stored on
the user, used for routing/telephony. Another denormalisation to fix.

## USER-RELATED SETTINGS AVAILABLE
- Lead Assignment Quota (`/Settings/ManageLeadAssignmentQuota`)
- Opportunity Assignment Quota (`/Settings/ManageOpportunityAssignmentQuota`)
- Restriction using IP Whitelisting (`/Settings/IPRestriction`)
- User Check-in (`/Settings/UserManagementFeatures`)
- Work Day Templates (`/Settings/ManageWorkDayTemplates`) — e.g. "Bigul Working Hours"
- Holiday Calendar (`/Settings/HolidayCalendar`)
- Leave Tracker (`/Settings/LeaveTracker`)
- LeadSquared Support Access (`/Settings/SupportAccess`)
- Organization Switch (`/Settings/OrganizationSwitch`) — multi-org tenancy
- User Fields (`/Settings/ManageUserCustomFields`) — custom fields ON the user object

**Work-day / check-in / leave tracking is built into the CRM.** This is
workforce-management functionality (attendance, shifts, holidays, leave) bundled
with CRM. Decide explicitly for the new build whether that belongs in the CRM or
in an HRMS — the existing "Auto Check Out 8:00 PM" automation (128,482 triggers)
shows it is actively used.
