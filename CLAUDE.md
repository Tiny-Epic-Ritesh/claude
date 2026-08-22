# CRM Build — Project Context

## What we're building
A replacement CRM for Bonanza Portfolio Limited / "Bigul" — retail stock broking
and trading, India, SEBI-regulated. Current scale: 495,118 leads, 83 active users.

## Research context — read before any schema, data-model, automation or
## permissions work

**`docs/legacy-leadsquared/`** — full audit of the production CRM we are
replacing. `LEADSQUARED-CRM-REFERENCE.md` is the master document. Every number
and field name was read from the live instance; none are estimated. Part 1 lists
the ten structural failures we must not repeat.

**`docs/salesforce-reference/`** — design patterns from a mature CRM platform.
`SALESFORCE-DESIGN-REFERENCE.md` is the master document. **Part 6 maps each
LeadSquared failure to the Salesforce pattern that solves it — that table is the
design brief.** Part 7 lists what NOT to copy.

## Standing rules
- Do NOT replicate LeadSquared's structure. Most of it is workaround, not design.
- Do NOT copy Salesforce's legacy duality (Profiles+PermSets+PermSetGroups,
  Page Layouts+Lightning Pages). Take the discipline, not the artefact count.
- The Salesforce org audited was vanilla with demo data. It is authoritative on
  architecture, not on what a broking CRM should contain.
- Business requirements come from the LeadSquared audit and stakeholder
  interviews, never from the Salesforce sample data.

## Non-negotiables (each traceable to a documented production failure)
1. One shared Interaction timeline; never mirror activity between records.
2. Notes attach to the interaction, never to a parent text field.
3. Computed fields are schema, not automation (Formula / Roll-Up equivalents).
4. Field-change history and stage entry/exit timestamps are first-class.
5. Label ≠ API name — two identifiers per field and entity.
6. Uniform configuration surfaces across all entities.
7. Access = one restrictive floor, then grant-only layers.
8. Owner is polymorphic (User or Queue). No shared logins.
9. Record types, not pipeline sprawl.
10. Segments are live nested queries, not stored membership rows.
11. Cascading picklist validation enforced at the API layer.
12. Explicit automation ordering + conflict detection + failure queue.
13. Configuration audit log from day one.
14. Vendor detail quarantined behind a normalised event contract.
