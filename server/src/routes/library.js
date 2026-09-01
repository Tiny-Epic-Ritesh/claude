/**
 * The Marketing Hub — content libraries and their approval flow.
 *
 * P2-20 ("create and manage content libraries") and P2-22 ("edit and
 * configuration in the Marketing Hub") are one screen: `/content` is labelled
 * Marketing Hub in the app.
 *
 * Reading is open to anyone the library is shared with — collateral exists to
 * be used, and an RM who cannot find the brochure will send an old one they
 * saved to their desktop. Changing it belongs to the owning role.
 */

import { Router } from 'express';
import { all, one, run, audit, SALES_ORGS } from '../db.js';
import { requireUser, requirePermission, can, mayUseOrg } from '../auth.js';
import { validate } from '../security.js';
import {
  libraries, itemsIn, mayRead, mayManage, mayTransition, setStatus, expiryFor, STATUSES,
} from '../engine/library.js';

const router = Router();
router.use(requireUser);

const loadLibrary = (id) => one('SELECT * FROM content_library WHERE id = ?', [id]);

/* ------------------------------------------------------------ reading */

router.get('/', (req, res) => {
  res.json({
    libraries: libraries(req.user),
    /* Anything not filed anywhere. Shown rather than hidden, because content
       that belongs to no library is exactly what nobody reviews — and it is
       where everything created before libraries existed now sits. */
    unfiled: can(req.user.role, 'admin.content') ? itemsIn(null) : [],
    statuses: Object.entries(STATUSES).map(([code, s]) => ({ code, ...s })),
    roles: all('SELECT code, name FROM roles WHERE active = 1 ORDER BY sort_order, name'),
    may_manage: can(req.user.role, 'admin.content'),
  });
});

router.get('/:id', (req, res) => {
  const lib = loadLibrary(req.params.id);
  if (!lib || !mayRead(lib, req.user)) return res.status(404).json({ error: 'No such library' });
  res.json({
    library: { ...lib, shared_with: lib.shared_with ? JSON.parse(lib.shared_with) : null },
    items: itemsIn(lib.id),
    may_manage: mayManage(lib, req.user),
  });
});

/* ------------------------------------------------------------ writing */

router.post('/', requirePermission('admin.content'), (req, res) => {
  const {
    name, description, owner_role: ownerRole, shared_with: shared,
    sales_org: org, requires_approval: needsApproval, default_expiry_days: expiryDays,
  } = req.body;

  const invalid = validate(req.body, { name: ['required', 'max:80'] });
  if (invalid) return res.status(400).json(invalid);

  if (!ownerRole || !one('SELECT code FROM roles WHERE code = ? AND active = 1', [ownerRole])) {
    return res.status(400).json({ error: 'A library needs an owning role', field: 'owner_role' });
  }
  if (org && (!SALES_ORGS.includes(org) || !mayUseOrg(req.user, org))) {
    return res.status(403).json({ error: 'That business is outside your access', field: 'sales_org' });
  }
  if (expiryDays !== undefined && expiryDays !== null && expiryDays !== '') {
    const n = Number(expiryDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      return res.status(400).json({ error: 'A default expiry is between 1 and 3650 days', field: 'default_expiry_days' });
    }
  }

  const result = run(
    `INSERT INTO content_library (name, description, owner_role, shared_with, sales_org,
                                  requires_approval, default_expiry_days, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [String(name).trim(), description ?? null, ownerRole,
      Array.isArray(shared) ? JSON.stringify(shared) : null, org ?? null,
      needsApproval ? 1 : 0, expiryDays ? Number(expiryDays) : null, req.user.id],
  );

  audit(req.user.id, 'library_created', 'content_library', Number(result.lastInsertRowid), { name, owner_role: ownerRole });
  return res.status(201).json(one('SELECT * FROM content_library WHERE id = ?', [Number(result.lastInsertRowid)]));
});

router.patch('/:id', (req, res) => {
  const lib = loadLibrary(req.params.id);
  if (!lib || !mayRead(lib, req.user)) return res.status(404).json({ error: 'No such library' });
  if (!mayManage(lib, req.user)) return res.status(403).json({ error: 'Only the owning role can change this library' });

  const { name, description, shared_with: shared, requires_approval: needsApproval,
    default_expiry_days: expiryDays, active } = req.body;

  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'A library needs a name', field: 'name' });
  }

  run(
    `UPDATE content_library SET
       name = COALESCE(?, name), description = COALESCE(?, description),
       shared_with = ${shared === undefined ? 'shared_with' : '?'},
       requires_approval = COALESCE(?, requires_approval),
       default_expiry_days = ${expiryDays === undefined ? 'default_expiry_days' : '?'},
       active = COALESCE(?, active)
     WHERE id = ?`,
    [
      name ?? null, description ?? null,
      ...(shared === undefined ? [] : [Array.isArray(shared) ? JSON.stringify(shared) : null]),
      needsApproval === undefined ? null : (needsApproval ? 1 : 0),
      ...(expiryDays === undefined ? [] : [expiryDays ? Number(expiryDays) : null]),
      active === undefined ? null : (active ? 1 : 0),
      lib.id,
    ],
  );

  audit(req.user.id, 'library_updated', 'content_library', lib.id, { name: name ?? lib.name });
  return res.json(one('SELECT * FROM content_library WHERE id = ?', [lib.id]));
});

/* -------------------------------------------------------------- items */

router.post('/:id/items', (req, res) => {
  const lib = loadLibrary(req.params.id);
  if (!lib || !mayRead(lib, req.user)) return res.status(404).json({ error: 'No such library' });
  if (!mayManage(lib, req.user)) return res.status(403).json({ error: 'Only the owning role can add to this library' });

  const invalid = validate(req.body, { name: ['required', 'max:120'] });
  if (invalid) return res.status(400).json(invalid);

  /* A library that requires approval starts its items as drafts. One that does
     not starts them approved — otherwise every internal battlecard needs a
     ceremony, and the ceremony is what makes people stop reading. */
  const status = lib.requires_approval ? 'draft' : 'approved';

  const result = run(
    `INSERT INTO content_items (name, type, url, product_type_id, expiry_date, owner_role,
                                library_id, status, created_by, sales_org)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      String(req.body.name).trim(), req.body.type || 'PDF', req.body.url || null,
      req.body.product_type_id || null,
      expiryFor(lib, req.body.expiry_date),
      lib.owner_role, lib.id, status, req.user.id, lib.sales_org ?? req.user.sales_org,
    ],
  );

  audit(req.user.id, 'content_created', 'content_item', Number(result.lastInsertRowid), { name: req.body.name, library: lib.name });
  return res.status(201).json(one('SELECT * FROM content_items WHERE id = ?', [Number(result.lastInsertRowid)]));
});

