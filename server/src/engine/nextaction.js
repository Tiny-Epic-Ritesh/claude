/**
 * The next best action on a product card (ENH-10b).
 *
 * "Move Forward" told a rep nothing. It named a direction without naming a
 * step, so the person who clicked it still had to work out what forward meant
 * for this product at this stage — which is the part they wanted help with.
 *
 * So each state declares three things:
 *
 *   headline  what to do, as an instruction
 *   why       why it is the right move now, in one line
 *   primary   the action that performs it, with the capability it needs
 *
 * Declared on the server for the same reason the cockpit's actions are: the
 * server knows the state machine, and a client inferring the next step is a
 * client that will disagree with the API the first time the machine changes.
 *
 * `alternatives` matter as much as `primary`. The obvious move is not always
 * the right one — a client who has gone quiet may need closing rather than
 * chasing — so every legal transition stays available beside the suggestion
 * rather than behind it.
 */

/**
 * Legal transitions, and what each one is called in the interface.
 *
 * Kept here rather than inferred, because "which moves are legal from Warm" is
 * a business rule and inferring it from what happens to be in CARD_STATES would
 * make every new state silently legal from everywhere.
 */
export const TRANSITIONS = {
  INACTIVE: ['EXPLORING', 'LOST'],
  EXPLORING: ['WARM', 'ON_HOLD', 'LOST'],
  WARM: ['PRODUCT_RM_ENGAGED', 'KYC_IN_PROGRESS', 'ON_HOLD', 'LOST'],
  PRODUCT_RM_ENGAGED: ['KYC_IN_PROGRESS', 'WARM', 'ON_HOLD', 'LOST'],
  KYC_IN_PROGRESS: ['ACTIVE', 'ON_HOLD', 'LOST'],
  ACTIVE: ['ON_HOLD'],
  ON_HOLD: ['WARM', 'KYC_IN_PROGRESS', 'LOST'],
  LOST: ['EXPLORING'],
};

export const STATE_LABEL = {
  INACTIVE: 'Not started',
  EXPLORING: 'Exploring',
  WARM: 'Warm',
  PRODUCT_RM_ENGAGED: 'Product RM engaged',
  KYC_IN_PROGRESS: 'KYC in progress',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  LOST: 'Lost',
};

/**
 * What to do next, per state.
 *
 * `kind` tells the client how to perform it:
 *   state   move the card to `to`
 *   rm      ask for a Product RM
 *   kyc     open a KYC journey
 *   contact reach the client on a channel
 *   none    nothing to chase; the card is finished
 */
const NEXT = {
  INACTIVE: {
    headline: 'Find out whether they want this',
    why: 'Nobody has raised this product with them yet, so there is no interest to lose.',
    primary: { label: 'Mark as Exploring', kind: 'state', to: 'EXPLORING', needs: 'card.mark.exploring' },
  },
  EXPLORING: {
    headline: 'Qualify the interest, then mark it Warm',
    why: 'They have shown interest. Warm is what puts it in the pipeline and in front of a supervisor.',
    primary: { label: 'Mark as Warm', kind: 'state', to: 'WARM', needs: 'card.mark.warm' },
  },
  WARM: {
    headline: 'Bring in the Product RM',
    why: 'A qualified lead converts faster with the specialist on the call than with another follow-up from you.',
    primary: { label: 'Request a Product RM', kind: 'rm', needs: 'card.request.productrm' },
    second: { label: 'Start KYC instead', kind: 'kyc', needs: 'kyc.manage',
      hint: 'Skip the specialist when the client is already decided.' },
  },
  PRODUCT_RM_ENGAGED: {
    headline: 'Open the account',
    why: 'The specialist has engaged. The next thing standing between this and revenue is KYC.',
    primary: { label: 'Start KYC', kind: 'kyc', needs: 'kyc.manage' },
  },
  KYC_IN_PROGRESS: {
    headline: 'Chase the step they are stuck on',
    why: 'A KYC left alone does not finish itself, and a stalled one goes cold within days.',
    primary: { label: 'Open the KYC journey', kind: 'kyc_view', needs: 'kyc.view' },
  },
  ACTIVE: {
    headline: 'Nothing to chase — this one is done',
    why: 'The account is live. Effort is better spent on a product this client does not hold yet.',
    primary: { label: 'See what else they could hold', kind: 'none' },
  },
  ON_HOLD: {
    headline: 'Find out whether the reason still stands',
    why: 'A hold is a decision that was true once. Nobody revisits it unless someone asks.',
    primary: { label: 'Reopen as Warm', kind: 'state', to: 'WARM', needs: 'card.mark.warm' },
  },
  LOST: {
    headline: 'Reopen only if something has changed',
    why: 'Re-pitching an unchanged no is how a client stops taking the call.',
    primary: { label: 'Reopen as Exploring', kind: 'state', to: 'EXPLORING', needs: 'card.mark.exploring' },
  },
};

