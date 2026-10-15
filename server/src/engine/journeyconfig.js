/**
 * Writing a product's KYC journey (QA-37: "versioned; applies to new
 * journeys only; retire a step").
 *
 * The live step list is replaced and snapshotted as the next version. A
 * journey already started keeps the version it began with (journey_version_id
 * in engine/kyc.js), so retiring a step here takes it out of every journey
 * started afterwards and out of none in flight.
 *
 * One function for both doors: the Setup route when the change applies at
 * once, and the approval that grants it when the Business policy holds
 * journey changes for Compliance.
 */

import { one, run, audit } from '../db.js';
import { MASTER_STEPS } from './kyc.js';
import { snapshot } from './versioning.js';

/** Why this step list cannot be a journey, or null. */
export function journeyRefusal(steps) {
  if (!Array.isArray(steps) || !steps.length) return 'A journey needs at least one step';
  const codes = steps.map((s) => s?.step_code);
  const unknown = codes.filter((c) => !MASTER_STEPS.some((m) => m.code === c));
  if (unknown.length) return `Not a KYC step: ${unknown.join(', ')}`;
  if (new Set(codes).size !== codes.length) return 'A step appears twice';
  return null;
}

/** Replace the product's live steps and record them as its next version. */
export function applyJourneySteps(productId, steps, { note = null, userId = null } = {}) {
  run('DELETE FROM kyc_journey_steps WHERE product_type_id = ?', [productId]);
  steps.forEach((s, i) => {
    run('INSERT INTO kyc_journey_steps (product_type_id, step_code, sort_order, timer_override_s, conditional_on) VALUES (?,?,?,?,?)', [
      productId, s.step_code, i, s.timer_override_s || null, s.conditional_on || null,
    ]);
  });
  audit(userId, 'kyc_journey_configured', 'product_type', Number(productId), { steps: steps.length, note });
  return snapshot('kyc_journey', Number(productId), { note, userId });
}

export const productFor = (id) => one('SELECT id, name, sales_org FROM product_types WHERE id = ?', [Number(id) || -1]);
