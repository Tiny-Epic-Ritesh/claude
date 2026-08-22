/**
 * Offline AI provider.
 *
 * Deterministic heuristics that produce genuinely useful output with no API key,
 * so the whole product demos on a laptop with no network. Output shapes are
 * identical to the Claude provider — only the quality differs.
 */

import { money } from './prompts.js';

export const name = 'offline stub';
export const live = false;

const has = (text, ...words) => words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));

const INTEREST = ['interested', 'sounds good', 'send me', 'share the', 'how much', 'minimum', 'start with', 'invest', 'open', 'sip', 'go ahead', 'proceed'];
const STRONG = ['go ahead', 'proceed', 'let us start', "let's start", 'open the account', 'ready to invest', 'send the form', 'do the paperwork'];
const NEGATIVE = ['not interested', 'no budget', 'later', 'busy', 'do not call', "don't call", 'remove my number', 'already have'];
const COMPLIANCE = {
  Complaint: ['complaint', 'complained', 'grievance', 'escalate', 'ombudsman'],
  'Mis-selling risk': ['mis-sold', 'misled', 'not told', 'hidden charge', 'cheated'],
  'Guaranteed-return expectation': ['guaranteed', 'assured return', 'fixed return', 'no risk'],
  'Regulatory mention': ['sebi', 'regulator', 'scores portal', 'exchange complaint'],
  'Urgency on funds': ['urgent', 'immediately transfer', 'withdraw now', 'need the money today'],
};

/* --------------------------------------------------- call disposition */

export function disposition(ctx) {
  const text = String(ctx.transcript || '');
  const lower = text.toLowerCase();

  const notReached = /not reachable|no answer|didn'?t pick|switched off|voicemail|ringing/i.test(text) || text.trim().length < 25;
  const negative = NEGATIVE.some((w) => lower.includes(w));
  const callback = /call.{0,10}back|call me (on|at|next)|monday|tuesday|wednesday|thursday|friday|tomorrow|next week/i.test(text);
  const interested = INTEREST.some((w) => lower.includes(w));
  const strong = STRONG.some((w) => lower.includes(w));

  const outcome = notReached ? 'Not Reachable'
    : negative ? 'Connected — Not Interested'
      : callback ? 'Connected — Callback Requested'
        : interested ? 'Connected — Interested'
          : 'Connected — Interested';

  // Which products came up, matched on product name and common aliases.
  const aliases = {
    MF: ['mutual fund', 'sip', 'flexi cap', 'elss', 'nav'],
    EQD: ['equity', 'shares', 'stock', 'f&o', 'futures', 'options', 'intraday', 'delivery'],
    COM: ['commodity', 'gold', 'silver', 'crude', 'mcx'],
    CUR: ['currency', 'forex', 'usdinr'],
    PMS: ['pms', 'portfolio management'],
    SMART: ['smart portfolio', 'basket', 'model portfolio'],
    FI: ['bond', 'ncd', 'fixed income', 'debenture', 'g-sec'],
    GLOBAL: ['global', 'us stock', 'international', 'nasdaq'],
    INS: ['insurance', 'term plan', 'life cover', 'ulip'],
    DP: ['demat', 'depository'],
    RES: ['research', 'recommendation', 'advisory', 'tips'],
  };

  const discussed = ctx.cards.filter((c) => {
    const words = aliases[c.product_code] || [];
    return lower.includes(String(c.product_name).toLowerCase()) || words.some((w) => lower.includes(w));
  });

  const card_changes = discussed
    .filter((c) => ['INACTIVE', 'EXPLORING'].includes(c.state))
    .map((c) => {
      const to = negative ? 'LOST' : strong ? 'WARM' : 'EXPLORING';
      if (c.state === to) return null;
      if (c.state === 'EXPLORING' && to === 'EXPLORING') return null;
      return {
        product_code: c.product_code,
        from_state: c.state,
        to_state: to,
        evidence: negative
          ? 'Lead declined this product on the call.'
          : strong
            ? 'Lead gave an explicit go-ahead on the call.'
            : 'Product was discussed and the lead asked follow-up questions.',
      };
    })
    .filter(Boolean);

  let compliance_flag = 'None';
  let compliance_note = '';
  for (const [flag, words] of Object.entries(COMPLIANCE)) {
    if (has(lower, ...words)) {
      compliance_flag = flag;
      compliance_note = `Transcript contains language associated with "${flag.toLowerCase()}". Review before further outreach.`;
      break;
    }
  }

  const next_action = notReached ? 'Callback'
    : negative ? 'No Action'
      : compliance_flag !== 'None' ? 'Raise Ticket'
        : strong ? 'Start KYC'
          : callback ? 'Callback'
            : /brochure|details|send/i.test(text) ? 'Send Brochure' : 'Callback';

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = notReached
    ? 'Call did not connect. No conversation took place.'
    : `${sentences.slice(0, 2).join(' ').slice(0, 320) || 'Call completed.'}${discussed.length ? ` Products discussed: ${discussed.map((d) => d.product_name).join(', ')}.` : ''}`;

  const commitments = sentences
    .filter((s) => /\b(will|i'll|we'll|send|share|call you|revert|get back)\b/i.test(s))
    .slice(0, 3)
    .map((s) => s.trim());

  return {
    outcome,
    summary,
    products_discussed: discussed.map((d) => d.product_name),
    card_changes,
    commitments,
    next_action,
    next_action_due_hours: next_action === 'Callback' ? 24 : 4,
    follow_up_task: next_action === 'Send Brochure' && discussed[0]
      ? `Send ${discussed[0].product_name} brochure on WhatsApp`
      : next_action === 'Start KYC' && discussed[0]
        ? `Send ${discussed[0].product_name} KYC link and follow up`
        : next_action === 'Callback' ? 'Call back as promised' : 'Log outcome and review',
    compliance_flag,
    compliance_note,
    score_signal: notReached ? 0 : strong ? 15 : interested ? 8 : negative ? -5 : 3,
  };
}

