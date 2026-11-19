/**
 * Moving a product interest (a "card") to another stage.
 *
 * One function for every door that moves a card, so a move says the same
 * things, tells the same people and leaves the same trail wherever it is made.
 * Taken out of `POST /cards/:id/state` for A4 (QA-10, ruled 19 Nov: every call
 * saves the same way). The AI disposition used to move cards itself, with a
 * plain UPDATE: no effects said back, a different notice to the Product RMs,
 * no history note on the timeline and no score.
 *
 * The caller has already loaded the card within the reader's book; this checks
 * the role, makes the move and reports what it did.
 */

import { all, one, run, audit, notify } from '../db.js';
import { userCan } from '../auth.js';
import { applyScore } from './rules.js';
import { MOVE_NEEDS, STATE_LABEL } from './nextaction.js';
import { dmyTime } from './daterange.js';
import { tracked } from './history.js';

/**
 * @param card   the product_cards row, with product_name (and lead_id,
 *               product_type_id), read within the caller's book
 * @param state  the stage to move it to (one of CARD_STATES)
 * @param user   the person moving it (req.user)
 * @returns { refused, required } when the role may not set that stage, else
 *          { from, to, effects } -- what the move did, in words
 */
export function moveCard({ card, state, user, note = null, contactFlag = null, lostReason = null, source = 'ui' }) {
  // QA-42: the map the panel reads too, so what it offers is what this accepts.
  const permissionFor = MOVE_NEEDS[state];
  if (!userCan(user, permissionFor)) {
    return { refused: `Your role cannot set a card to ${state}`, required: permissionFor };
  }

  const from = card.state;
  /* Part 4, item 8.2: nothing set the card's Product RM, so the card and the
     pipeline showed one only where the seed had put it. A Product RM taking a
     card on is now its Product RM. */
  const takesOn = state === 'PRODUCT_RM_ENGAGED' && user.role === 'product_rm';
  tracked('product_interest', card.id, { actorId: user.id, source }, () => run(
    'UPDATE product_cards SET state = ?, contact_flag = COALESCE(?, contact_flag), lost_reason = ?, last_state_at = datetime(\'now\'), product_rm_id = CASE WHEN ? THEN ? ELSE product_rm_id END WHERE id = ?',
    [state, contactFlag || null, lostReason || null, takesOn ? 1 : 0, user.id, card.id],
  ));

  /* Part 4, item 8.4: what the move did, said back to whoever made it. */
  const effects = [
    `${card.product_name} moved from ${STATE_LABEL[from] ?? from} to ${STATE_LABEL[state] ?? state}.`,
    'It is in the card history, and on the lead timeline.',
  ];
  if (takesOn) effects.push('You are now its Product RM.');

  run('INSERT INTO card_audit (card_id, from_state, to_state, user_id, note) VALUES (?,?,?,?,?)', [
    card.id, from, state, user.id, note || null,
  ]);
  run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,?)', [
    card.lead_id, card.id, 'Note', 'system', `${card.product_name}: ${from} → ${state}`, note || null, user.id,
  ]);
  applyScore(card.lead_id, 'Note', state === 'WARM' ? 15 : state === 'EXPLORING' ? 5 : 0);

  // Warm notifies the Product RM for awareness only — no action required by default (OD-03).
  if (state === 'WARM') {
    const productRms = all("SELECT id, name FROM users WHERE role = 'product_rm' AND product_type_id = ? AND active = 1", [card.product_type_id]);
    const lead = one('SELECT name FROM leads WHERE id = ?', [card.lead_id]);
    for (const rm of productRms) {
      notify(rm.id, `Warm card — ${card.product_name}`,
        `${lead?.name} was marked Warm by ${user.name}. Awareness only; no action needed unless the Sales RM requests it.`,
        `/leads/${card.lead_id}`);
    }
    effects.push(productRms.length
      ? `Told, for awareness only: ${productRms.map((r) => r.name).join(', ')}.`
      : `No Product RM is set up for ${card.product_name}, so nobody was told.`);
  }

  // A card going Active raises the cross-sell prompt (BRD §7.2).
  if (state === 'ACTIVE') {
    const lead = one('SELECT * FROM leads WHERE id = ?', [card.lead_id]);
    const other = one(
      `SELECT pt.name FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
       WHERE pc.lead_id = ? AND pc.state = 'INACTIVE' AND pt.active = 1 ORDER BY pt.sort_order LIMIT 1`,
      [card.lead_id],
    );
    if (other && lead?.owner_id) {
      const title = `${card.product_name} is now Active — consider introducing ${other.name}`;
      const task = run("INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, priority) VALUES (?,?,?,?,datetime('now','+2 days'),'Normal')", [
        title, card.lead_id, lead.owner_id, user.id,
      ]);
      const made = one('SELECT t.due_at, u.name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?', [Number(task.lastInsertRowid)]);
      effects.push(`A task for ${made?.name ?? 'the lead\'s owner'}: “${title}”, due ${dmyTime(made?.due_at)}.`);
    }
  }

  audit(user.id, 'card_state', 'product_card', card.id, { from, to: state });
  return { from, to: state, effects };
}