/** Edit an item. P2-22's "edit" — there was no way to change one at all. */
router.patch('/items/:itemId', (req, res) => {
  const item = one('SELECT * FROM content_items WHERE id = ?', [req.params.itemId]);
  if (!item) return res.status(404).json({ error: 'No such item' });
  const lib = item.library_id ? loadLibrary(item.library_id) : null;
  if (lib && !mayManage(lib, req.user)) return res.status(403).json({ error: 'Only the owning role can change this' });
  if (!lib && !can(req.user.role, 'admin.content')) return res.status(403).json({ error: 'Managing unfiled content needs content permission' });

  const { name, url, expiry_date: expiry, product_type_id: productId, library_id: moveTo } = req.body;
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'An item needs a name', field: 'name' });
  }

  /* Editing an approved item sends it back for approval, where the library
     asks for it. Otherwise "approve, then change the file" is a way around the
     review, and the approval on the record would describe a document that no
     longer exists. */
  const reApprove = lib?.requires_approval && item.status === 'approved'
    && (url !== undefined && url !== item.url);

  run(
    `UPDATE content_items SET
       name = COALESCE(?, name), url = COALESCE(?, url),
       expiry_date = ${expiry === undefined ? 'expiry_date' : '?'},
       product_type_id = COALESCE(?, product_type_id),
       library_id = COALESCE(?, library_id),
       status = ?
     WHERE id = ?`,
    [
      name ?? null, url ?? null,
      ...(expiry === undefined ? [] : [expiry || null]),
      productId ?? null, moveTo ?? null,
      reApprove ? 'pending' : item.status,
      item.id,
    ],
  );

  audit(req.user.id, 'content_updated', 'content_item', item.id, { re_approval: Boolean(reApprove) });
  return res.json({ ...one('SELECT * FROM content_items WHERE id = ?', [item.id]), re_approval: Boolean(reApprove) });
});

/** Move an item along the approval flow. */
router.post('/items/:itemId/status', (req, res) => {
  const item = one('SELECT * FROM content_items WHERE id = ?', [req.params.itemId]);
  if (!item) return res.status(404).json({ error: 'No such item' });
  const lib = item.library_id ? loadLibrary(item.library_id) : null;
  if (lib && !mayRead(lib, req.user)) return res.status(404).json({ error: 'No such item' });

  const to = String(req.body.status ?? '');
  const refusal = mayTransition(item, lib, req.user, to);
  if (refusal) return res.status(403).json({ error: refusal });

  if (to === 'rejected' && !String(req.body.reason ?? '').trim()) {
    return res.status(400).json({
      error: 'Say why it is going back — the person who wrote it cannot fix an unexplained refusal',
      field: 'reason',
    });
  }

  setStatus(item, to, req.user, req.body.reason ?? null);
  audit(req.user.id, `content_${to}`, 'content_item', item.id, { name: item.name, reason: req.body.reason ?? null });
  return res.json(one('SELECT * FROM content_items WHERE id = ?', [item.id]));
});

export default router;
