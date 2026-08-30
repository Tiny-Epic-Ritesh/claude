/**
 * Common Client Master — the check you run before onboarding.
 *
 * One question: does this person already exist somewhere in the firm? Asked so
 * that nobody re-approaches an existing client, opens a duplicate account, or
 * cuts across a colleague's relationship without knowing it.
 *
 * This is the one surface that deliberately crosses your own scope. That is the
 * entire point — a duplicate check confined to your own book cannot find the
 * duplicate, because the duplicate is by definition somebody else's. Scoping it
 * would leave it looking like it worked while answering "no match" to every
 * question worth asking.
 *
 * What makes that safe is what it returns rather than who may ask. It never
 * yields a contact detail. It answers "yes, and here is who owns them" — the
 * name, the owner, the business, whether they are already a client — which is
 * everything the question needs and nothing that lets it be used as a directory
 * to mine numbers from.
 */

import { Router } from 'express';
import { all, one } from '../db.js';
import { requireUser, requireAnyPermission, orgsFor } from '../auth.js';
import { blindIndex, maskMobile, maskPan } from '../security.js';

const router = Router();
router.use(requireUser);

/** Digits only, so 98765 43210 and +91-9876543210 are the same query. */
const digits = (s) => String(s ?? '').replace(/\D/g, '');

const looksLikePan = (s) => /^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(String(s ?? '').trim());

/* Either job may run the check.
 *
 * lead.create is the person about to onboard somebody; client.view.all is the
 * person answering the phone to somebody who may already be a client. Customer
 * Care is the second, holds only the second, and was shown this tab while being
 * refused both of the things it does. */
const mayCheckDuplicates = requireAnyPermission('lead.create', 'client.view.all');

router.get('/search', mayCheckDuplicates, (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) {
    return res.json({
      query: q,
      matches: [],
      note: 'Type at least three characters, or paste a full mobile number or PAN.',
    });
  }

  const orgs = orgsFor(req.user);
  const orgList = orgs.map(() => '?').join(',') || "''";

  const d = digits(q);
  const where = [];
  const params = [];

  // A ten-digit string is a phone number and nothing else, so match it exactly
  // rather than dragging it through a LIKE across every column.
  if (d.length >= 10) {
    where.push('REPLACE(REPLACE(l.mobile, \' \', \'\'), \'-\', \'\') LIKE ?');
    params.push(`%${d.slice(-10)}`);
  } else if (looksLikePan(q)) {
    // PAN is encrypted at rest, so it is found through its blind index rather
    // than by comparing ciphertext, which would never match.
    where.push('l.pan_bidx = ?');
    params.push(blindIndex(q.toUpperCase()));
  } else {
    where.push('(l.name LIKE ? OR l.email LIKE ? OR l.client_code LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = all(
    `SELECT l.id, l.name, l.city, l.sales_org, l.stage, l.created_at,
            l.mobile, l.client_code,
            u.name AS owner_name, u.email AS owner_email,
            p.name AS partner_name,
            (SELECT COUNT(*) FROM clients c
              WHERE c.converted_from_lead_id = l.id AND c.deleted_at IS NULL) AS is_client
       FROM leads l
       LEFT JOIN users u ON u.id = l.owner_id
       LEFT JOIN partners p ON p.id = l.partner_id
      WHERE l.deleted_at IS NULL
        AND l.sales_org IN (${orgList})
        AND (${where.join(' OR ')})
      ORDER BY l.updated_at DESC
      LIMIT 25`,
    [...orgs, ...params],
  );

  res.json({
    query: q,
    matched_on: d.length >= 10 ? 'mobile' : looksLikePan(q) ? 'PAN' : 'name, email or UCC',
    matches: rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      sales_org: r.sales_org,
      stage: r.stage,
      created_at: r.created_at,
      client_code: r.client_code,
      already_a_client: Boolean(r.is_client),
      owner_name: r.owner_name,
      owner_email: r.owner_email,
      partner_name: r.partner_name,
      /* Always masked, for everybody, regardless of role. This surface exists
         to answer "does this person exist and who holds them", and a directory
         that also hands over the number is a directory somebody will mine. */
      mobile: maskMobile(r.mobile),
    })),
    note: rows.length
      ? 'Already in the system. Speak to the owner before approaching them.'
      : 'No match — safe to create.',
  });
});

/** Counts for the tab header, so it opens on something rather than nothing. */
router.get('/summary', (req, res) => {
  const orgs = orgsFor(req.user);
  const orgList = orgs.map(() => '?').join(',') || "''";

  res.json({
    leads: one(`SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND sales_org IN (${orgList})`, orgs).n,
    clients: one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL AND sales_org IN (${orgList})`, orgs).n,
    /**
     * Numbers held by more than one lead record.
     *
     * The duplicates that already exist, rather than the ones this screen will
     * prevent. Worth surfacing: they are the backlog nobody has looked at, and
     * they are exactly what an import creates when the guard is bypassed.
     */
    duplicate_mobiles: one(
      `SELECT COUNT(*) n FROM (
         SELECT mobile FROM leads
          WHERE deleted_at IS NULL AND mobile IS NOT NULL AND TRIM(mobile) <> ''
            AND sales_org IN (${orgList})
          GROUP BY mobile HAVING COUNT(*) > 1)`,
      orgs,
    ).n,
    orgs,
  });
});

/** The existing duplicates, so somebody can actually work through them. */
router.get('/duplicates', mayCheckDuplicates, (req, res) => {
  const orgs = orgsFor(req.user);
  const orgList = orgs.map(() => '?').join(',') || "''";

  const groups = all(
    `SELECT mobile, COUNT(*) n FROM leads
      WHERE deleted_at IS NULL AND mobile IS NOT NULL AND TRIM(mobile) <> ''
        AND sales_org IN (${orgList})
      GROUP BY mobile HAVING COUNT(*) > 1
      ORDER BY n DESC LIMIT 40`,
    orgs,
  );

  res.json(groups.map((g) => ({
    mobile: maskMobile(g.mobile),
    count: g.n,
    records: all(
      `SELECT l.id, l.name, l.sales_org, l.stage, l.created_at, u.name AS owner_name
         FROM leads l LEFT JOIN users u ON u.id = l.owner_id
        WHERE l.mobile = ? AND l.deleted_at IS NULL
        ORDER BY l.created_at`,
      [g.mobile],
    ),
  })));
});

export default router;
