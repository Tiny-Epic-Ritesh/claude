# Bonanza AI CRM — Testing Feedback, Part 2

**Raised by:** Ritesh (Solutions Architect / CRM Admin)
**Date:** 31 August 2026
**Environment tested:** labs.tinyepic.in/ai-crm
**Items:** 25 points (35 line items including sub-points)

---

## How to use this document

While testing the portal built so far, I found several issues that need to be fixed, and I have also suggested a number of changes and enhancements. Please review every point below and implement the required fixes and changes.

**Ground rules:**

1. **Do not assume anything.** If any requirement is unclear or open to more than one interpretation, ask me before you build it.
2. A list of points I already know are ambiguous is given in **Section C — Open Questions**. Please answer/confirm these with me before starting work on the related items.
3. Where an item says "do not change anything else," treat that as a hard constraint — no unrelated refactors, no side effects on existing functionality.
4. Please confirm the ID and status of each item back to me as you work, so we can track progress against this list.
5. The **Priority** column is intentionally blank — I will fill it in.

**Legend — Type:** `BUG` = defect in what is already built · `ENH` = change/improvement to existing functionality · `NEW` = new capability not yet built.

---

## Section A — Index

| ID | Type | Area | Summary | Priority |
|---|---|---|---|---|
| P2-01 | NEW | Activities / Mobile | Geolocation capture when a Sales RM creates a meeting activity | |
| P2-02 | NEW | Setup / API | Admin-visible API URL, API Key and Secret Key (Open API) | |
| P2-03 | NEW | Environments / Release | UAT and Production environments with one-click promote and rollback | |
| P2-04 | ENH | User Management | Edit user, password reset link, ghost login (Salesforce-style) | |
| P2-05 | ENH | Roles & Permissions | Make roles and permissions editable and configurable | |
| P2-06 | ENH | Platform-wide | Explicit Save / Discard instead of auto-save | |
| P2-07 | ENH | Leads | Rename "Cards" to "Products" on the lead list page, all roles | |
| P2-08 | BUG | Email | Attachment section missing in Send Email from Product Cards pop-up | |
| P2-09 | ENH | Email | Outlook/Salesforce-style email composer, used at every send point | |
| P2-10 | BUG | Global Search | Two overlapping search boxes in the global search UI | |
| P2-11 | BUG | Lead Detail UI | Summary bar and product cards are not aligned; same on other tabs | |
| P2-12 | ENH | Lead Detail UI | Replace the unhelpful "2 Warm / 1 Active" lead summary | |
| P2-13 | BUG | Homepage | Summary tiles must drill through to those exact records | |
| P2-14 | NEW | Integrations | Connectors screen for Facebook, Google, CUBE, Smartping, etc. | |
| P2-15 | NEW | Setup / API | API and webhook management section, incl. key regeneration and logs | |
| P2-16 | ENH | Homepage | Custom date range filter on "Your Numbers" | |
| P2-17 | BUG + ENH | Dashboards | Homepage graphs: overlapping labels, chart types, custom dashboards | |
| P2-18 | BUG | Administration | Object list in configuration tab cannot be scrolled horizontally | |
| P2-19 | NEW | Setup | Show current database size usage, tenant-wise and object-wise | |
| P2-20 | NEW | Content Library | Create and manage content libraries | |
| P2-21 | ENH | All Objects | Detailed edit and configuration options for every object | |
| P2-22 | ENH | Marketing Hub | Edit and configuration provision with detailed setup options | |
| P2-23 | NEW | Integrations | Configure adapters and vendor endpoints | |
| P2-24 | BUG | Campaigns | "More" pop-up renders underneath the Campaigns box | |
| P2-25 | NEW | Integrations | Outlook configuration from Setup / Integration | |

---

## Section B — Detailed Requirements

### P2-01 · NEW · Activities / Mobile — Geolocation capture on meeting activity

Capture the user's geolocation whenever a Sales RM creates a new **meeting activity** against a lead. The business requires proof that when a meeting is recorded as a physical meeting, the user was actually present at that location.

**P2-01a** — Sales RM users will work almost entirely on the **mobile application**. The mobile UI and all related features must therefore work correctly, including location capture during activity creation.

*Original point: 1, 1a*

---

### P2-02 · NEW · Setup / API — Open API access for Admins and Super Admins

Provide an option for Admins and Super Admins to view and manage the CRM's **API URL, API Key and Secret Key**, so that these can be shared with vendors who need to push data into the CRM from their end. In short, an Open API capability for this CRM.

> **Note:** This overlaps with **P2-15**. Please confirm with me whether these are one screen or two before building (see Q-02).