/* ------------------------------------------------------ ticket summary */

export function ticketSummary(ticket, replies) {
  const last = replies[replies.length - 1];
  const product = ticket.product_name ? ` on ${ticket.product_name}` : '';
  const opened = String(ticket.created_at || '').slice(0, 10);

  const line1 = `${ticket.subject}${product} — reported ${opened}, priority ${ticket.priority}.`;
  const line2 = ticket.status === 'Waiting on Client'
    ? `Agent responded${last ? ` on ${String(last.created_at).slice(0, 10)}` : ''}. Waiting on the client to respond.`
    : ticket.status === 'Resolved'
      ? `Marked resolved${ticket.resolved_at ? ` on ${String(ticket.resolved_at).slice(0, 10)}` : ''}. Auto-closes 72h after resolution.`
      : last
        ? `Last update ${String(last.created_at).slice(0, 10)} by ${last.author_type}: ${String(last.body).slice(0, 110)}`
        : `No replies yet. Awaiting first response from ${ticket.assignee_name || 'the assigned agent'}.`;

  return { line1, line2 };
}

/* ----------------------------------------------------- next best action */

export function nextAction(ctx) {
  const complaint = ctx.tickets.find((t) => t.priority === 'Critical' || t.priority === 'High');
  if (complaint) {
    return {
      action: `Resolve ticket ${complaint.ref} before any further sales contact`,
      channel: 'Internal', product_code: '-', urgency: 'Today',
      reason: `An open ${complaint.priority.toLowerCase()}-priority ticket outranks sales activity on this lead.`,
      talking_point: `Acknowledge the open issue first: "${complaint.subject}".`,
    };
  }

  const stalled = ctx.journeys.find((j) => j.status === 'Stalled' || j.status === 'Abandoned');
  if (stalled) {
    return {
      action: `Call and walk the lead through "${stalled.current_step_label}" to restart KYC`,
      channel: 'Call', product_code: stalled.product_code || '-', urgency: 'Today',
      reason: `${stalled.product_name} KYC is ${stalled.status.toLowerCase()} at ${stalled.progress_pct}% — assisted completion is required.`,
      talking_point: 'Offer to stay on the line while they complete the step — most drop-offs recover with one guided call.',
    };
  }

  const warm = ctx.cards.find((c) => c.state === 'WARM');
  if (warm) {
    return {
      action: `Progress the warm ${warm.product_name} card towards KYC`,
      channel: 'Call', product_code: warm.product_code, urgency: 'Today',
      reason: 'A warm card left unattended cools fast — this is the highest-value open signal on the lead.',
      talking_point: `Confirm the amount and timeline for ${warm.product_name}, then send the onboarding link on the call.`,
    };
  }

  if (ctx.daysSinceContact > 21) {
    return {
      action: 'Re-engage — the lead has gone quiet',
      channel: 'WhatsApp', product_code: '-', urgency: 'This week',
      reason: `No contact for ${ctx.daysSinceContact} days and the lead is in the ${ctx.ageBand} band.`,
      talking_point: 'Lead with something useful (a market note or a product update) rather than a check-in.',
    };
  }

  const exploring = ctx.cards.find((c) => c.state === 'EXPLORING');
  if (exploring) {
    return {
      action: `Convert interest in ${exploring.product_name} into a confirmed Warm signal`,
      channel: 'Call', product_code: exploring.product_code, urgency: 'This week',
      reason: 'The card is at Exploring — one qualifying conversation decides whether it moves or drops.',
      talking_point: `Ask what would need to be true for them to start with ${exploring.product_name} this month.`,
    };
  }

  return {
    action: 'Qualify the lead against a first product',
    channel: 'Call', product_code: '-', urgency: 'This week',
    reason: 'No product card has moved off Inactive yet — there is no signal to work with.',
    talking_point: 'Open with their current investing setup, not a product pitch.',
  };
}

