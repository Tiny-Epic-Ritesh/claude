# P3-21 · Internal communication — design for scoping

**For:** Ritesh · **Date:** 11 September 2026
**Status:** proposal. Nothing is built. On 10 September you asked to see a
design with options and costs before scoping this, rather than confirm a scope
up front — this is that. The ticket's own acceptance clause is *"The module
design is reviewed with me before implementation begins."*

---

## 1 · What the ticket asks for

| # | Done when | Hard part |
|---|---|---|
| 1 | Users can send and receive direct messages within the CRM | Nothing to build on — there is no chat table |
| 2 | Admins configure who may message whom, and can monitor and restrict sensitive conversations | A policy, a reviewer role, and an audit of the reviewer |
| 3 | A lead transfer request can be raised from a conversation and reaches the target as an **actionable** request | Requests today go to everyone holding a capability, not to one named person |
| 4 | The requester is notified of the outcome, approved **and** declined | Already done by the approvals engine |
| 5 | Transfers and escalations done this way are recorded against the lead | Field history already records owner changes |
| 6 | The design is reviewed before build | This document |

---

## 2 · What already exists

This is why the costs below are smaller than a chat module from nothing.

| Piece | Where | What it already does | What it lacks |
|---|---|---|---|
| Notifications | `db.js` `notify()`, `/api/notifications` | A per-person inbox with read state and a link | **Shown only on the homepage.** Nobody on a lead page sees one arrive. No badge in the header |
| @mentions | `POST /notes` | Mentioning someone in a note notifies them — a conversation on the record, which is Salesforce's Chatter | Nothing outside a record |
| Approvals | `engine/approvals.js` | Refuses self-approval, checks capability **and** book, requires a reason to decline, applies the change in the same transaction as the decision, notifies the requester `Approved:` / `Rejected:` | Routes to **everyone** who holds the capability. Cannot be aimed at one named person, which clause 3 asks for |
| Reassignment | `lead.reassign` | Held by superadmin, admin, sales supervisor. Enforced on the lead write path | — |
| Audit | `audit()` | Records the real person behind a ghost session | — |
| Masking | `maskRecord`, `maskedFieldsFor(role)` | Per-role PII masking on every record read | — |
| Push to the browser | — | **None.** No server-sent events, no WebSockets | Everything is fetched on request |

The legacy audit has no internal-messaging feature to port. The nearest thing
in LeadSquared is an automation, *Payment Payin Lead Transfer to Post Sales
Team*, and the `mx_Lead_Reassign_Date` field — transfers happen, but the
request for one happens somewhere outside the CRM.

---

## 3 · Three options

### A · Conversations on the record — no direct messages · ~3 days

- A notification bell in the header with an unread count, fed by the existing
  inbox. Useful on its own: today a mention is invisible until you go home.
- **Ask for this lead** on the lead page, sent to a person you name. It arrives
  as an approval they can decide; you hear back either way.
- Record conversations stay what they are: notes with @mentions.

**Meets clauses 3, 4, 5 and 6. Fails 1 and 2** — there are no direct messages,
so there is nothing for an administrator to control or monitor.

### B · Direct messages with admin controls, and transfer requests inside them · ~9 days — *recommended*

Everything in A, plus:

**Messaging**
- One-to-one conversations, opened from a messages icon in the header with its
  own unread count.
- A message can carry a **lead chip**. The chip is drawn for each reader: if the
  reader can open that lead they see its name, masked for their role; if they
  cannot, it reads *a lead you cannot open*. The chip never copies the lead's
  details into the message, so attaching a lead cannot carry a client's details
  past the book boundary or past masking. (Text somebody *types* is theirs —
  that is what monitoring is for.)
- Nothing is hard-deleted. A sender can withdraw a message for a short window;
  the thread shows *withdrawn*, and a reviewer still sees the original.

**Admin controls (clause 2)**
- **Who may message whom:** a role-to-role grid in Setup. Default: anyone may
  message anyone in their own book. An administrator can close a pair — for
  example callers to dealers.
- **The book boundary holds:** a Bonanza user cannot open a conversation with a
  Bigul user. Superadmins, who span both books, are the exception.
- **Monitor:** a new capability, `comms.monitor`. Whoever holds it can read any
  conversation in their book. **Every read is itself audited** — who read which
  conversation, when — because a reviewer nobody reviews is the gap the audit
  keeps finding. Users see a standing line: *messages here can be reviewed by
  compliance.*
- **Restrict:** a reviewer or admin can freeze a conversation (read-only, with a
  reason both people see) or suspend one person's messaging.

**Transfer requests (clauses 3–5)** — see section 5.