*Original point: 2*

---

### P2-03 · NEW · Environments / Release Management — UAT and Production with promote and rollback

We need **two environments** of this CRM: **UAT** and **Production**.

- Bug fixes, enhancements to existing features, and new features are all built and tested in **UAT** first.
- There must be a provision to **push those changes from UAT into Production**.
- There must also be a provision to **roll back** a change from Production if anything goes wrong.
- Control must sit with **Admins and Super Admins**, through a simple UI where promotion to Production and rollback are handled at the click of a button.
- Research the **current industry-standard practice** for release management of this kind and build something equivalent into the CRM.

*Original point: 3*

---

### P2-04 · ENH · User Management — Edit user, password reset, ghost login

Provide the following on the user record:

- **Edit user** — update mobile number and other fields.
- **Send password reset link** to the user.
- **Log in as user (ghost login)** — view the portal exactly as that user sees it.
- **Log out of the user's portal** and return to the Admin / Super Admin user settings page.

Take reference from **Salesforce** for how it handles user management, and implement equivalent capability here.

**P2-04a** — Add **CUBE dialer** fields (campaign name, DID number mapping, etc.) to the user detail fields. These should sit in a **separate section** within user detail management.

*Original point: 4, 4a*

---

### P2-05 · ENH · Roles & Permissions — Make roles editable and configurable

Roles and permissions are currently **not editable**. They must be both editable and configurable. Admins and Super Admins should be able to:

- Manage existing roles and their permissions, and
- Create new roles and configure them in detail.

*Original point: 5*

---

### P2-06 · ENH · Platform-wide — Explicit save instead of auto-save

Any change made by an Admin or Super Admin on **any object** must not be saved automatically. Wherever a change is made, provide **"Save changes"** and **"Discard changes"** buttons so the change is committed only on an explicit action.

*Original point: 6*

---

### P2-07 · ENH · Leads — Rename "Cards" to "Products"

On the **lead list page**, rename the field label **"Cards"** to **"Products"**, for all roles.

*Original point: 7*

---

### P2-08 · BUG · Email — Attachment section missing

The **email attachment section is not available** when "Send an email" is selected from the **Product Cards pop-up action**.

*Original point: 8*

---

### P2-09 · ENH · Email — Outlook-style email composer everywhere

The current Send Email UI is not up to the mark. It should work like **Outlook**, with:

- Font and font-size selection (rich-text formatting),
- The ability to **create a new template**, and
- The ability to **select from saved templates**.

**Every** "Send Email" entry point across the portal must open this same composer. Take reference from the **Salesforce** email UI for the options and layout it offers.

*Original point: 9*

---

### P2-10 · BUG · Global Search — Overlapping search boxes

The global search box UI is broken. **Two boxes appear to overlap each other** — the magnifying glass sits in one box and the actual search input in another, positioned one above the other. Please fix the layout and improve the appearance.

**Constraint:** Keep the functionality exactly as it is. Do not change anything in its behaviour, and make sure nothing else is impacted.

*Original point: 10*

---

### P2-11 · BUG · Lead Detail UI — Summary bar and product cards misaligned

On the lead record, the **product cards list** and the **product summary bar** above it are not aligned with each other. The **Lead Score, AUM and Owner** boxes come in between and break the alignment.

- Correct the design so the summary and the detail below it line up sensibly, and improve the overall UI/UX.
- Move the lead summary boxes (Lead Score, AUM, Owner, etc.) somewhere else so the layout looks clean.
- The **same problem exists on the other tabs** as well — Lead Details, Activity, Notes, etc. Keep summary and detail aligned on all of them.

**Constraint:** Do not change anything else in the interface — fix only the alignment between the products summary tab and the product boxes.

*Original point: 11*

---

### P2-12 · ENH · Lead Detail UI — Replace the "2 Warm / 1 Active" summary

The **"2 Warm, 1 Active"** style summary shown in the lead summary section above is **not helpful**. It does not appear to serve any purpose and simply takes up space. Replace it with something genuinely useful.

*Original point: 12*

---

### P2-13 · BUG · Homepage — Summary tiles must drill through to the exact records

Clicking a figure on the homepage summary must open **exactly those records**. For example, clicking **"18 New Leads"** should open those 18 leads and nothing else. The same applies to **Unattended over 48H, Overdue Follow-ups, SLA Breached, Won**, and every other tile.

This must be corrected **across all roles**.

*Original point: 13*

---

### P2-14 · NEW · Integrations — Connectors screen

Provide a **Connectors** option in the UI for Admins and Super Admins to configure all the applications the CRM integrates with, such as:

