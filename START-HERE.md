# START HERE — CRM Build Context Pack

Everything Claude Code needs to understand what we have, what good looks like,
and what to build. Two research documents, one prompt, one setup step.

---

## STEP 1 — Put this in the repo

```bash
cd /path/to/your-crm-repo          # ← your actual repo
unzip ~/Downloads/crm-handoff.zip -d .
git add docs/ CLAUDE.md && git commit -m "docs: add CRM research context pack"
```

This creates:
```
docs/legacy-leadsquared/     ← 11 files. What we run today, and its failures.
docs/salesforce-reference/   ← 7 files. Target patterns from a mature platform.
CLAUDE.md                    ← persistent context (append if you already have one)
```

---

## STEP 2 — What's in the pack

### `docs/legacy-leadsquared/` — CURRENT STATE
Audited from the live Bonanza/Bigul production tenant, 21 Aug 2026.
Every number is real, read from the instance.

| File | Contents |
|---|---|
| **LEADSQUARED-CRM-REFERENCE.md** | **Master doc, 9 parts. Start here.** |
| lead-fields.md | All 338 lead fields + technical-debt catalogue |
| stages.md | 32 lead stages, and why the enum is overloaded |
| opportunities.md | 35 opportunity types with codes + the 4-entity split |
| activities.md | 54 activity types with tenant event codes |
| automations.md | 51 automations with lifetime trigger counts |
| users-roles.md | Roles, teams, sales groups, permission templates |
| views-tasks-lists.md | Smart Views, task types, the 4,810-list problem |
| integrations.md | 18 connectors, 15 LAPPS, vendor sprawl |
| forms-processes.md | 14 forms, 10 processes, the versioning problem |
| ui-surface.md | Grid columns, bulk actions, lead detail anatomy |

**Scale:** 495,118 leads · 338 fields · 32 stages · 35 pipelines · 54 activity
types · 51 automations · 4,810 lists · 83 users.

### `docs/salesforce-reference/` — TARGET PATTERNS
Audited from a Salesforce Trailhead Developer Org, same day.

| File | Contents |
|---|---|
| **SALESFORCE-DESIGN-REFERENCE.md** | **Master doc, 9 parts. Part 6 is the key table.** |
| field-types.md | Complete field type palette incl. Formula, Roll-Up, Encrypted |
| security-model.md | OWD, role hierarchy, sharing rules, profiles vs permission sets |
| object-anatomy.md | The 19 uniform per-object configuration surfaces |
| ui-layer.md | App/tab/record page anatomy, Path component, list views |
| automation.md | Flow, assignment rules, duplicate management, monitoring |
| setup-tree.md | Admin console information architecture |

**Caveat that matters:** the Salesforce org is vanilla with demo data. Trust it
for *architecture*. Do NOT trust it for what a broking CRM should contain —
business requirements come from the LeadSquared audit and stakeholder interviews.

---

## STEP 3 — The two documents relate like this

```
LeadSquared audit  →  "here is a real problem, at real scale, with evidence"
Salesforce ref     →  "here is how a mature platform solves that exact problem"
Part 6 of the SF doc  →  the mapping table between them  ←  THE DESIGN BRIEF
```

Nine of the ten LeadSquared failures have a direct Salesforce answer. Part 6
lists them side by side.

---

## STEP 4 — The prompt

Paste the contents of `PROMPT.md` (next to this file) into Claude Code.

---

## STEP 5 — Two things only you can fill in

The prompt has two placeholders. Replace them before sending:

1. **`[YOUR STACK]`** — what Claude Code has already built, in what
   language/framework, what database, and whether there's data in it yet.
   The gap analysis is only as good as this.
2. **`[SCOPE & TIMELINE]`** — full replacement vs. running alongside LeadSquared,
   and by when. Changes the migration architecture entirely.
