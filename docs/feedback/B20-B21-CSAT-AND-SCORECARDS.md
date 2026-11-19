# B20 and B21: who records a case's CSAT, and what a Customer Care scorecard counts

**Prepared 19 Nov 2026 for Ritesh's decision, and decided the same day:**
B20 option C, the customer alone, with the seven rules in §3; B21 options 3
and 6 together, with the desk figure shown and CSAT as the share of 4s and 5s,
scored once there are 10 answers. The two Partner RM descriptions stay open
(B22, since decided). Building them is A15 and A16 in the checklist; A15,
B20's build, was done on 19 Nov, with the two further rulings of that day:
scores staff had entered are kept as history and not counted, and a reply is
a score when it starts with a number from 1 to 5 and carries no other number. A16, B21's build, was done on 19 Nov too, with that day's two
further rulings: a breach counts for whoever held the case when it breached,
in the period it breached; and the home screen and the case report show the
scorecard's CSAT, so there is one figure.

Both questions were found on 18 Nov while building A2d (`OPS-63`). They are
linked: B20 decides where a score comes from, B21 whose score it is.

---

## 1 · What the sources say

| Source | What it says | What it means here |
|---|---|---|
| **BRD §7.10**, as the code cites it (the BRD itself is not in the repository) | "CSAT goes out on close." | The survey goes **to the customer**, and the customer answers it. |
| **bonanzaonline.com** (Investor Information) and **bigul.co/contact** | One escalation path for both businesses: Customer Care → Head of Customer Care & Legal → Compliance Officer → CEO / Director. *"In absence of response/complaint not addressed to your satisfaction, you may lodge a complaint with SEBI at SCORES … Please quote your Service Ticket/Complaint Ref No."* Bigul: *"For support and feedback, please write to support@bigul.co."* | Whether a complaint was settled to the customer's satisfaction is **the customer's call**. The published next level up is the Head of Customer Care. Neither site describes a satisfaction survey. |
| **SEBI SCORES 2.0** (scores.sebi.gov.in; SEBI's investor FAQ, Oct 2024) | The complainant gives feedback on how the complaint was handled **within 15 days of closure**. If not satisfied, they may ask for a review within 15 calendar days. A complaint is disposed of when the complainant is satisfied, or files no review. | The regulator's own model: **only the complainant rates the resolution**, inside a 15-day window. |
| **Rulings already in this project** | The migration map: survey answers become dated interaction records of type `Survey`, not an overwritten field. Non-negotiables 1 and 3: one interaction timeline, and computed fields are schema. QA-05 (fixed): every figure on a Customer Care agent's Home is *the person's own*. Round 1: Customer Care is "an agent, not a supervisor, so Team does not apply". | A score is an interaction on the case's timeline, and the case's CSAT is worked out from it. An agent's figures are their own. |
| **Standard helpdesk practice** (Freshdesk, which the firm's support desk runs on today, and similar tools; ISO 10004 is the guidance standard for monitoring and measuring customer satisfaction) | The survey is sent automatically when the case is resolved. Only the customer answers it. One answer per resolution. Agents cannot change a rating. Low scores prompt a follow-up. The response rate is shown beside the score. | Nothing here is unusual. |

## 2 · What the CRM does today

- **Anyone who can open a case can set its score**, 1 to 5, over whatever is there, with no audit row. That includes the agent on their own case. No screen calls the route, but the API accepts it.
- The score feeds the **Customer Care scorecard** (KRA "CSAT", target 85%) and the **cockpit's rolling CSAT per agent**.
- The WhatsApp sent when a case is resolved asks *"Reply 1–5"*. **No reply is read as a score**: it is logged as an ordinary WhatsApp reply on the lead.
- That message names **"Bonanza" on Bigul's cases** too. It is sent **again** when a resolved case is then closed by hand.
- Nothing records **who resolved** a case: there is a resolved time, but no resolver.
- CSAT is calculated as **average × 20**, so an average of 4.2 shows as 84%.

---

## 3 · B20: who may record a case's CSAT score

| | Who records it | For | Against |
|---|---|---|---|
| **A** | Anyone who can open the case (today) | — | The agent can rate their own work. Nothing is audited. An auditor or the regulator would not accept it, and it inflates the KRA. |
| **B** | The case's agent, entering what the customer said on the closing call, audited | Catches customers who only talk by phone | The agent is marking their own exam. It cannot be checked. |
| **C** | **The customer alone**: their reply to the WhatsApp sent on resolution, or, for a partner's case, a rating on the portal | Credible. It is what the BRD and SCORES already describe. Nobody can game it. | Depends on customers replying. The reply has to be read (a small build: the WhatsApp webhook already receives replies). |
| **D** | C, plus a call-back to customers who did not answer, by someone who did not handle the case, marked "phone survey" and reported separately | More responses | Needs a person to make the calls, and two kinds of score kept apart. |

### Recommendation: **C now**; add D later only if too few customers answer

The rules that make C work:

1. **Ask once**, when the case is resolved, in the right business's name. Do not ask again on close.
2. **A reply of 1 to 5** from the number the message went to, **within 15 days** (SCORES' own feedback window), is the score. The first valid reply counts. Anything else stays an ordinary WhatsApp reply.
3. **It is a `Survey` interaction on the case's timeline**, and the case's CSAT is worked out from it (non-negotiables 1 and 3; the migration map's ruling).
4. **Staff cannot set or edit a score.** A wrong one (say, a customer's mistyped digit) is voided by an Admin, or by whoever is granted a `csat.void` permission (meant for the Head of Customer Care), with a reason, on the audit log.
5. **Reopening a case voids its score**, and the next resolution asks again.
6. **A score of 1 or 2 creates a call-back task** for the Head of Customer Care, due the next working day. This is the next level of the published escalation path, and catches the customer before they go to SCORES.
7. **The score is credited to whoever resolved the case** (see B21, option 3).

---

## 4 · B21: what "Cases resolved", "SLA breaches" and "CSAT" count on a Customer Care scorecard

| | Counts | For | Against |
|---|---|---|---|
| **1** | Everything the person can see: the whole desk in their business (**today**, since `OPS-63`) | Simple | Every agent gets the same number. Nobody can be coached or rewarded on it. It contradicts their own Home screen (QA-05) and the Round 1 ruling. |
| **2** | Cases assigned to them **now** | Simple; matches their Home screen | Credit follows the case when it moves. When a case is escalated, it moves to the manager, and its breach and its score go with it. |
| **3** | **Who did the work**: cases they resolved; breaches while the case was theirs; CSAT on cases they resolved | Fair. Later reassignment does not move it. This is how contact centres usually measure. | Needs a "resolved by" stamp and complete case history (D9). |
| **4** | A team target for everyone | Encourages teamwork | Free riders; no individual coaching or incentive. |
| **5** | A blend, e.g. 70% own + 30% desk | Balances the two | Harder to explain; two numbers behind every figure. |
| **6** | By position: an agent counts their own, anyone with reports counts their team, an Admin the whole business | Mirrors Sales: an RM's book is their own, a Supervisor's is "everyone reporting to you" | Needs the reporting line set (`manager_id`) for whoever heads Customer Care. |

### Recommendation: **3 and 6 together**, with the desk figure shown beside each one for context, not scored

Two definitions to settle with it:

- **CSAT = the share of answers that are 4 or 5** (the usual "CSAT %"), not average × 20. Show how many answers it is based on, and do not score it on fewer than **10 answers** in the period: below that, show "not enough answers yet". That is how the scorecard already treats a figure it cannot measure.
- **The two Partner RM descriptions**: either say what is counted ("Partners with Active status", "Partners still onboarding"), or keep the stricter meaning and name the number of days.

Option 3 depends on D9. A case's history is incomplete today: its assignee changes are not recorded at all, and an escalation, a merge or a portal reopen writes no history.