- Facebook accounts
- Google accounts
- Telephony vendors such as **CUBE**
- WhatsApp providers such as **Smartping**
- Any other applications relevant to CRM integrations

Provide **detailed step-by-step instructions** for connecting each one, plus a **help portal** the user can be redirected to in order to debug issues faced while connecting an app to the CRM.

**P2-14a** — Connector configuration must be detailed, yet user friendly enough that any Admin, Super Admin or Marketing Manager can complete a connection **without anyone else's support**.

**P2-14b** — Take reference from **Salesforce** for how connectors are managed in its UI, and build a similar experience here.

**P2-14c** — It is acceptable for connector management to **open in a new tab**. Any configuration that involves multiple steps or a lot of text and UI can open in a new tab for a better user experience. However, do not compromise the functionality or the backend configuration logic — it must be robust and strongly competitive with current market practice.

*Original point: 14, 14a, 14b, 14c*

---

### P2-15 · NEW · Setup / API — API and webhook management

Provision to manage the CRM's **API URL, API Key and Secret Key** from the Admin and Super Admin logins. There must also be an option for Admins and Super Admins to **generate a new secret key**, so it can be shared with external vendors connecting their applications to the CRM.

**P2-15a** — Provision to manage **webhooks, telephony logs, API logs, payment logs, portal logs**, etc. — a complete section for API and webhook management. Make it as detailed as possible, while keeping it user friendly.

*Original point: 15, 15a*

---

### P2-16 · ENH · Homepage — Custom date range on "Your Numbers"

Add a **custom date range filter** to the "Your Numbers" section on the homepage, alongside the existing **Today, Month, Quarter and FY** options, so the user can define their own range and view the summary for it.

Ensure that the figures shown after the filter is applied also **drill through to exactly those records** (per P2-13).

*Original point: 16*

---

### P2-17 · BUG + ENH · Dashboards — Homepage graphs

The graphs currently shown on the homepage are not user friendly. On the **"Leads by Source – Month to Date"** graph, labels such as **Referral** and **IPO Enquiry** overlap each other.

**P2-17a** — Provide an option **within the graph** to change the chart type, offering whichever of the following are applicable to the data being displayed: bar charts, column charts, grouped/clustered bar charts, stacked bar charts, radial bar/column charts, line charts, area charts, step charts, stream charts, pie charts, donut charts, treemaps, Marimekko charts, sunburst diagrams, etc.

**P2-17b** — Provide the ability to **create a new dashboard** built from multiple graph options and conditions based on lead fields and other fields. **Custom filter options** must also be available.

**P2-17c** — Graph values must be **clickable**: clicking any number should open those specific records.

**P2-17d** — The **backend of the graphical dashboard must be robust**, so that the frontend never spills over or displays incorrect data.

*Original point: 17, 17a, 17b, 17c, 17d*

---

### P2-18 · BUG · Administration — Object list cannot be scrolled

In the **Administration → Configuration** tab, the object list is not user friendly: there is **no way to scroll right** to see the remaining options. Provide a **"View more"** option or a horizontal scroll so that all available options can be reached.

*Original point: 18*

---

### P2-19 · NEW · Setup — Database size usage

Provide a view somewhere in **Setup** that shows the **database size currently in use**, so the business is aware of how much storage is consumed — **across tenants**, with an **object-wise breakdown**.

*Original point: 19*

---

### P2-20 · NEW · Content Library — Create and manage libraries

Provide a provision to **manage the content library**: create a new library, and edit the details and settings of existing content libraries.

*Original point: 20*

---

### P2-21 · ENH · All Objects — Edit and configuration options

**Edit and configuration options must be available for all objects** for Admins and Super Admins, with relevant, detailed edit settings and configuration settings for each.

*Original point: 21*

---

### P2-22 · ENH · Marketing Hub — Edit and configuration

Provide **edit and configuration** capability in the **Marketing Hub**, with detailed setup options.

*Original point: 22*

---

### P2-23 · NEW · Integrations — Adapters and vendor endpoints

Provide options to configure **adapters, vendor endpoints, and similar**, in a detailed and self-explanatory manner. The UI and UX must be excellent, and nothing existing should be compromised by these changes.

*Original point: 23*

---

### P2-24 · BUG · Campaigns — "More" pop-up renders behind the Campaigns box

The **"More"** option under **Campaigns** is not user friendly: the **"More" pop-up opens underneath the Campaigns box**. Please fix it.

*Original point: 24*

---

### P2-25 · NEW · Integrations — Outlook configuration

Provide an option in **Setup / Integration** for Admins and Super Admins to **configure Outlook**, with detailed and user-friendly steps. It should sit alongside the other integration setup described in the points above (P2-14, P2-15, P2-23).

