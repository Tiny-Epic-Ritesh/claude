# Role → tab matrix — proposal for correction

**ENH-08.** You asked me not to assume, so this is a proposal with reasoning,
not a decision. Strike out anything wrong and I will build exactly what you
confirm.

**How to read it:** ● = visible · ○ = hidden · **?** = I am genuinely unsure and
have said why underneath.

---

## The proposed grid

| Tab | Super&nbsp;admin | Admin | Caller | Dealer | Sales&nbsp;RM | Sales&nbsp;Sup | Partner&nbsp;RM | Product&nbsp;RM | Product&nbsp;Sup | Cust.&nbsp;Care | Mktg |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Home | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Leads | ● | ● | ● | ● | ● | ● | ● | ● | ● | ○ | **?** |
| Clients | ● | ● | ○ | ● | ● | ● | ○ | ● | ● | ● | ○ |
| Pipeline | ● | ● | ○ | ● | ● | ● | ○ | ● | ● | ○ | ○ |
| Products | ● | ● | ○ | ● | ● | ● | ○ | ● | ● | ○ | ○ |
| Lead Lists | ● | ● | ○ | ○ | ● | ● | ○ | ○ | ○ | ○ | ● |
| Tasks | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Calendar | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ○ |
| Cases | ● | ● | ○ | ● | ● | ● | ● | ● | ● | ● | ○ |
| CCM | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ |
| KYC Console | ● | ● | ○ | ○ | ● | ● | ○ | ● | ● | ○ | ○ |
| Partners | ● | ● | ○ | ○ | ○ | **?** | ● | ○ | ○ | ○ | ○ |
| Approvals | ● | ● | ○ | ○ | ○ | ● | ● | ○ | ● | ○ | ○ |
| Market | ● | ● | ● | ● | ● | ● | ● | ● | ● | **?** | **?** |
| Campaigns | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● |
| Content | ● | ● | ○ | ○ | ● | ● | ● | ● | ● | ● | ● |
| Team | ● | ● | ○ | ○ | ○ | ● | ● | ○ | ● | **?** | ○ |
| Revenue | ● | ● | ○ | ○ | **?** | ● | ● | ○ | ● | ○ | ○ |
| KRA | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ○ |
| Incentives | ● | ● | ● | ● | ● | ● | ● | ● | ● | **?** | ○ |
| Reports | ● | ● | ○ | ○ | **?** | ● | ● | ○ | ● | ● | ● |
| Dashboards | ● | ● | ○ | ● | ● | ● | ● | ● | ● | ● | ● |
| Data Tools | ● | ● | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ● |
| Setup | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

---

## Reasoning, role by role

**Superadmin · Admin** — everything. These are the roles that configure the
system and the ones support falls back to. Hiding anything from them creates a
"why can't I see it" ticket without preventing a single mistake.

**Caller** — deliberately the narrowest set. A caller works a dial list: Leads,
Tasks, Calendar, Market for small talk, KRA and Incentives because they are
measured on it. No Clients, no Pipeline, no reporting — those are other people's
jobs and every extra tab is one more thing to scan past a hundred times a day.

**Dealer** — the trading desk view. Clients and Pipeline matter because they
work active accounts; Lead Lists and Campaigns do not.

**Sales RM** — their own book, end to end. Leads, Clients, Pipeline, Products,
KYC, Lead Lists, Cases. Not Team or Data Tools, which are supervisory.

**Sales Supervisor** — the RM set plus the supervisory layer: Team, Revenue,
Reports, Approvals, Data Tools.

**Partner RM** — Partners is the job. Leads and Cases because partner-sourced
leads and partner queries land on them. Not Pipeline or Products, which are the
direct-sales surfaces.

**Product RM** — leads carrying their product, and the KYC that follows. Not
Partners, not Lead Lists.

**Product Supervisor** — the Product RM set plus Team, Revenue, Reports and
Approvals.

**Customer Care** — Cases and CCM are the job, with Clients for context. No
Leads: a service agent works accounts, not prospects. No Pipeline, no Campaigns.

**Marketing Manager** — Campaigns, Content, Lead Lists, Reports, Dashboards,
Data Tools. Deliberately no Clients and no Pipeline — this role segments and
sends, and does not need to open individual client records. That is also why we
agreed masking stays on for them (Q-16).

---

## The seven cells I am unsure about

These change what people can do, so I would rather ask than pick.

1. **Marketing Manager → Leads.** They need to *build lists*, which means
   filtering leads. But that is arguably Lead Lists, not the Leads tab. Give
   them Leads, or make Lead Lists sufficient on its own?

2. **Sales Supervisor → Partners.** Do supervisors need visibility of partner
   relationships, or is that strictly Partner RM's territory?

3. **Customer Care → Market.** Useful context on a client call, or noise on a
   service desk?

4. **Marketing Manager → Market.** Campaign timing around market events could
   matter. Or it is a distraction.

5. **Customer Care → Team / Incentives.** Is Customer Care measured and
   incentivised the same way sales is? If they have no targets, both should go.

6. **Sales RM → Revenue and Reports.** Should an RM see their own numbers, or
   does reporting start at supervisor level? I have proposed **no** on the
   grounds that KRA and Incentives already show them their own performance —
   but this is a culture question, not a technical one.

7. **Approvals.** You flagged this as broadly visible when it should not be. I
   have limited it to Superadmin, Admin, both Supervisors and Partner RM.
   Confirm those are the five who actually approve things.

---

## How the control will work

Per your answer: **role level, with per-user override.**

- Each role has a default tab set — the grid above once you confirm it.
- An admin can grant or remove a single tab for one individual, and that
  override wins.
- This mirrors how permission sets already work here, so it is one concept to
  learn rather than two.
- Every change is written to the configuration audit log, so "who gave them
  Setup?" is answerable.

**One thing worth stating plainly:** hiding a tab is navigation, not security.
The API enforces capabilities independently, so removing a tab tidies someone's
screen but does not protect data — a user without `lead.view.all` still cannot
read other people's leads even if they reach the URL directly. The two work
together, and neither substitutes for the other.