/* ------------------------------------------------------------ KYC coach */

const CAUSES = {
  MOBILE_OTP: ['OTP not delivered, or the applicant is checking the wrong handset.', 'Ask them to check for a message from BONANZ and offer to resend — DND settings often delay it.'],
  EMAIL_OTP: ['The verification mail has landed in Promotions or Spam.', 'Ask them to search their inbox for "Bonanza verification" including the spam folder.'],
  PAN: ['PAN format or the date of birth does not match the income-tax record.', 'Read the PAN back digit by digit and confirm the DOB exactly as printed on the card.'],
  AADHAAR_DIGILOCKER: ['DigiLocker consent screen abandoned, or the Aadhaar-linked mobile is not with them.', 'Confirm they have the Aadhaar-linked phone in hand before they retry — the OTP goes there, not to their primary number.'],
  PERSONAL: ['Long form and the address does not match the Aadhaar record.', 'Tell them to use the address exactly as on Aadhaar; corrections can be handled later by modification.'],
  FINANCIAL: ['Hesitation over declaring income.', 'Explain that income band is a SEBI requirement for segment eligibility, not a credit check.'],
  BANK: ['Penny drop failed on a name mismatch, or the account is a joint account.', 'Ask for an account where they are the first holder, or take the bank-proof upload route.'],
  BANK_PROOF: ['Photograph of the cheque is unreadable or the name is not printed.', 'Ask for a cancelled cheque with the name printed, or the first page of the passbook.'],
  NOMINEE: ['Unsure whether to nominate, or does not have the nominee PAN/DOB to hand.', 'They can opt out now and add a nominee later — do not let this block the account.'],
  SEGMENTS: ['Unsure which segments they need.', 'Recommend Equity Cash to start; F&O can be added later and needs income proof.'],
  INCOME_PROOF: ['Income proof not immediately available.', 'Six months of bank statements is usually the easiest of the accepted documents to produce.'],
  SELFIE: ['Camera permission blocked in the browser.', 'Ask them to allow camera access, or switch to their phone for this step.'],
  SIGNATURE: ['No clean signature image available.', 'Sign on plain white paper in good light and photograph it straight on.'],
  ESIGN: ['Aadhaar OTP not arriving, or the Aadhaar mobile is not linked.', 'Confirm the Aadhaar-linked number is active; if it is not, they need offline verification.'],
};

export function kycCoach(j) {
  const [likely_cause, what_to_say] = CAUSES[j.step_code] || [
    'The applicant has paused on this step without an obvious blocker.',
    'Call and offer to complete the remaining steps together.',
  ];
  const overMin = Math.round((j.seconds_on_step || 0) / 60);
  return {
    likely_cause,
    what_to_say,
    recommended_channel: overMin > 20 ? 'Call' : 'WhatsApp',
    escalate: j.status === 'Abandoned',
  };
}

/* -------------------------------------------------------------- copilot */

