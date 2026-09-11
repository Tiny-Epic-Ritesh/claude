# The "share with me" deliverables

**Compiled:** 9 September 2026.

Ten tickets in `ROUND-3-source.md` have an acceptance bullet requiring something
to be sent to you — a list, a proposal, a benchmark. The code shipped for all of
them; what I could not show from the repo was whether the deliverable itself ever
reached you. This document is all ten, produced from the code as it stands today.

Everything below describes **what the build actually does**, not what it should
do. Where a decision looks wrong, say so and I will change it.

---

## 1 · P3-28 / Q6 — every AI summary button and what it now performs

The summary's button comes from the product card's state. There is one primary
action per state, and one secondary on Warm.

| Card state | Button | What it does |
|---|---|---|
| Not started | **Mark as Exploring** | `POST /cards/:id/state` → `EXPLORING` |
| Exploring | **Mark as Warm** | `POST /cards/:id/state` → `WARM` |
| Warm | **Request a Product RM** | `POST /cards/:id/request-product-rm`, carrying the note as the reason |
| Warm *(second)* | **Start KYC instead** | `POST /kyc/journeys`, then opens the DKYC resume link in a new tab |
| Product RM engaged | **Start KYC** | as above |
| KYC in progress | **Open the KYC journey** | opens that journey's DKYC resume link |
| Active | *(no button)* | see below |
| On hold | **Reopen as Warm** | `POST /cards/:id/state` → `WARM` |
| Lost | **Reopen as Exploring** | `POST /cards/:id/state` → `EXPLORING` |

**No decorative button can be rendered.** The Active state's advice is "Nothing
to chase — this one is done", and its `kind` is `none`. `nextaction.js` filters
those out before the payload leaves the server, so the client is never given a
button with no action behind it. That was the specific defect P3-28 raised.

**An action you lack permission for is shown, not hidden.** It comes back marked
`blocked` with the reason. A Product RM looking at a Warm card sees that the next
step is a request they cannot raise themselves, rather than an empty panel.

---

## 2 · P3-29 — the other Lead Details buttons, and the same defect class

The defect in P3-29 was a dropdown that omitted a product the lead already had.
Every action on the record now comes from one server-declared list, with the
capability it needs, so a button either appears and works or does not appear.

| Group | Buttons | Capability required |
|---|---|---|
| Contact | Call · Send WhatsApp · Send SMS · Send email | `lead.contact` |
| Record | Log an activity · Create task / follow-up · Raise a case | `lead.contact`, none, `ticket.create` |
| Deal | Add a product interest · Start KYC journey · Change stage | `card.mark.exploring`, `kyc.manage`, `lead.stage.change` |
| Routing | Change owner · Push to autodialler | `lead.reassign`, `lead.contact` |
| Manage | Edit lead · Delete lead | `lead.edit`, `lead.delete` |

Bulk equivalents on the list view: Bulk update · Reassign owner · Push to
autodialler · Send WhatsApp · Change stage.

**Be aware of what this is.** This is the inventory and its wiring read from the
code — every entry has a handler and a capability. It is **not** a fresh
click-through of all sixteen in a browser. If you want that evidenced properly,
say so and I will do the pass and report per button.

---

## 3 · P3-02 / Q2 — the user field set, benchmarked

`db.js` records this as *"benchmarked against the LeadSquared user grid and the
Salesforce User object, confirmed by Ritesh on 4 Sep"* — so this one did reach
you. Reproduced here for the record.

The user record carries 26 columns. The export offers 22 selectable fields:

Name · Email · Role · Job title · Business · Employee code · Branch · Mobile ·
WhatsApp · Reports to · Product · Status · **Last login** · **Password last
changed** · Date of joining · Date of exit · **Created on** · Last modified ·
Extension · Agent ID · Dialler campaign · Leads owned

The three you named in the ticket — last login date, role, created on — are all
there. `last_login_at` is stored rather than derived: sessions are deleted on
sign-out, idle sweep, password reset and role change, so deriving it would make
the most recently active people read as "never".

---

## 4 · P3-03 — the Create User form