*Original point: 25*

---

## Section C — Open Questions (please confirm before building)

Please raise these with me — and anything else that is unclear — before you start implementation. **Do not assume an answer.**

**Q-01 · P2-01 Geolocation**
- Should location be captured for **all activity types** or only for meeting activities?
- Is capture **mandatory** — i.e. should the activity be blocked from saving if the user denies location permission?
- Is location captured at the moment the activity is **created**, at **check-in**, or at **save**?
- What should be stored and displayed — coordinates only, or coordinates plus a resolved address? Should it be visible to the RM, and must it be non-editable?
- How should **virtual / phone meetings** be handled?
- Does "mobile application" mean a **native app** or the **responsive web portal**?

**Q-02 · P2-02 and P2-15 overlap**
- Are these the **same requirement** (one API management screen) or two separate deliverables? If separate, what belongs in each?

**Q-03 · P2-03 UAT and Production**
- Should UAT have its **own database**, and if so, is production data copied/masked into it?
- Does **promotion** need an approval step, or is a single click by an Admin enough?
- Does **rollback** cover configuration and code only, or also **data and schema migrations**?
- How many previous versions must be retained for rollback?

**Q-04 · P2-04 User management and ghost login**
- Should ghost-login sessions be **audit-logged**, and is there a restriction on who can ghost into whom (e.g. can an Admin ghost into a Super Admin)?
- Which user fields must remain **read-only** (e.g. email / username / role)?

**Q-05 · P2-04a CUBE dialer fields**
- Please confirm the **full list of CUBE fields** required, and whether these should be **synced from CUBE via API** or entered manually.

**Q-06 · P2-05 Roles and permissions**
- What **granularity** is required — object level, field level, record level, or all three?
- Can the **system-defined roles** (Super Admin, Admin, Marketing Manager, Sales RM) be edited or deleted, or only cloned?

**Q-07 · P2-06 Save / Discard**
- Does this apply only to **Admin/Super Admin configuration screens**, or to end-user record edits as well (e.g. a Sales RM editing a lead)?
- What should happen if the user **navigates away** with unsaved changes?

**Q-08 · P2-09 Email composer**
- Which system actually **sends** the email — the Outlook integration in P2-25, or a separate SMTP / email service?
- Are templates **shared across the org** or private to the user, and are they **role-specific**?
- Are **merge fields / personalisation tokens** required in templates?

**Q-09 · P2-11 and P2-12 Lead layout**
- Where exactly should the **Lead Score, AUM and Owner** boxes move to?
- For P2-12, what would you consider a **useful** replacement summary? Should I propose options for your approval first?

**Q-10 · P2-13 and P2-17c Drill-through**
- Should drill-through open a **filtered list view of the same object** in the same tab, or a new tab? Should the applied filter be visible and editable by the user?

**Q-11 · P2-14 Connectors**
- Which **vendor accounts and credentials** will be available for development and testing?
- For Facebook and Google, which products specifically — e.g. Facebook Lead Ads, Google Ads, Gmail, Google Calendar?

**Q-12 · P2-15a Logs**
- What is the required **retention period** for each log type?
- Who can view them, and must they be **exportable / searchable**?

**Q-13 · P2-17b Custom dashboards**
- Who can **create** dashboards — all roles, or Admins and Super Admins only?
- Can a dashboard be **shared** with other users or roles, and can one be set as a role's default homepage?

**Q-14 · P2-19 Database size**
- Is the platform **multi-tenant**? Should an Admin see **all tenants** or only their own?

**Q-15 · P2-20 Content library**
- What does the content library hold — documents, images, email templates, marketing collateral?
- Who can create, edit and access libraries, and is access controlled by role?

**Q-16 · P2-25 Outlook**
- Is this a **Microsoft 365 OAuth** connection, and does it cover email send/sync, calendar, or both?
- Is it configured **once at the org level**, or connected **per user**?

---

## Section D — Cross-cutting constraints

These apply to every item above:

1. **No assumptions.** Raise a question rather than guessing.
2. **No collateral damage.** Where an item is a UI fix, the underlying functionality must remain unchanged and no other screen should be affected.
3. **Role coverage.** Any fix or change must be applied consistently **across all roles** — Super Admin, Admin, Marketing Manager and Sales RM — unless the item says otherwise.
4. **Mobile.** Sales RM usage is primarily on mobile; verify every change on mobile as well as desktop.
5. **Maintainability.** Configuration must be manageable by an Admin from the UI, not hard-coded.
6. **Confirm before closing.** Report each item back by ID with what was changed and how you tested it, so I can retest.
