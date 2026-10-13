# QA-09, QA-24, QA-35 — what each status means

**Status:** decided 13 October 2026. Ritesh did not have definitions to give
and asked for them to be set from the business requirement and standard
broking practice. This is that, written down so it can be corrected in one
place, and the product now follows it. Anything here the business means
differently is a change to this page first.

The auditor's three findings were one conflation. A partner's client read
**Trading** while the lead read **New**. The Clients page showed **0 live
accounts** while Products showed 13 active product interests. A partner's
"lifetime commission" included an **Accrued** row nobody had been paid. Lead
rows read **Won** with every product Exploring, on hold or lost. And a lead
whose card was Active said **"no active products"**. Each label was computed
from whichever record was closest to hand, not from the one that decides it.

## The terms, and the record that decides each

| Term | Means | Decided by | Not |
|---|---|---|---|
| **Lead stage** (New → Won / Lost) | Where the sales conversation is | `leads.stage`, the Stage picklist in Setup | An account. A stage is the RM's view of the conversation |
| **KYC complete** | The applicant has finished the journey, eSign included | the KYC journey, `status = Complete` | An account. The application then goes to operations |
| **Operations reviewed** | Operations has checked the application against the documents | the journey's verification outcome | Opened. The DKYC success page says "review and activate within one working day" — that is this step and the next |
| **Account opened** (UCC issued) | The broker has allotted the client a Unique Client Code and uploaded it to the exchanges. Under SEBI's circulars a client cannot trade until that is done | a **client** record, `clients.client_code` | A product card. An Active card is not an issued trading account |
| **Won** | The lead became a client: its account was opened | the lead's stage, **set automatically when the account opens** | A product interest, a KYC submission or a good call |
| **Trading** (an *Active* client) | The account has traded in the last 90 days | the client's `last_traded_at`, derived on read | A product card. *Dormant* is the same account with no trade in 90 days — the retail-broking engagement convention the Clients tab already uses |
| **Inactive** (the exchanges' flag) | No trade or other qualifying activity for **24 months** across exchanges, since NSE circular NSE/INSP/64718 of 25 Oct 2024 (it was 12 months) | the exchange's UCC database | Dormant. Dormant is a 90-day business signal; Inactive is a regulatory status with re-KYC on reactivation |
| **Product Active** | The client holds that product — a running SIP, a funded PMS | the product card, `state = ACTIVE` | An account. A card says which products, not whether the account is open |
| **AUM** | The value of a client's Active products | the Active cards' values | A count. A zero-value Active card is still an Active product |
| **Commission accrued** | Earned and recorded for a period, not yet paid | `commissions.status` Accrued or Approved | Money received |
| **Commission paid** | Paid out | `commissions.status = Paid` | The lifetime total. Lifetime is paid plus accrued, and each is shown |

## Where the product now follows this

- **Partner Portal.** A client reads *Trading* only when the account traded in
  the last 90 days, *Dormant* when it has not, and its lead stage until an
  account is open — never from a product card. The funnel's last step is
  *Account opened*. "Converted" counts accounts opened. Earnings show **paid**
  and **accrued, not yet paid** separately; the lifetime figure is their sum
  and says so.
- **Partners in the CRM.** "Converted" counts the partner's referrals with an
  account, not with an Active card.
- **Won.** An account opening sets its lead to Won, recorded in the lead's
  field history like any other change. A Business policy, *A lead is marked
  Won only once its account is opened*, makes the rule hard: with it on, a
  person cannot set Won on a lead with no UCC. It is **off**, because until the
  account-opening feed reaches the CRM nothing records an account opening and
  the RM's own Won is the only signal there is. Switch it on when the feed is
  live.
- **The lead page.** The AUM tile says how many products are Active — it said
  "no active products" whenever the AUM date was missing — and an **Account**
  tile says whether the account is open, with its UCC.
- **The seed** no longer hands out Won at random: Won leads are the ones with
  an account.

## Sources

- NSE, *Unique Client Code* FAQ: members must allot UCCs and upload them to
  the exchange before the client trades.
- NSE circular NSE/INSP/64718, 25 October 2024: an account is inactive after
  24 months without trading or the other listed activity; earlier circulars
  said 12 months.
- The 90-day dormancy is the CRM's existing convention (`engine/clients.js`),
  kept as the business signal it was written as.
