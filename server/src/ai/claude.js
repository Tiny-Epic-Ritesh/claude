/**
 * Live AI provider — Claude Messages API.
 *
 * Loaded only when ANTHROPIC_API_KEY is set. Structured tasks use structured
 * outputs so a response either matches the schema in prompts.js or throws;
 * the copilot returns prose.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DISPOSITION, TICKET_SUMMARY, NEXT_ACTION, KYC_COACH, COPILOT, PARTNER_INSIGHT } from './prompts.js';

const client = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

export const name = `Claude (${MODEL})`;
export const live = true;

/** Claude Opus 5 can decline with a 200 + stop_reason "refusal"; a truncated answer is worse than a visible failure. */
function guard(response) {
  if (response.stop_reason === 'refusal') {
    throw new Error(`Model declined this request (${response.stop_details?.category ?? 'unspecified'})`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Response hit the token limit before finishing — raise max_tokens');
  }
}

async function structured({ system, user, schema, maxTokens = 8000 }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  });
  guard(response);

  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Model returned no text block');
  return JSON.parse(text);
}

export const disposition = (ctx) =>
  structured({ system: DISPOSITION.system, user: DISPOSITION.user(ctx), schema: DISPOSITION.schema });

export const ticketSummary = (ticket, replies) =>
  structured({ system: TICKET_SUMMARY.system, user: TICKET_SUMMARY.user(ticket, replies), schema: TICKET_SUMMARY.schema, maxTokens: 2000 });

export const nextAction = (ctx) =>
  structured({ system: NEXT_ACTION.system, user: NEXT_ACTION.user(ctx), schema: NEXT_ACTION.schema, maxTokens: 4000 });

export const kycCoach = (j) =>
  structured({ system: KYC_COACH.system, user: KYC_COACH.user(j), schema: KYC_COACH.schema, maxTokens: 2000 });

export const partnerInsight = (p) =>
  structured({ system: PARTNER_INSIGHT.system, user: PARTNER_INSIGHT.user(p), schema: PARTNER_INSIGHT.schema, maxTokens: 3000 });

export async function copilot({ question, snapshot, history = [] }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: COPILOT.system,
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: `${COPILOT.snapshot(snapshot)}\n\n${question}` },
    ],
  });
  guard(response);

  return {
    reply: response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
  };
}