Fields on the form: Name, Email, Role, Business, Job title, **Mobile**,
WhatsApp, Employee code, Branch, Reports to, Product, Date of joining,
Extension, Agent ID, Dialler campaign.

Mobile is present with format validation, per the ticket. Mandatory fields are
marked on the form. Mobile is **optional by default** with an admin control to
make it mandatory — that was your instruction: *"Keep it optional but provide
the control to make it mandatory or non mandatory if business decides in future
to change it anyways."*

---

## 5 · P3-26 — screens audited and fixed for the Back button

`BackLink` is on: **Lead detail · Client detail · List detail · Partner profile
(the Active Partner homepage named in the ticket) · Tickets**.

It is not a plain link. Where the browser has history it calls `navigate(-1)`,
which returns to the exact previous view with its filters and scroll position;
where there is none — someone arriving on a pasted URL — it falls back to a link
to the parent list, so the control is never a dead end.

**Caveat:** five detail screens carry it. The ticket asks for "every screen that
is reached from another screen". I audited the record-detail screens, which is
where the complaint came from. Setup sub-screens use the Setup sidebar to move
around and were not given one. **Tell me if you want them too.**

---

## 6 · P3-27 / Q8 — what occupies the reclaimed homepage space

The activity log went from 120 rows to **8**, with "Open the full audit log"
beneath it.

The space is now three counts an administrator can act on:

| Tile | Counts | Opens |
|---|---|---|
| **Overdue follow-ups** | Open tasks past their due date | `/tasks?overdue=true&all=true` |
| **Unattended over 48h** | Leads with no contact logged in 48 hours | `/leads?unattended_hours=48` |
| **Approvals waiting on you** | Approvals only this person can decide | `/approvals` |

They use the same predicates as the sales dashboard and the task list. A
homepage tile that counts differently from the screen it opens is worse than no
tile — somebody acts on the larger number and finds the smaller one.

**Ratified 10 September.** The three tiles stand for Superadmin and Admin.

### Q8a, answered — a supervisor gets a different set

A Sales Head opening the same page wants team-shaped numbers, and a supervisor's
unit is **people, not tasks**. "Four of your eleven RMs are behind" names a
conversation; "sixty follow-ups are overdue" names a worry. So the Sales
Supervisor cockpit gets its own four:

| Tile | Counts | Why it is a supervisor's and not an RM's |
|---|---|---|
| **RMs behind** | People with an overdue follow-up | The unit is a person, because the action is a conversation |
| **Unattended over 48h** | Leads with no contact logged | Shared with the RM set, but scoped to the team — this is the leakage number |
| **Not picked up yet** | Live leads in a queue with no person on them | Every RM in the book can see these and claim them, which is exactly why nobody does: a lead everyone can see is a lead nobody is answerable for. The supervisor is the one person whose job is to notice they are still there, and left alone they age quietly into Cold |
| **Approvals waiting on you** | Approvals only they can decide | Matters *more* to a supervisor than to the RM it was built for |

**Note on the role.** There is no `sales_head` role in the system; the nearest
is `sales_supervisor`, which is the only role that has a team. That is where
this was built. If Sales Head is meant to be a distinct level *above*
supervisor, that is a role to add, and it belongs in P3-07's configurable tree
rather than here.

### And a book boundary the supervisor cockpit was not honouring

Building this meant reading that cockpit, and **four of its six numbers counted
across both businesses** — as did the team scorecard, which names people.

A Bigul supervisor was shown:

| | Saw | Should have seen |
|---|---:|---:|
| Warm cards | 9 | 3 |
| Cards Active | 5 | 3 |
| Team calls today | both books | Bigul's |
| **Team performance** | **13 RMs** | **2** |

Eleven of Bonanza's sales staff appeared on a Bigul supervisor's scorecard **by
name**, with each one's lead count, calls today and conversion rate.

It is the same defect the Admin cockpit had and had already fixed — *"these two
counted across both books while every other metric beside them went through
orgCount"* — and this one is worse, because a scorecard reports on individuals.