export function copilot({ question, snapshot }) {
  const q = question.toLowerCase();
  const L = snapshot.leads;

  if (/who.*(call|contact|reach|priorit)|today|focus|start with/.test(q)) {
    const ranked = [...L]
      .sort((a, b) => (b.score - a.score) || (b.days_since_contact - a.days_since_contact))
      .slice(0, 5);
    return {
      reply: ranked.length
        ? `Work these first:\n${ranked.map((l, i) => `${i + 1}. ${l.name} — score ${l.score}, ${l.age_band} (${l.age_days}d), last contact ${l.days_since_contact === 999 ? 'never' : `${l.days_since_contact}d ago`}${l.card_summary ? `, cards: ${l.card_summary}` : ''}`).join('\n')}`
        : 'You have no leads assigned right now.',
    };
  }

  if (/breach|sla|overdue ticket|escalat/.test(q)) {
    const b = snapshot.tickets.filter((t) => t.breached);
    return {
      reply: b.length
        ? `${b.length} ticket(s) have breached SLA:\n${b.map((t) => `- ${t.ref} [${t.priority}] ${t.subject}`).join('\n')}`
        : `No SLA breaches. ${snapshot.tickets.length} ticket(s) open.`,
    };
  }

  if (/ticket|complaint|issue/.test(q)) {
    return {
      reply: snapshot.tickets.length
        ? `${snapshot.tickets.length} open ticket(s):\n${snapshot.tickets.slice(0, 8).map((t) => `- ${t.ref} [${t.priority}/${t.status}] ${t.subject}`).join('\n')}`
        : 'No open tickets in your queue.',
    };
  }

  if (/kyc|onboard|stuck|stall|abandon/.test(q)) {
    const stuck = snapshot.journeys.filter((j) => ['Stalled', 'Abandoned'].includes(j.status));
    return {
      reply: stuck.length
        ? `${stuck.length} KYC journey(s) need help:\n${stuck.map((j) => `- ${j.lead_name || 'walk-in'} · ${j.product_name} · ${j.status} on "${j.current_step_label}" (${j.progress_pct}% done)`).join('\n')}`
        : `${snapshot.journeys.length} KYC journey(s) in flight, none stalled.`,
    };
  }

  if (/warm|pipeline|how much|value|forecast/.test(q)) {
    return {
      reply: `Your book: ${L.length} leads, ${money(snapshot.pipelineValue)} across active cards. Card states — ${Object.entries(snapshot.cardStates).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing moved yet'}.`,
    };
  }

  if (/task|due|follow/.test(q)) {
    return {
      reply: snapshot.tasks.length
        ? `${snapshot.tasks.length} task(s) due:\n${snapshot.tasks.slice(0, 8).map((t) => `- [${String(t.due_at).slice(0, 16)}] ${t.title}${t.lead_name ? ` (${t.lead_name})` : ''}`).join('\n')}`
        : 'Nothing due.',
    };
  }

  if (/partner/.test(q)) {
    return {
      reply: snapshot.partners.length
        ? `${snapshot.partners.length} partner(s):\n${snapshot.partners.map((p) => `- ${p.name} (${p.partner_model}) · ${p.state_code} · ${p.sourced_count} sourced`).join('\n')}`
        : 'No partners in your book.',
    };
  }

  return {
    reply: [
      `Offline stub mode — I can only read your snapshot: ${L.length} leads, ${snapshot.tickets.length} open tickets, ${snapshot.journeys.length} KYC journeys, ${snapshot.tasks.length} tasks due.`,
      'Try "who should I call today?", "any SLA breaches?", "which KYC journeys are stuck?" — or set ANTHROPIC_API_KEY for full answers.',
    ].join('\n\n'),
  };
}

/* ------------------------------------------------------ partner insight */

export function partnerInsight(p) {
  const strengths = [];
  const concerns = [];

  if (p.sourced_this_month > 0) strengths.push(`Sourced ${p.sourced_this_month} lead(s) this month.`);
  if (p.converted_count > 0) strengths.push(`${p.converted_count} lead(s) converted to Active products.`);
  if (p.steps_done === p.steps_total && p.steps_total > 0) strengths.push('Onboarding fully complete.');
  if (p.lms_done === p.lms_total && p.lms_total > 0) strengths.push('All LMS modules complete.');

  if (p.sourced_this_month === 0) concerns.push('No leads sourced this month.');
  if (p.steps_total && p.steps_done < p.steps_total) concerns.push(`Onboarding incomplete — ${p.steps_total - p.steps_done} step(s) pending.`);
  if (p.lms_total && p.lms_done < p.lms_total) concerns.push(`${p.lms_total - p.lms_done} training module(s) outstanding.`);
  if (!p.last_activity) concerns.push('No activity recorded against this partner.');

  const health = concerns.length === 0 ? 'Strong'
    : p.sourced_this_month > 0 && concerns.length <= 1 ? 'Steady'
      : p.sourced_this_month === 0 && p.sourced_count === 0 ? 'At risk' : 'Needs attention';

  return {
    health,
    headline: `${p.name} — ${p.sourced_count} lead(s) sourced lifetime, ${p.sourced_this_month} this month, ${money(p.commission_month)} commission accrued.`,
    strengths: strengths.length ? strengths : ['No positive signals recorded yet.'],
    concerns: concerns.length ? concerns : ['Nothing outstanding.'],
    recommended_action: health === 'At risk'
      ? 'Schedule a re-activation call this week and confirm whether they intend to continue.'
      : health === 'Needs attention'
        ? 'Close the outstanding onboarding or training items, then set a sourcing target for the month.'
        : 'Maintain cadence — a monthly review call is enough.',
  };
}
