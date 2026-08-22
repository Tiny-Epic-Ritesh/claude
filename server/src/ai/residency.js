/**
 * Data-residency routing for the AI layer.
 *
 * Every AI capability is classified by the data it must see, and each class is
 * routed to a provider that is lawful for that class. This is the module a
 * compliance reviewer should read first.
 *
 *   CLASS_PII_RAW      Content that inherently contains a client's identity and
 *                      cannot be usefully de-identified — a call transcript in
 *                      which the customer states their own name and account
 *                      details, or a KYC document image.
 *                      → MUST be processed inside India.
 *
 *   CLASS_DEIDENTIFIED Content that can be fully tokenised because every
 *                      identifier is already a column in our database.
 *                      → May go to a frontier model outside India, because what
 *                        leaves is a situation, not a person.
 *
 *   CLASS_INTERNAL     No client data at all (aggregate counts, product config).
 *                      → Unrestricted.
 *
 * MODES (CRM_AI_RESIDENCY)
 *   hybrid          class-based routing as above                   [recommended]
 *   deidentify_only every class is de-identified, one provider
 *   in_india_only   nothing leaves the country under any condition
 *   offline         no external call at all (the built-in stub)
 */

import { deidentify, residualPiiDeep, knownIdentifiers } from './deidentify.js';
import { audit } from '../db.js';

export const CLASS = {
  PII_RAW: 'CLASS_PII_RAW',
  DEIDENTIFIED: 'CLASS_DEIDENTIFIED',
  INTERNAL: 'CLASS_INTERNAL',
};

/** Which class each capability falls into, and why. */
export const CAPABILITY_CLASS = {
  disposition: {
    class: CLASS.PII_RAW,
    reason: 'A call transcript contains the customer speaking their own name, and often account or bank details. It cannot be reliably de-identified because we do not control what was said.',
  },
  kycCoach: {
    class: CLASS.PII_RAW,
    reason: 'Reasons about a specific KYC step and the data captured on it — address, income band, bank details.',
  },
  ticketSummary: {
    class: CLASS.DEIDENTIFIED,
    reason: 'Ticket subject and thread. Client identifiers are known columns and are substituted before the call.',
  },
  nextAction: {
    class: CLASS.DEIDENTIFIED,
    reason: 'Reasons over card states, ageing, ticket status and contact recency. Identity is irrelevant to the recommendation.',
  },
  copilot: {
    class: CLASS.DEIDENTIFIED,
    reason: 'Answers about the user\'s own book. Lead names are tokenised outbound and restored in the reply.',
  },
  partnerInsight: {
    class: CLASS.DEIDENTIFIED,
    reason: 'Sourcing volume, conversion, onboarding and training completion. Partner identity is substituted.',
  },
};

export const MODE = process.env.CRM_AI_RESIDENCY || 'hybrid';

/** Where a capability's request is allowed to be processed, given the mode. */
export function routeFor(capability) {
  const entry = CAPABILITY_CLASS[capability];
  if (!entry) return { provider: 'india', deidentify: true, class: CLASS.PII_RAW, reason: 'Unknown capability — defaults to the most restrictive route.' };

  switch (MODE) {
    case 'offline':
      return { provider: 'offline', deidentify: false, class: entry.class, reason: 'Offline mode — no external call is made.' };

    case 'in_india_only':
      return { provider: 'india', deidentify: false, class: entry.class, reason: 'Policy: no client data leaves India under any condition.' };

    case 'deidentify_only':
      return { provider: 'frontier', deidentify: true, class: entry.class, reason: 'Policy: every class is de-identified before leaving the country.' };

    case 'hybrid':
    default:
      return entry.class === CLASS.PII_RAW
        ? { provider: 'india', deidentify: false, class: entry.class, reason: entry.reason }
        : { provider: 'frontier', deidentify: true, class: entry.class, reason: entry.reason };
  }
}

/**
 * Wrap a capability call with the residency policy.
 *
 * `call(payload, providerName)` performs the actual model request. This function
 * decides what that payload may contain and where it may go, verifies the
 * decision, records it, and restores identity in the answer.
 */
export async function withResidency(capability, { payload, context = {}, call }) {
  const route = routeFor(capability);

  // No de-identification required: the payload goes to an in-country provider as-is.
  if (!route.deidentify) {
    const result = await call(payload, route.provider);
    return { result, route, redacted: null };
  }

  const { scrubbed, vault } = deidentify(payload, context);

  // Verify before egress. If a known identifier survived scrubbing, refuse the
  // call rather than send it — failing closed is the only safe default here.
  const known = knownIdentifiers(context);
  const residual = residualPiiDeep(scrubbed, known);

  if (residual.length > 0) {
    audit(null, 'ai_egress_blocked', 'ai', null, {
      capability, kinds: residual.map((r) => r.kind),
    });
    const err = new Error(
      'This request was blocked before leaving the country: identifying data survived de-identification. '
      + 'It has been routed for in-country processing instead.',
    );
    err.residency_blocked = true;
    err.route = route;
    throw err;
  }

  const result = await call(scrubbed, route.provider);

  audit(null, 'ai_egress', 'ai', null, {
    capability, provider: route.provider, class: route.class, redacted: vault.summary(),
  });

  // Put the real names back before the answer reaches the user.
  return { result: vault.rehydrateDeep(result), route, redacted: vault.summary() };
}

/** Surfaces the policy in the Admin UI so it can be shown to an auditor. */
export function residencyReport() {
  return {
    mode: MODE,
    modes_available: ['hybrid', 'deidentify_only', 'in_india_only', 'offline'],
    india_endpoint: process.env.CRM_AI_INDIA_URL || null,
    frontier_configured: Boolean(process.env.ANTHROPIC_API_KEY),
    capabilities: Object.entries(CAPABILITY_CLASS).map(([key, entry]) => {
      const route = routeFor(key);
      return {
        capability: key,
        data_class: entry.class,
        classification_reason: entry.reason,
        routed_to: route.provider,
        deidentified: route.deidentify,
        leaves_india: route.provider === 'frontier',
      };
    }),
    note:
      'Claude on Amazon Bedrock is reachable from ap-south-1 only via global cross-Region inference, '
      + 'which AWS documents as routing to commercial Regions worldwide. Any capability marked '
      + 'leaves_india=true therefore sends de-identified content only, verified at egress.',
  };
}
