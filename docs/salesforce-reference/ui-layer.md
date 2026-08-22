# Salesforce UI Layer — verified from the Sales app

## 1. APP → TAB → RECORD hierarchy

An **App** is a named bundle of tabs with its own branding and nav.
Observed apps in this org: **Sales**, **Playground Starter**, plus others via App Launcher.

Sales app nav bar:
`Home · Opportunities · Leads · Tasks · Files · Accounts · Contacts · Campaigns ·
Dashboards · Reports · More ▾`

Key details:
- Every nav item has a **dropdown caret** exposing recent records + quick actions
  ("Opportunities List", "New Opportunity", recent items) — two-click access to
  any record without leaving the current page.
- **"More ▾"** absorbs overflow rather than wrapping or truncating.
- A **pencil icon** at the right of the nav bar = "Edit nav items" — end users can
  personalise their own tab set within an app.
- **App Launcher** (waffle grid, top-left) switches apps and searches all items.

> Design idea: the App is the unit of *persona*. Rather than one giant menu with
> permissions hiding items, you ship a Sales app, a Service app, a Partner app —
> each a curated tab set. Bigul's personas (presales, dealer, post-sales,
> partner RM, B2B) map directly onto this.

## 2. HOME PAGE
"Seller Home" — a dashlet grid of KPI cards, each a scoped query with a donut
chart and a breakdown:
- **Close Deals** — "Opportunities owned by me and closing this quarter" → Total
  Pipeline with Open / Won / Lost split
- **Plan My Accounts** — "Accounts owned by me" → 12 Accounts with
  Upcoming Activity / Past Activity / No Activity split
- **Grow Relationships** — Contacts

Note each card states its filter in plain English underneath the title
("Opportunities owned by me and closing this quarter"). The user always knows
what they're looking at.

## 3. LIST VIEW anatomy (Leads list)

Top row: object icon · **view-name dropdown** ("Recently Viewed ▾") · pin icon
(set default view)

Right-side action bar:
`New · Intelligence View · Import · Add to Campaign · Change Status · ▾`

Second row controls (left→right):
- **Search this list…** (scoped search within the view)
- ⚙ List view controls (New/Clone/Rename/Sharing/Edit/Delete)
- ▦ **Display-as switcher** (Table / Kanban / Split View)
- ↻ Refresh
- ⇅ **Sort**
- ✎ **Inline edit** toggle
- ◔ **Charts** panel
- ⧩ **Filters** panel

Below: "1 item • Updated a few seconds ago" — record count + data freshness.

Column headers each have their own dropdown (sort asc/desc, clip/wrap text).

> Contrast with LeadSquared: its Advanced Search offers a flat Any/All across
> criteria rows and no saved-view-as-object concept. Salesforce makes the **List
> View a first-class, shareable, permissioned object** with its own filters,
> columns, chart, and sharing scope. That is the direct fix for the 4,810-list
> problem — a live view instead of a CSV-derived static list.

## 4. RECORD PAGE anatomy (Lead)

Top to bottom, this is the reference layout:

**(a) Highlights Panel**
- Object type label ("Lead") above the record name ("Ms. Bertha Boxer")
- Record avatar/icon, colour-coded per object
- **Compact Layout fields** rendered as a horizontal strip:
  `Title · Company · Phone (2) ▾ · Email`
  — note `Phone (2) ▾` collapses multiple phone fields into one control
- Action buttons right-aligned: `Follow · Convert · Edit · New Case · ▾`
  (overflow ▾ = "Show more actions")

**(b) Path component**
A horizontal chevron progress bar of `Lead Status` values:
`Open - Not Contacted → Working - Contacted → Closed - Not Converted → Converted`
with a **"Mark Status as Complete"** primary button at the right end.
Completed stages render with a checkmark.

