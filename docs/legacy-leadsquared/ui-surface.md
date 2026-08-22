# Working UI Surface — Lead Grid & Lead Detail

## MANAGE LEADS (grid)
Total leads in system: **495,118**

**Default visible columns:**
Lead Name | Mobile Number | Lead Stage | Owner | Created On | Modified On |
First Intent | Intent | Lead Source | Client Code | Actions
(column chooser present — any field can be added)

**Quick filters (always-on bar):** Lead Stage, Lead Source, Owner, Date Range
**Date Range field selector:** Last Activity | Created On | Modified On
**Date Range presets:** All Time, Custom, Yesterday, Today, Last Week, This Week,
Last Month, This Month, Last Year, This Year, Last 7 Days, Last 30 Days

**Search:** free-text quick search (matches name, phone, email, client code) +
saved-filter chip UI.

**Advanced Search** — criteria builder:
- Row structure: `[Field] [Operator] [Value]`, e.g. `Opportunity Type` / `Is` / `Select Opportunity`
- `+ Add` to stack multiple criteria
- Match mode: **Any Criteria** (OR) / **All Criteria** (AND) — flat, no nested groups
- Actions: **Find Leads**, **Cancel**, **Save as Quick Filter**

> **Gap for the new CRM**: only a flat AND/OR across all rows. You cannot express
> `(A AND B) OR (C AND D)`. This is why users fall back to CSV exports + Excel,
> which is what produces the 4,810 lists. A proper nested query builder (or
> saved SQL-like segments) is a hard requirement.

## BULK ACTIONS (on selected leads)
Export Leads · Bulk Update · Send Email · Add to List · Add Activity ·
Add Opportunity · Change Owner · Change Stage · Delete · Reset all Filters ·
Messaging · Kaleyra Send SMS · Add to Zoom Webinar · Merge Leads

Note: `Kaleyra Send SMS` and `Add to Zoom Webinar` are **vendor-specific actions
injected into the core bulk menu** by connectors. The new CRM should expose a
plugin/action-extension point so integrations add actions without the vendor
name leaking into the core UX.

## LEAD DETAIL PAGE — anatomy

**Header:** avatar, Lead Name, **Lead Stage badge** (e.g. READY TO TRADE),
email, Ph, Mob, location (city, state, country)

**Header actions:** star (favourite), share, chat, edit, and quick-create buttons:
`Activity` · `Note` · `Opportunity` · `inbound Smartping test Form` · `Email` ·
`Activity` (2nd) · overflow (`more_horiz`)

> Note a *named tenant form* ("inbound Smartping test Form") is pinned as a
> primary header action, and "Activity" appears twice. The header action bar is
> configurable but has drifted.

**KPI tiles (top-left, configurable):**
`Lead Score` (335) · `No Of Not Connects` (41) · `No of Connects` (26) ·
`Number of Pitch Done` (—)

> These tiles are driven by `mx_` counter fields that automations maintain
> (see automations.md: "Connects and Attempts"). In the new CRM these should be
> **computed aggregates over the activity timeline**, not stamped counters —
> removing both the fields and the automations that maintain them.

**Lead Properties panel (left, collapsible, configurable field set):**
Client Code · Partner Code · PAN Number · Email · Alternate Email Address ·
Owner · Next Follow Up Date and Time · Disposition Notes Remarks ·
Telecaller Calling Status · Lead Source · Lead Age · Lead Number

**Main detail tabs:**
`Activity History` · `Lead Details` · `Opportunities` · `Tasks` (with count badge) ·
`Notes` · `Documents` · `Lead Share History` · `Audit Trail` · overflow · settings · refresh

**Activity History controls:** activity-type filter (`All Activities`),
time filter (`All Time`), `Clear Filters`, chronological timeline grouped by day.

**Timeline entry format:** date/time, type icon, activity name, body/preview
("Read More" for long content), and provenance —
`Added by <user> on <datetime>` / `Modified by <user> on <datetime>`.

Example entries observed: WhatsApp Message (system-sent marketing broadcast),
Inbound Call with duration ("Had a phone call with +91-… Duration: 2 minutes 50 seconds").

## OBSERVATIONS FROM A REAL RECORD

The sampled lead (Lead Age **643 days**, Lead Number 667058, stage READY TO TRADE,
Lead Score 335) shows:
- **41 "Not Connects" vs 26 "Connects"** — a 61% non-contact rate on a single lead
  over ~2 years. Contact-attempt governance (max attempts, cooling-off, auto-retire)
  is absent.
- **`Disposition Notes Remarks` is a free-text field being used as an append-only log**:
  `"verify | from submitted | no response call back | ringing | | | ringing |
  issue in selfie | say do | say do | pitch done say do | lunch kr rahe hai ..."`
  Multiple agents have concatenated notes into one field with `|` separators,
  including empty entries and mixed-language text.
  → **This is the strongest evidence in the whole audit that the current model
  lacks a proper per-interaction note.** Each of those fragments should be a
  timestamped, attributed note on its own call activity. As stored, it is
  unreportable, unsearchable, and destroys attribution.
  **New CRM requirement**: notes/outcomes belong on the interaction record, never
  appended into a text field on the parent.
- `Telecaller Calling Status = "Not Contactable"` while stage = READY TO TRADE —
  contradictory states coexisting, because the two fields are maintained by
  different automations with no cross-validation.

## AUDIT TRAIL & SHARING
A native `Audit Trail` tab and `Lead Share History` tab exist — so record-level
change history and share history ARE available in LSQ at the record level, even
though *field-level* history is not queryable/reportable (hence the "Capture X Date"
automations). Worth confirming exactly what the Audit Trail captures before
assuming the new CRM must rebuild it from scratch.