**Delivery:** the browser asks for new messages — every 30 seconds for the
badge, every 5 seconds while a conversation is open. At 83 users the badge is
under three requests a second; even with twenty conversations open at once the
total stays under eight, and each one is a single indexed read. WebSockets
would need the proxy to pass upgrade headers, which is an nginx change and ruled
out. If polling ever feels slow, server-sent events can be added later without
touching nginx.

### C · Slack-style · ~5–6 weeks

B, plus channels, threads, reactions, file sharing, presence, search and
real-time push. **Recommended against.** It is the largest option and it
competes with whatever chat tool the firm already uses, instead of doing the
thing only the CRM can do.

---

## 4 · Why B

The part of this ticket that only the CRM can do is clause 3: a request that
knows which lead it is about, who owns it, who is allowed to grant it, and that
moves the lead in the same step as the yes. A general chat tool cannot do that,
however good it is. Option A delivers that part in three days but fails the two
clauses about direct messages that the ticket names. **B is the smallest thing
that meets all six.**

This does not change the priority I gave it on 9 September (fourth of five,
*"genuine value, but no evidence of it blocking anyone today"*). It prices it.

**Data residency.** Messages are stored in the CRM's own database, next to the
leads. Nothing is sent to a third-party chat service, and no message content is
sent to the AI provider, so this adds no new route by which client data could
leave India. Automatic flagging of sensitive conversations would need content
analysis; keyword rules run locally, AI flagging would not, so only keyword
rules are proposed and even those are not in the nine days.

---

## 5 · How a transfer request runs (option B)

1. Priya, an RM, is in a conversation with Arjun, her supervisor. She presses
   **Ask for a lead** and picks one. The picker lists only leads Priya can
   already see — a lead she cannot see she cannot name, or the request itself
   would tell her it exists.
2. That creates a `lead_transfer` approval aimed at Arjun. It appears in the
   thread as a card with **Approve** and **Decline**, and in his notifications.
3. It does **not** freeze the lead. The approval engine has a lock that stops
   a record changing while it is being approved, and today it is enforced only
   on partners. A transfer stays out of it deliberately: nothing about the lead
   is being approved except who owns it, and the current owner should keep
   working it until it moves.
4. **Approve** changes the owner through the same path as any reassignment: the
   owner change lands in the lead's field history, and the audit row names the
   request. **Decline** needs a reason.
5. Priya is notified either way (the engine already does this), and the card in
   the thread updates to show the outcome.

**Engine changes:** `approvals` gains `target_user_id`, so a request can be aimed
at one person; `APPROVAL_SCOPES` gains `lead_transfer`. The self-approval,
capability, book and reason checks all apply unchanged.

---

## 6 · What B costs

| Piece | Days |
|---|---:|
| Tables, the who-may-message-whom check, the book boundary, the message API | 2 |
| Header bell, messages panel, conversation view, lead chip | 2 |
| Targeted approvals, `lead_transfer`, the card in the thread | 1.5 |
| Monitoring with audited reads, freeze, suspend, the Setup grid | 1.5 |
| Tests — access and absence tests, mutation-checked — and a browser pass | 2 |
| **Total** | **~9** |

**New tables:** `conversation`, `conversation_member` (with a read marker),
`message` (soft-delete only), `messaging_policy`.

---

## 7 · What I need from you

**To start:**

1. **Which option** — A, B or C.
2. **Who may grant a transfer.** Anyone holding `lead.reassign` in the lead's
   book, certainly. Should the **current owner** also be able to hand over
   their own lead directly? My recommendation is yes, with their supervisor
   notified: giving away what you own takes nothing from anyone else, and
   routing it through a supervisor adds a wait without adding a check.
3. **Messaging across the two books.** My recommendation is refused, with
   superadmins excepted — the same boundary every other screen holds.
4. **Whether monitoring is disclosed to users.** My recommendation is yes, a
   standing line in the messages panel.

**Open, but not blocking a start:**

5. **What "escalation" means at Bonanza.** The CRM escalates in two places
   today: a case can be escalated by anyone holding `ticket.escalate`, and a
   missed follow-up reminder escalates to the RM's manager. Neither is a *lead*
   escalation. Is a lead escalated — and if so, by whom, to whom, and why?
6. **How long messages are kept.** That is a question for Bonanza's compliance
   officer. I am not asserting what the regulation requires.
7. **Should a transfer also appear on the lead's timeline**, or only in its
   history? On Q6a you kept a system note off the client's timeline; the same
   reasoning would put this in history only.
8. **Who holds `comms.monitor`.** There is no compliance role in the CRM today.

---

## 8 · What this is not

- Not client messaging. SMS and WhatsApp to clients are P3-17 and P3-20.
- Not a replacement for the firm's chat tool, unless you decide it should be.
- It composes with P3-16: the design there noted that *"tell Priya what she
  missed"* belongs here as a person-shaped automation action. Once direct
  messages exist, an automation can post into one.