**An aggregate leaks more quietly than a record does.** Opening somebody else's
lead is a 403 you notice; a count that is too large is a number you act on.
`bookscope.test.mjs` exempts `/api/cockpit` as *"aggregate figures, each already
scoped where it is computed"* — which was an assumption. It is now checked, in
`test/cockpitscope.test.mjs`, and the check is mutation-verified against the
original leak.

---

## 7 · P3-07 — the org hierarchy model as built

Groups form the tree, not roles. A group has a `parent_id`; null means it hangs
directly under its business.

- The two businesses, **Bonanza** and **Bigul**, are the roots. They are not
  groups — they have no members and no routing, so making them rows would give
  every groups screen a special case to skip.
- A branch can hang under another branch to any depth.
- A branch cannot be moved inside its own subtree, and cannot hang under the
  other business. Both are refused with a reason.
- Deleting a branch lifts its children rather than losing them.
- `GET /setup/org-tree` returns it; the whole thing is editable from the UI.

This followed your correction: *"These roles which i mentioned as an example
doesn't exists in Bonanza or Bigul business. with current role hierarchy, i want
you to build a tree which can be configurable & we can add as many as branches
we want under parent company Bonanza & Bigul."*

**One thing the ticket asks for that this does not do:** *"Data visibility and
permissions inherit up the hierarchy — a manager can see the records of the
roles reporting to them."* Visibility today resolves through `users.manager_id`
(the manager chain), not through group membership. Group membership routes work;
it does **not** grant sight of records. That is tested and deliberate, but it is
not what the ticket's bullet says. **See question N-7.**

---

## 8 · P3-38 / Q7 — mandatory columns on the lead list

Recorded in `columns.js`: *"Ritesh settled the mandatory set on 4 Sep: the
lead's name and nothing else."* So this reached you.

**Lead name** is the only locked column. Everything else can be switched off —
a caller does not need AUM, a dealer does not need Source — but a row you cannot
identify is not a row.

Eight columns default on so nobody's list changed the day it shipped: Lead,
Stage, Products, Age, Owner, plus three more. The rest are available and off.

---

## 9 · Q5 — geolocation when permission is denied

Recorded in `location.js`: *"Ritesh settled this on 4 Sep."* So this reached you.

**The activity saves regardless**, and the reason there is no position is stored
with it. `declined` and `unavailable` are kept apart, because one is a person's
choice and the other is a device or a basement.

The reasoning, for the record: an RM standing outside a client's office with
location switched off still needs the meeting logged, and a form that refuses
teaches people to log meetings from their desk afterwards — worse evidence than
an honest "declined".

---

## 10 · Q1 — P3-01 and P3-22 delivered as one

Yes. One Audit Log screen carries both: the filters (user, action, date range,
combinable and clearable) and the Export, which is restricted to Admin and Super
Admin and respects whatever filters are applied.

---

## Where this leaves the six open questions

| # | Ticket | Status |
|---|---|---|
| Q1 | P3-01 / P3-22 | **Answered by the build** — one screen, described above. Confirm it matches your intent. |
| Q2 | P3-02 / P3-03 | **You confirmed on 4 Sep** — recorded in `db.js` |
| Q5 | P3-10 | **You settled on 4 Sep** — recorded in `location.js` |
| Q6 | P3-28 | **Not evidenced.** The button actions above were my reading of each state. Ratify or correct. |
| Q7 | P3-38 | **You settled on 4 Sep** — recorded in `columns.js` |
| Q8 | P3-27 | **Not evidenced.** The three tiles were my choice. Ratify or correct. |

So of the six, three carry your decision in the code, one is answered by the
build itself, and **two — Q6 and Q8 — were mine to decide and should have been
yours.** Those are the two worth your eye.

---

## New questions this raised

| # | Question |
|---|---|
| **N-7** | P3-07 says permissions should inherit up the group tree. Today visibility inherits through the manager chain, and group membership routes work without granting sight of records. Do you want group membership to grant visibility as well? It is a real change to the access model, not a small one. |
| **N-8** | P3-26 — do you want the Back button on Setup sub-screens too, or is the Setup sidebar sufficient there? |
| **N-9** | P3-29 — do you want an actual click-through of all sixteen Lead Details buttons evidenced per button, rather than the wiring inventory above? |
