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
