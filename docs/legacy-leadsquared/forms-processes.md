# Forms & Process Designer

## PROCESSES — 10 published
Source: WORKFLOW > Process Designer. **All 10 use the same trigger type:
"At Specific Work Area"** (i.e. launched from a place in the UI, not event-driven).

| Process | Trigger | Status | Modified | Modified By |
|---|---|---|---|---|
| Client Information GSM | At Specific Work Area | Published | 08/12/2026 | Manjushri Bajwa |
| Presales Client Information Process | At Specific Work Area | Published | 07/15/2026 | Ritesh Thakur |
| Profiling /Trading/Reactivation - V3 | At Specific Work Area | Published | 07/10/2026 | Ritesh Thakur |
| Partner Information form process | At Specific Work Area | Published | 01/14/2026 | Ritesh Thakur |
| Profile/Trading/Reactivation Form-Inboun… | At Specific Work Area | Published | 01/08/2026 | System |
| Profile/Trading/Reactivation Form-Inboun… (2nd, same name) | At Specific Work Area | Published | 01/08/2026 | System |
| Inbound CNT Team Form | At Specific Work Area | Published | 12/01/2025 | Apoorva Goel |
| Call And Trade Outbound Call | At Specific Work Area | Published | 08/06/2025 | Pritee Mahore |
| Opportunity Areas | At Specific Work Area | Published | 06/13/2023 | System |
| Opportunity Areas - V2 | At Specific Work Area | Published | 06/07/2023 | System |

**Two processes share the same truncated name** ("Profile/Trading/Reactivation
Form-Inboun…"), both published the same day by System. Impossible to tell apart
from the list.

## FORMS — 14 published
Source: WORKFLOW > Manage Forms. All Type = **Primary**.

| Form Id | Name | Modified | Modified By |
|---|---|---|---|
| F4 | Product Activity Form | 02/24/2023 | System |
| F20 | Product Activity Form - V1 | 03/21/2023 | System |
| F21 | B2B Phone Call Form - V1 | 10/31/2025 | System |
| F46 | Inbound - Profile/Trading/Reactivation F… | 01/08/2026 | System |
| F73 | Partner Phone call Form | 09/09/2025 | System |
| F74 | Client Information Form | 02/16/2026 | Apoorva Goel |
| F75 | Create Support Ticket | 09/27/2024 | Pritee Mahore |
| F78 | Profiling/Trading/Reactivation Form V4 | 11/04/2025 | Apoorva Goel |
| F82 | B2B Partner Information Form v1 | 11/08/2024 | Pritee Mahore |
| F93 | Inbound - CNT/Profile/Trading/Reactivati… | 08/14/2025 | Pritee Mahore |
| F94 | Outbound-CNT Profiling/Trading/Reactivat… | 08/11/2025 | Pritee Mahore |
| F98 | Profiling/Trading/Reactivation Form V3 | 03/19/2026 | System |
| F102 | Client Information Form - GSM | 02/16/2026 | Apoorva Goel |
| F106 | Test Client code | 03/19/2026 | System |

Form ids are non-contiguous (F4…F106 with only 14 alive) → ~90 forms have been
created and deleted over the tenant's life.

## THE VERSIONING PROBLEM — clearest example in the whole tenant

Trace the "Profiling / Trading / Reactivation" capability across three subsystems:

| Layer | Artefacts |
|---|---|
| **Forms** | F46 "Inbound - Profile/Trading/Reactivation", F78 "…Form V4", F93 "Inbound - CNT/…", F94 "Outbound-CNT …", F98 "…Form V3" |
| **Processes** | "Profiling /Trading/Reactivation - V3", "Profile/Trading/Reactivation Form-Inboun…" ×2 |
| **Activity types** | code 226 "Profiling/Trading/Reactivation Form old", code 242 "…Form V4" |
| **Lead fields** | dozens of `mx_` fields populated by these forms |

So **one business capability** is spread across 5 forms, 3 processes and
2 activity types, with V3 and V4 both live simultaneously and an "old" variant
still enabled. Data written by each version lands in overlapping-but-different
field sets. Any report over "profiling responses" must union all of them.

### Requirements this generates for the new CRM
1. **First-class versioning** for forms/processes/schemas: one logical artefact,
   many versions, with an explicit "current" pointer and a documented migration
   path for in-flight records. Never two live versions with different field sets
   unless deliberately A/B tested.
2. **Inbound vs Outbound should be an attribute, not a separate form.**
   F93/F94 differ only by direction; they should be one form with a `direction`
   parameter and conditional sections.
3. **A form must declare its output schema.** Right now the link between
   "Form F78" and "which mx_ fields it writes" is invisible. The new CRM should
   make form→field→activity binding explicit and queryable, so you can answer
   "what writes to this field?" — which is currently unanswerable and is the root
   cause of the automation race conditions noted in automations.md.
4. **Retire-by-default.** "Test Client code" (F106), "Product Activity Form" vs
   "- V1", "Opportunity Areas" vs "- V2" all sit published indefinitely.

## PROCESS TRIGGER TYPES
Only "At Specific Work Area" is in use, though the Trigger filter implies others
exist. Processes here are **agent-invoked guided scripts** (call scripts,
information-capture flows), not automated workflows. That distinction matters:
in the new CRM these are "guided agent tasks / call scripts", a different feature
from background automation, and should be designed as such.