> **This is the single most transferable UI pattern for Bigul.** Path turns a
> status picklist into a guided, visible process with a clear next action. It
> also supports per-step "Key Fields" and "Guidance for Success" text. Compare
> LeadSquared's 32-value flat `ProspectStage` dropdown with no visual journey.

**(c) Tabbed workspace (left ~2/3)**
Tabs: `Activity · Details · Chatter`

- **Activity tab** = the composer + timeline.
  Composer buttons: `Log a Call ▾ · New Task ▾ · New Event ▾ · Email ▾`
  Below: **Activity Timeline** with filters —
  `All time • All activities • All types` and jump-to-top/bottom links.
- **Details tab** = the full field layout, two-column, with a **pencil icon per
  field** for inline edit (no page-level edit mode required). Fields are grouped
  into named sections.
- **Chatter tab** = record-scoped collaboration feed.

**(d) Related panel (right ~1/3)**
- Duplicate-detection callout ("We found no potential duplicates of this Lead.
  No duplicate rules are activated.") — proactive data-quality surfacing
- **Related lists** with counts: `Campaign History (0)` each with its own
  "Show actions" menu

**(e) Utility bar** (fixed bottom strip)
`To Do List` — persistent across all pages in the app, survives navigation.

## 5. THE COMPOSABILITY MODEL

Salesforce separates four layout concepts that are usually conflated:

| Concept | Controls | Configured in |
|---|---|---|
| **Compact Layout** | The 4-5 fields in the highlights strip and mobile cards | Object Manager > Compact Layouts |
| **Page Layout** | Field arrangement, sections, related lists, buttons (classic + Details tab source) | Object Manager > Page Layouts |
| **Lightning Record Page** | Which *components* appear where (Path, Tabs, Related, custom) | Lightning App Builder |
| **Search Layout** | Columns in search results, lookup dialogs, list views | Object Manager > Search Layouts |

Plus **Field Sets** — named, reusable field groupings addressable from code.

> Four separate concerns, each independently assignable **by profile and by
> record type**. So a Dealer sees a different Lead page than a Presales agent,
> from the same object, with no code.

## 6. ACTIONS & BUTTONS

Configured at Object Manager > **Buttons, Links, and Actions**, plus
Setup > **Global Actions** for object-independent actions.

Action types available:
- Standard actions (New, Edit, Delete, Clone, Convert)
- **Quick Actions** — create-a-related-record with prefilled fields, rendered as
  a modal without leaving the page (e.g. `New Case` on the Lead)
- **Custom Buttons/Links** — URL, Visualforce, or JavaScript
- **Flow actions** — launch a guided flow from a record
- Actions are assigned to layouts, so **which buttons appear is layout-driven,
  not hard-coded**

> The `Convert` button on Lead is the standout domain pattern: a single action
> that transforms a Lead into `Account + Contact + Opportunity` in one
> transaction, with configurable behaviour (Lead Settings: "Require Validation
> for Converted Leads", "Preserve Lead Status", "Hide Opportunity Section",
> "Create a Task During Lead Conversion when Subject is Blank").
> **This is the pattern Bigul's "Lead → Customer" journey needs**, instead of a
> stage value that silently means "is now a customer".

## 7. UI SETUP SURFACE (Setup > User Interface)
Action Link Templates · Actions & Recommendations · App Menu · Console Settings ·
Custom Labels · **Density Settings** · Global Actions · **Lightning App Builder** ·
Lightning Extension · **Path Settings** · Quick Text Settings · Record Page Settings ·
**Rename Tabs and Labels** · Sites and Domains · **Tabs** · Themes and Branding ·
Translation Workbench · User Interface

Two worth calling out:
- **Rename Tabs and Labels** — you can rename standard objects org-wide
  ("Lead" → "Applicant") without touching the API name. Bigul renames
  "Opportunity" in LeadSquared via a setting too; Salesforce does it safely
  because label and API name are decoupled.
- **Translation Workbench** — multi-language labels as a platform feature.
  Relevant given the mixed-language notes observed in the LeadSquared data.