/**
 * The directive for one card, filtered to what this person may actually do.
 *
 * An action the caller cannot perform is returned as `blocked` with the reason
 * rather than dropped. A Product RM looking at a Warm card should see that the
 * next step is a request they cannot raise themselves — that is information,
 * where an empty panel is a puzzle.
 */
export function nextAction(card, caps, { daysInState = 0 } = {}) {
  const base = NEXT[card.state] ?? NEXT.INACTIVE;
  const permitted = (a) => !a?.needs || caps.has(a.needs);

  const decorate = (a) => (a ? {
    ...a,
    allowed: permitted(a),
    blocked_reason: permitted(a) ? null : 'Your role cannot do this',
  } : null);

  /**
   * Ageing changes the advice, not the step.
   *
   * A card sitting in the same state for a fortnight is the single most useful
   * thing a supervisor can be told, and repeating the generic reason at that
   * point would be worse than saying nothing.
   */
  const stale = daysInState > 14 && !['ACTIVE', 'LOST'].includes(card.state);

  return {
    state: card.state,
    state_label: STATE_LABEL[card.state] ?? card.state,
    days_in_state: daysInState,
    headline: base.headline,
    why: stale
      ? `No movement in ${daysInState} days. ${base.why}`
      : base.why,
    urgent: stale,
    primary: decorate(base.primary),
    second: decorate(base.second),
    alternatives: (TRANSITIONS[card.state] ?? []).map((to) => ({
      to, label: STATE_LABEL[to] ?? to,
    })),
  };
}

/**
 * The one next step for a whole lead, across all of its products.
 *
 * P2-12. The lead header used to summarise the products as "2 Warm · 1 Active",
 * which describes state to somebody who is one tab away from seeing that state
 * laid out in full. It answered a question nobody had. What an RM opening a
 * record actually needs is what to do next, and that was behind a button.
 *
 * Ordering, most urgent first:
 *
 *   1. Anything gone stale. A card sitting untouched for a fortnight is the
 *      single most useful thing to surface, and it is the one an RM has
 *      already stopped noticing.
 *   2. Otherwise the furthest-progressed card, because the nearest thing to
 *      revenue is the one worth an hour today.
 *
 * INACTIVE cards are ignored. Every lead carries a card for every product, so
 * counting those would make "find out whether they want this" the advice on
 * every lead in the book forever.
 */
export function nextStepForLead(cards = [], caps = new Set()) {
  const engaged = cards.filter((c) => c.state && c.state !== 'INACTIVE' && c.state !== 'LOST');
  if (!engaged.length) return null;

  const progress = ['EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED', 'KYC_IN_PROGRESS', 'ACTIVE'];
  const rank = (c) => progress.indexOf(c.state);

  const scored = engaged.map((card) => {
    const days = card.days_in_state
      ?? (card.last_state_at
        ? Math.floor((Date.now() - new Date(`${String(card.last_state_at).replace(' ', 'T')}Z`).getTime()) / 86400000)
        : 0);
    return { card, days, step: nextAction(card, caps, { daysInState: days }) };
  });

  scored.sort((a, b) => {
    if (a.step.urgent !== b.step.urgent) return a.step.urgent ? -1 : 1;
    if (a.step.urgent && b.step.urgent) return b.days - a.days;
    return rank(b.card) - rank(a.card);
  });

  const { card, days, step } = scored[0];

  /* An ACTIVE card has nothing outstanding, so advice about it would be noise.
   * Said explicitly rather than returning null, because "nothing to do here"
   * is itself worth reading on a record somebody just opened. */
  if (card.state === 'ACTIVE' && !step.urgent) {
    return {
      product: card.product_name ?? card.product_code,
      state: card.state,
      headline: 'Nothing outstanding',
      why: `${card.product_name ?? 'This product'} is active. The next move is a review, not a chase.`,
      urgent: false,
      days_in_state: days,
      action: null,
    };
  }

  return {
    product: card.product_name ?? card.product_code,
    state: card.state,
    state_label: step.state_label,
    headline: step.headline,
    why: step.why,
    urgent: step.urgent,
    days_in_state: days,
    // What the button would do, so the header can offer it rather than
    // describe it. Null when this role may not.
    action: step.primary?.allowed ? step.primary : null,
    blocked_reason: step.primary && !step.primary.allowed ? step.primary.blocked_reason : null,
  };
}
