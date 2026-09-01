/**
 * The metadata engine — entities and fields as data.
 *
 * WHAT THIS GIVES US
 * ------------------
 * One configuration contract for every entity, so the admin UI is built once and
 * applies uniformly. An administrator adds a field; nobody writes a migration.
 *
 * HOW STORAGE WORKS (hybrid, by decision)
 * ---------------------------------------
 *   storage = 'column'   a real column on the entity's physical table. Fast,
 *                        indexable, and where the fields people filter 495,118
 *                        rows by must live.
 *   storage = 'value'    a row in `field_value`. Costs a join; this is where
 *                        admin-created fields go.
 *   storage = 'derived'  never stored. Formula and rollup fields compute on read.
 *
 * The core entities are REGISTERED here rather than generated from here: the
 * tables already exist and are already indexed, and describing them in metadata
 * is what makes them configurable without pretending they are generic. That is
 * the hybrid, and it is deliberate.
 */

import { all, one, run, transact } from '../db.js';

/* ------------------------------------------------------- type palette */

/**
 * The field types an administrator may choose, and what each means to storage,
 * validation and the query compiler.
 *
 * `derived: true` types are read-only and never written. `sensitive: true` types
 * default to encryption because forgetting is the expensive direction.
 */
export const FIELD_TYPES = {
  // Derived — the category that deletes automation
  auto_number: { label: 'Auto Number', derived: true, sql: 'TEXT', condition: 'text' },
  formula: { label: 'Formula', derived: true, sql: null, condition: 'number' },
  rollup: { label: 'Roll-Up Summary', derived: true, sql: null, condition: 'number' },

  // Relationship
  lookup: { label: 'Lookup', sql: 'INTEGER', condition: 'user', target: true },
  polymorphic_lookup: { label: 'Lookup (multiple types)', sql: 'TEXT', condition: 'text', target: true },

  // Primitive
  checkbox: { label: 'Checkbox', sql: 'INTEGER', condition: 'boolean', store: 'bool_value' },
  currency: { label: 'Currency', sql: 'REAL', condition: 'number', store: 'num_value', precision: true },
  date: { label: 'Date', sql: 'TEXT', condition: 'date', store: 'date_value' },
  datetime: { label: 'Date/Time', sql: 'TEXT', condition: 'date', store: 'date_value' },
  email: { label: 'Email', sql: 'TEXT', condition: 'text', store: 'text_value' },
  number: { label: 'Number', sql: 'REAL', condition: 'number', store: 'num_value', precision: true },
  percent: { label: 'Percent', sql: 'REAL', condition: 'number', store: 'num_value' },
  phone: { label: 'Phone', sql: 'TEXT', condition: 'text', store: 'text_value' },
  picklist: { label: 'Picklist', sql: 'TEXT', condition: 'enum', store: 'text_value', values: true },
  multipicklist: { label: 'Picklist (multi-select)', sql: 'TEXT', condition: 'enum', store: 'text_value', values: true, multi: true },
  text: { label: 'Text', sql: 'TEXT', condition: 'text', store: 'text_value', length: true },
  textarea: { label: 'Text Area', sql: 'TEXT', condition: 'text', store: 'text_value' },
  richtext: { label: 'Text Area (Rich)', sql: 'TEXT', condition: 'text', store: 'text_value' },
  encrypted_text: { label: 'Text (Encrypted)', sql: 'TEXT', condition: 'text', store: 'text_value', sensitive: true },
  time: { label: 'Time', sql: 'TEXT', condition: 'text', store: 'text_value' },
  url: { label: 'URL', sql: 'TEXT', condition: 'text', store: 'text_value' },

  // Compound — one field, several stored parts. Replaces the legacy tenant's six
  // unrelated address columns.
  address: { label: 'Address', sql: 'TEXT', condition: 'text', store: 'text_value', compound: ['street', 'city', 'state', 'country', 'postcode'] },
};

export const typeOf = (code) => FIELD_TYPES[code] ?? null;

/** Which `field_value` column a type lands in. */
export const storeColumn = (type) => FIELD_TYPES[type]?.store ?? 'text_value';

/* ------------------------------------------------- the core registry */

/**
 * The entities that already exist as real tables, described so they get the same
 * configuration surfaces as anything an administrator creates later.
 *
 * `columns` lists the core fields worth exposing to configuration. This is
 * deliberately NOT every column — `password`, internal FKs and bookkeeping
 * timestamps are not things anyone should relabel or reorder, and offering them
 * would be noise in every field picker.
 */
const CORE_ENTITIES = [
  {
    api_name: 'lead', label: 'Lead', label_plural: 'Leads', table_name: 'leads',
    icon: 'group_add', owner_type: 'user_or_queue',
    has_activities: 1, has_record_types: 1, has_approvals: 1,
    columns: [
      ['name', 'Name', 'text', { required: 1, length: 120 }],
      ['mobile', 'Mobile', 'phone', { indexed: 1 }],
      ['email', 'Email', 'email', {}],
      ['pan', 'PAN', 'encrypted_text', { encrypted: 1, read_scope: 'capability', read_capability: 'pii.unmask' }],
      ['city', 'City', 'text', {}],
      ['state', 'State', 'text', {}],
      ['language', 'Language', 'picklist', {}],
      ['risk_profile', 'Risk Profile', 'picklist', {}],
      ['source', 'Source', 'picklist', { indexed: 1 }],
      ['stage', 'Stage', 'picklist', { required: 1, indexed: 1, history_tracked: 1 }],
      ['owner_id', 'Owner', 'lookup', { indexed: 1, history_tracked: 1 }],
      ['partner_id', 'Sourced by Partner', 'lookup', {}],
      ['client_code', 'Client Code', 'text', { indexed: 1 }],
      ['sales_org', 'Sales Org', 'picklist', { required: 1, indexed: 1 }],
      ['mobile_invalid', 'Mobile Invalid', 'checkbox', {}],
      ['marketing_opt_out', 'Opted Out of Marketing', 'checkbox', {}],
      ['created_at', 'Created', 'datetime', {}],
      /* Business figures that had no definition at all, so they could not be
         relabelled, masked, reported on or used to build a dashboard panel.
         AUM is the headline number on a lead and "total AUM by stage" is the
         first thing a supervisor asks for; its absence from the metadata layer
         was a gap rather than a decision. */
      ['aum', 'AUM', 'currency', { indexed: 1 }],
      ['score', 'Lead Score', 'number', { indexed: 1 }],
      ['callback_at', 'Callback At', 'datetime', {}],
      ['next_follow_up_at', 'Next Follow-up', 'datetime', {}],
    ],
  },
  {
    api_name: 'interaction', label: 'Interaction', label_plural: 'Interactions', table_name: 'activities',
    icon: 'forum', owner_type: 'user',
    columns: [
      ['type', 'Channel', 'picklist', { required: 1, indexed: 1 }],
      ['direction', 'Direction', 'picklist', {}],
      ['subject', 'Subject', 'text', { length: 200 }],
      // The "metadata open, content restricted" split, expressed as field-level
      // security rather than row-level: everyone sees that a call happened and
      // how it went; the body and the recording need ownership or supervision.
      ['body', 'Notes', 'textarea', { read_scope: 'owner_or_manager' }],
      /* `outcome` is NOT defined here, deliberately. The activities table has
         both `outcome` and `disposition` holding the same concept, and their
         values have drifted apart — disposition carries the three canonical
         ones from the dispositions table, outcome carries a longer legacy set
         nobody maintains. Defining it would bless a duplication rather than
         record a field. It is written up as a finding instead: one question,
         two columns, which is the shape the legacy audit kept finding. */
      ['disposition', 'Outcome', 'picklist', { indexed: 1 }],
      ['sub_disposition', 'Sub-outcome', 'picklist', { indexed: 1 }],
      ['reason', 'Reason', 'text', { read_scope: 'owner_or_manager' }],
      ['duration_s', 'Duration (seconds)', 'number', {}],
      ['recording_url', 'Recording', 'url', { read_scope: 'owner_or_manager' }],
      ['follow_up_at', 'Follow-up At', 'datetime', {}],
      ['meeting_at', 'Meeting At', 'datetime', {}],
      ['created_at', 'Occurred', 'datetime', { indexed: 1 }],
    ],
  },
  {
    api_name: 'product_interest', label: 'Product Interest', label_plural: 'Product Interests',
    table_name: 'product_cards', icon: 'inventory_2', owner_type: 'user', has_record_types: 1,
    columns: [
      ['state', 'Stage', 'picklist', { required: 1, indexed: 1, history_tracked: 1 }],
      ['value', 'Value', 'currency', { precision: 16, scale: 2 }],
      ['product_rm_id', 'Product RM', 'lookup', {}],
      ['contact_flag', 'Contact Flag', 'picklist', {}],
      ['lost_reason', 'Lost Reason', 'text', {}],
    ],
  },
  {
    api_name: 'case', label: 'Case', label_plural: 'Cases', table_name: 'tickets',
    icon: 'support_agent', owner_type: 'user_or_queue', has_approvals: 1,
    columns: [
      ['ref', 'Case Number', 'auto_number', {}],
      ['subject', 'Subject', 'text', { required: 1, length: 200 }],
      ['description', 'Description', 'textarea', {}],
      ['priority', 'Priority', 'picklist', { indexed: 1 }],
      ['status', 'Status', 'picklist', { required: 1, indexed: 1, history_tracked: 1 }],
      ['assignee_id', 'Assigned To', 'lookup', { indexed: 1, history_tracked: 1 }],
      ['resolution_due', 'Resolution Due', 'datetime', {}],
      ['breached', 'SLA Breached', 'checkbox', {}],
      ['channel', 'Channel', 'picklist', {}],
      ['csat', 'Satisfaction', 'number', {}],
    ],
  },
  {
    /* P2-21 / A-6. The Client object had no metadata definition at all.
     *
     * Clients had a table, screens and reports, but nothing in entity_def — so
     * the Object Manager did not list them and no field on a client could be
     * relabelled, masked, made required or added to. "Configuration options for
     * all objects" was true of five objects and silently false of the one that
     * holds the converted book.
     *
     * Its fields are the ones an administrator has any business configuring.
     * The trading aggregates (ledger balance, margin, holding value) are
     * deliberately absent: they are written by the broking back office, not by
     * anyone here, and offering them as configurable fields would invite an
     * edit that the next sync silently overwrites. */
    api_name: 'client', label: 'Client', label_plural: 'Clients', table_name: 'clients',
    icon: 'account_balance_wallet', owner_type: 'user', has_activities: 1, has_approvals: 1,
    columns: [
      ['name', 'Name', 'text', { required: 1, indexed: 1 }],
      ['client_code', 'Client Code', 'text', { required: 1, indexed: 1 }],
      ['pan', 'PAN', 'encrypted_text', { encrypted: 1, read_scope: 'capability', read_capability: 'pii.unmask' }],
      ['mobile', 'Mobile', 'phone', { indexed: 1 }],
      ['email', 'Email', 'email', {}],
      ['demat_id', 'Demat ID', 'text', {}],
      ['status', 'Status', 'picklist', { required: 1, indexed: 1, history_tracked: 1 }],
      ['risk_profile', 'Risk Profile', 'picklist', {}],
      ['nominee_name', 'Nominee', 'text', {}],
      ['owner_id', 'Relationship Manager', 'lookup', { indexed: 1, history_tracked: 1 }],
      ['partner_id', 'Partner', 'lookup', { indexed: 1 }],
      ['brokerage_ytd', 'Brokerage YTD', 'currency', {}],
      ['last_traded_at', 'Last Traded', 'datetime', {}],
    ],
  },
  {
    api_name: 'partner', label: 'Partner', label_plural: 'Partners', table_name: 'partners',
    icon: 'handshake', owner_type: 'user', has_approvals: 1,
    columns: [
      ['name', 'Name', 'text', { required: 1 }],
      ['business_name', 'Business Name', 'text', {}],
      ['partner_model', 'Partner Model', 'picklist', {}],
      ['state_code', 'Status', 'picklist', { required: 1, history_tracked: 1 }],
      ['pan', 'PAN', 'encrypted_text', { encrypted: 1, read_scope: 'capability', read_capability: 'pii.unmask' }],
      ['bank_account', 'Bank Account', 'encrypted_text', { encrypted: 1, read_scope: 'capability', read_capability: 'pii.unmask' }],
      ['commission_pct', 'Commission %', 'percent', {}],
      ['mobile', 'Mobile', 'phone', {}],
      ['email', 'Email', 'email', {}],
      ['city', 'City', 'text', {}],
      ['sebi_reg_no', 'SEBI Registration', 'text', {}],
      ['owner_id', 'Partner RM', 'lookup', { indexed: 1 }],
    ],
  },
  {
    api_name: 'task', label: 'Task', label_plural: 'Tasks', table_name: 'tasks',
    icon: 'assignment_turned_in', owner_type: 'user_or_queue',
    columns: [
      ['title', 'Subject', 'text', { required: 1 }],
      ['kind', 'Type', 'picklist', {}],
      ['due_at', 'Due', 'datetime', { required: 1, indexed: 1 }],
      ['priority', 'Priority', 'picklist', {}],
      ['status', 'Status', 'picklist', { required: 1, history_tracked: 1 }],
      ['description', 'Notes', 'textarea', {}],
      ['assignee_id', 'Assigned To', 'lookup', { indexed: 1 }],
    ],
  },
];

/**
 * Register the core entities. Idempotent, and it never overwrites a label an
 * administrator has changed — the whole point of label/API separation is that
 * renaming is theirs to do and ours to preserve.
 */
export function seedMetadata() {
  return transact(() => {
    let fields = 0;

    CORE_ENTITIES.forEach((e, i) => {
      run(
        `INSERT INTO entity_def
           (api_name, label, label_plural, table_name, icon, owner_type,
            has_activities, has_record_types, has_approvals, is_custom, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,0,?)
         ON CONFLICT(api_name) DO UPDATE SET
           table_name = excluded.table_name, icon = excluded.icon,
           owner_type = excluded.owner_type,
           has_activities = excluded.has_activities,
           has_record_types = excluded.has_record_types,
           has_approvals = excluded.has_approvals,
           sort_order = excluded.sort_order`,
        [
          e.api_name, e.label, e.label_plural, e.table_name, e.icon, e.owner_type,
          e.has_activities ?? 0, e.has_record_types ?? 0, e.has_approvals ?? 0, i,
        ],
      );

      e.columns.forEach(([apiName, label, type, opts], j) => {
        const existing = one('SELECT id, label FROM field_def WHERE entity = ? AND api_name = ?', [e.api_name, apiName]);

        if (existing) {
          /* Preserve a renamed label; refresh everything the platform owns.
           *
           * sort_order is NOT refreshed, for the same reason the label is not:
           * it is the administrator's, not ours. This line used to set it back
           * to the position in CORE_ENTITIES on every boot, which would have
           * silently reverted the layout on the next restart or deploy —
           * shipping a feature that undoes itself. New fields still take their
           * position from the list below, so a fresh install is unchanged. */
          run(
            `UPDATE field_def SET type = ?, storage = 'column', required = ?, indexed = ?,
                    length = ?, precision = ?, scale = ?, encrypted = ?,
                    read_scope = ?, read_capability = ?, history_tracked = ?,
                    is_custom = 0
             WHERE id = ?`,
            [
              type, opts.required ?? 0, opts.indexed ?? 0,
              opts.length ?? null, opts.precision ?? null, opts.scale ?? null,
              opts.encrypted ?? 0, opts.read_scope ?? 'record', opts.read_capability ?? null,
              opts.history_tracked ?? 0, existing.id,
            ],
          );
        } else {
          run(
            `INSERT INTO field_def
               (entity, api_name, label, type, storage, required, indexed, length,
                precision, scale, encrypted, read_scope, read_capability,
                history_tracked, is_custom, sort_order)
             VALUES (?,?,?,?,'column',?,?,?,?,?,?,?,?,?,0,
                     (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM field_def WHERE entity = ?))`,
            [
              e.api_name, apiName, label, type,
              opts.required ?? 0, opts.indexed ?? 0, opts.length ?? null,
              opts.precision ?? null, opts.scale ?? null, opts.encrypted ?? 0,
              opts.read_scope ?? 'record', opts.read_capability ?? null,
              opts.history_tracked ?? 0,
              /* Appended, not placed at its index in the list above. On a fresh
                 install those are the same number; on an existing one they are
                 not, and inserting a field mid-list would give it the position
                 an existing field already holds. Two fields at one position
                 cannot be put in a deliberate order. */
              e.api_name,
            ],
          );
        }
        fields += 1;
      });
    });

    /* Reconcile, because the list above is the source of truth for core fields.
     *
     * A core definition removed from CORE_ENTITIES has to go, or the list and
     * the database drift and the screen shows a field nobody declared —
     * `interaction.outcome` was exactly that. Custom fields are untouched:
     * they are the administrator's, not ours. */
    for (const e of CORE_ENTITIES) {
      const declared = new Set(e.columns.map(([apiName]) => apiName));
      for (const f of all('SELECT id, api_name FROM field_def WHERE entity = ? AND is_custom = 0', [e.api_name])) {
        if (declared.has(f.api_name)) continue;
        run('DELETE FROM picklist_value WHERE field_id = ?', [f.id]);
        run('DELETE FROM field_def WHERE id = ?', [f.id]);
      }
    }

    /* Two fields cannot share a position, or their order is decided by the
     * label tiebreak rather than by anybody. Renumbering preserves the order
     * they are already in — an administrator's arrangement survives, the tie
     * does not. Only runs when there is actually a collision, so a settled
     * layout is never rewritten. */
    for (const e of CORE_ENTITIES) {
      const rows = all(
        'SELECT id, sort_order FROM field_def WHERE entity = ? ORDER BY sort_order, id',
        [e.api_name],
      );
      const positions = new Set(rows.map((r) => r.sort_order));
      if (positions.size === rows.length) continue;
      rows.forEach((r, i) => run('UPDATE field_def SET sort_order = ? WHERE id = ?', [i, r.id]));
    }

    return { entities: CORE_ENTITIES.length, fields };
  });
}

/* ------------------------------------------------- core picklist values */

/**
 * The allowed values for core picklists.
 *
 * These were scattered: some in `db.js` constants, some implied by whatever
 * happened to be in the column, some hard-coded in a `<select>` in the client.
 * That is how a lead ends up sourced from "Carrier Pigeon" — nothing was ever
 * the list, so nothing could reject anything.
 *
 * Now they are rows, which means an administrator can add a campaign source in
 * Setup without a deploy, the API validates against the same list the form
 * offers, and the client stops carrying its own copy.
 */
const CORE_PICKLISTS = {
  'lead.stage': [
    ['New', 'New'], ['Contacted', 'Contacted'], ['Qualified', 'Qualified'],
    ['In Progress', 'In Progress'], ['Won', 'Won'], ['Lost', 'Lost'],
  ],
  'lead.language': [
    ['English', 'English'], ['Hindi', 'Hindi'], ['Gujarati', 'Gujarati'],
    ['Marathi', 'Marathi'], ['Tamil', 'Tamil'], ['Telugu', 'Telugu'],
    ['Kannada', 'Kannada'], ['Bengali', 'Bengali'],
  ],
  'lead.risk_profile': [
    ['Conservative', 'Conservative'], ['Moderate', 'Moderate'], ['Aggressive', 'Aggressive'],
  ],
  'lead.source': [
    ['Website', 'Website'], ['Bigul app', 'Bigul app'], ['DKYC Portal', 'DKYC Portal'],
    ['Google Ads', 'Google Ads'], ['Facebook Lead Ads', 'Facebook Lead Ads'],
    ['Campaign — WhatsApp', 'Campaign — WhatsApp'], ['Webinar', 'Webinar'],
    ['Partner referral', 'Partner referral'],
    ['Referral — existing client', 'Referral — existing client'],
    ['Walk-in branch', 'Walk-in branch'], ['IPO enquiry', 'IPO enquiry'],
    ['Manual', 'Manual'], ['Import', 'Import'],
  ],
  'interaction.type': [
    ['Call', 'Call'], ['WhatsApp', 'WhatsApp'], ['Email', 'Email'], ['SMS', 'SMS'],
    ['Meeting', 'Meeting'], ['Note', 'Note'], ['Visit', 'Visit'],
  ],
  'interaction.direction': [
    ['outbound', 'Outbound'], ['inbound', 'Inbound'], ['system', 'System'],
  ],
  'case.priority': [
    ['Critical', 'Critical'], ['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low'],
  ],
  'task.priority': [
    ['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low'],
  ],
  'task.status': [
    ['Open', 'Open'], ['Done', 'Done'], ['Cancelled', 'Cancelled'],
  ],

  /* P2-21. Eight fields were declared as picklists and given no values.
   *
   * The Object Manager showed them as choice fields you could not choose from,
   * and every screen that offered them offered an empty list -- including
   * case.status, which is the status of the Ticket object. A picklist with no
   * values is worse than a text field: it promises a controlled vocabulary and
   * delivers nothing.
   *
   * The values below are the ones already in the data. They were living in
   * application code and in whatever rows happened to exist, which is the
   * "one question, several mechanisms" shape the legacy audit kept finding. */
  'case.status': [
    ['Open', 'Open'], ['Pending', 'Pending'], ['Waiting on Client', 'Waiting on Client'],
    ['Resolved', 'Resolved'], ['Closed', 'Closed'],
  ],
  'task.kind': [
    ['follow_up', 'Follow-up'], ['meeting', 'Meeting'], ['retry', 'Retry'],
  ],
  'partner.partner_model': [
    ['Associate', 'Associate'], ['Remisier', 'Remisier'],
    ['Authorised Person', 'Authorised Person'], ['Agent', 'Agent'],
    ['Trainee Entrepreneur', 'Trainee Entrepreneur'],
  ],
  'partner.state_code': [
    ['PROSPECT', 'Prospect'], ['QUALIFYING', 'Qualifying'], ['ONBOARDING', 'Onboarding'],
    ['ACTIVE', 'Active'], ['SUSPENDED', 'Suspended'],
  ],
  'product_interest.state': [
    ['EXPLORING', 'Exploring'], ['WARM', 'Warm'], ['KYC_IN_PROGRESS', 'KYC in progress'],
    ['PRODUCT_RM_ENGAGED', 'Product RM engaged'], ['ACTIVE', 'Active'],
    ['ON_HOLD', 'On hold'], ['INACTIVE', 'Inactive'], ['LOST', 'Lost'],
  ],
  'product_interest.contact_flag': [
    ['Direct Contact', 'Direct contact'],
    ['Schedule Joint Call', 'Schedule joint call'],
    ['No Direct Contact', 'No direct contact'],
  ],
  'client.status': [
    ['Active', 'Active'], ['Dormant', 'Dormant'], ['Suspended', 'Suspended'],
    ['Closed', 'Closed'],
  ],
  'case.channel': [
    ['Email', 'Email'], ['Phone', 'Phone'], ['WhatsApp', 'WhatsApp'],
    ['Portal', 'Portal'], ['Branch', 'Branch'],
  ],

  'client.risk_profile': [
    ['Conservative', 'Conservative'], ['Moderate', 'Moderate'], ['Aggressive', 'Aggressive'],
  ],
};

/**
 * Keep the interaction outcome picklists in step with the dispositions table.
 *
 * Call outcomes live in `dispositions`, which has its own setup screen and is
 * edited at runtime. The picklist is therefore a projection of that table, not
 * a second list of the same thing — restating them is how the outcome an RM
 * picks stops matching the one a report counts.
 *
 * The taxonomy is two levels and they are two columns. `outcome` is the top
 * level, which an activity stores in activities.disposition — Connected, Not
 * Connected, Other. `label` is the sub-outcome, of which there are twenty-odd.
 * Neither is `code`: seeding from that would fill the picker with
 * CALL_PITCH_DONE, an identifier rather than a choice anybody recognises.
 *
 * Syncs both directions. Adding only would have passed a test on the day it was
 * written and left every retired outcome in the dropdown for ever.
 */
export function syncDispositionPicklists() {
  return transact(applyDispositionPicklists);
}

/**
 * The body of the sync, without its own transaction.
 *
 * Separate because seedPicklists() already runs inside one, and SQLite has no
 * nested transactions — calling the wrapper from there took the server down at
 * boot rather than silently misbehaving, which is the right way round.
 */
function applyDispositionPicklists() {
  {
    let changed = 0;

    const levels = [
      ['disposition', 'SELECT DISTINCT outcome AS v FROM dispositions WHERE active = 1 AND outcome IS NOT NULL ORDER BY outcome'],
      ['sub_disposition', 'SELECT DISTINCT label AS v FROM dispositions WHERE active = 1 AND label IS NOT NULL ORDER BY label'],
    ];

    for (const [apiName, sql] of levels) {
      const field = fieldDef('interaction', apiName);
      if (!field) continue;

      const wanted = all(sql).map((r) => String(r.v));
      const have = new Map(
        all('SELECT id, value, active FROM picklist_value WHERE field_id = ?', [field.id])
          .map((v) => [v.value, v]),
      );

      wanted.forEach((value, i) => {
        const existing = have.get(value);
        if (!existing) {
          run('INSERT INTO picklist_value (field_id, value, label, sort_order) VALUES (?,?,?,?)',
            [field.id, value, value, i]);
          changed += 1;
        } else if (!existing.active) {
          // Came back: an outcome reactivated on the setup screen.
          run('UPDATE picklist_value SET active = 1, sort_order = ? WHERE id = ?', [i, existing.id]);
          changed += 1;
        }
      });

      /* Retired rather than deleted, for the same reason a field is: activities
         already store the value, and removing the row would leave those rows
         showing a value with no definition behind it. */
      const keep = new Set(wanted);
      for (const [value, row] of have) {
        if (!keep.has(value) && row.active) {
          run('UPDATE picklist_value SET active = 0 WHERE id = ?', [row.id]);
          changed += 1;
        }
      }
    }

    return changed;
  }
}

/**
 * Seed picklist values for the core fields.
 *
 * Only inserts what is missing, and never reactivates a value an administrator
 * has retired — retiring "Webinar" should survive the next deploy.
 */
export function seedPicklists() {
  return transact(() => {
    let added = 0;

    for (const [key, values] of Object.entries(CORE_PICKLISTS)) {
      const [entity, apiName] = key.split('.');
      const field = fieldDef(entity, apiName);
      if (!field) continue;

      values.forEach(([value, label], i) => {
        const existing = one(
          'SELECT id FROM picklist_value WHERE field_id = ? AND value = ?', [field.id, value],
        );
        if (existing) return;
        run(
          'INSERT INTO picklist_value (field_id, value, label, sort_order) VALUES (?,?,?,?)',
          [field.id, value, label, i],
        );
        added += 1;
      });
    }

    added += applyDispositionPicklists();

    // Sales org is not a fixed list — it is whatever orgs the business has.
    const orgField = fieldDef('lead', 'sales_org');
    if (orgField) {
      all('SELECT code, name FROM sales_orgs WHERE active = 1 ORDER BY sort_order').forEach((o, i) => {
        if (one('SELECT id FROM picklist_value WHERE field_id = ? AND value = ?', [orgField.id, o.code])) return;
        run('INSERT INTO picklist_value (field_id, value, label, sort_order) VALUES (?,?,?,?)',
          [orgField.id, o.code, o.name, i]);
        added += 1;
      });
    }

    return added;
  });
}

/* ---------------------------------------------------------- accessors */

export const entities = () => all('SELECT * FROM entity_def WHERE active = 1 ORDER BY sort_order, label');
export const entityDef = (apiName) => one('SELECT * FROM entity_def WHERE api_name = ?', [apiName]);

/**
 * The fields of one object, in layout order.
 *
 * Ordered by sort_order alone. It used to sort by `is_custom` first, which
 * pinned every custom field below every core one however they were arranged —
 * so an administrator could not put "Preferred Call Window" next to the phone
 * number, which is the entire point of being able to order a layout. Custom
 * fields are appended on creation, so they still land at the bottom by default;
 * the difference is that they no longer have to stay there.
 */
export function fieldsOf(entity, { includeInactive = false } = {}) {
  return all(
    `SELECT * FROM field_def WHERE entity = ? ${includeInactive ? '' : 'AND active = 1'}
     ORDER BY sort_order, label`,
    [entity],
  );
}

export const fieldDef = (entity, apiName) =>
  one('SELECT * FROM field_def WHERE entity = ? AND api_name = ?', [entity, apiName]);

/** Picklist values, narrowed by the controlling field's current value. */
export function picklistValues(fieldId, controllingValue = null) {
  const rows = all(
    'SELECT * FROM picklist_value WHERE field_id = ? AND active = 1 ORDER BY sort_order, label',
    [fieldId],
  );
  if (controllingValue == null) return rows;
  return rows.filter((v) => v.controlling_value == null
    || String(v.controlling_value).toLowerCase() === String(controllingValue).toLowerCase());
}

/* ----------------------------------------------- field-level security */

/**
 * Who may read a field's VALUE, as distinct from who may read the record.
 *
 * This is the mechanism behind the interaction decision: everyone who can see a
 * lead sees that a call happened, when, and how it went — because coverage
 * reporting and "who has gone quiet" depend on it — while the notes body and the
 * recording need ownership or supervision.
 *
 * Row-level security cannot express that. Hiding the interaction to protect the
 * note would also hide the fact of the call, and supervision reporting would go
 * dark. So the restriction lives on the field.
 *
 *   record            anyone who can read the record
 *   owner_or_manager  the record's owner, anyone above them in the management
 *                     chain, or a capability holder
 *   capability        only holders of the named capability
 */

const managerChain = (userId) => {
  const chain = new Set();
  let current = userId;
  // Bounded: a management chain deeper than this is a data error, and an
  // unbounded walk over a cycle would hang the request.
  for (let i = 0; i < 12 && current; i += 1) {
    const row = one('SELECT manager_id FROM users WHERE id = ?', [current]);
    current = row?.manager_id ?? null;
    if (current) {
      if (chain.has(current)) break;   // cycle
      chain.add(current);
    }
  }
  return chain;
};

/** True when `user` may read `field` on a record owned by `ownerId`. */
export function canReadField(user, field, ownerId, caps = null) {
  if (!user) return false;
  if (field.read_scope === 'record') return true;

  const capabilities = caps ?? new Set();
  if (field.read_capability && capabilities.has(field.read_capability)) return true;

  if (field.read_scope === 'capability') return false;

  if (field.read_scope === 'owner_or_manager') {
    if (ownerId == null) return true;                // unowned: nothing to protect
    if (Number(ownerId) === Number(user.id)) return true;
    return managerChain(ownerId).has(user.id);
  }

  return true;
}

/**
 * Redact the fields on a row that this user may not read, in place of the whole
 * row. The row still arrives; the restricted values become null and are named in
 * `_restricted` so the UI can say "notes hidden" rather than "no notes".
 *
 * Silence and absence must not look the same. A supervisor who sees an empty
 * notes field should know it is withheld, not that the rep wrote nothing.
 */
export function applyFieldSecurity(entity, rows, user, { ownerKey = 'user_id', caps = null } = {}) {
  const restricted = fieldsOf(entity).filter((f) => f.read_scope !== 'record');
  if (!restricted.length) return rows;

  const capabilities = caps ?? new Set();
  const list = Array.isArray(rows) ? rows : [rows];

  const out = list.map((row) => {
    if (!row) return row;
    const hidden = [];
    const copy = { ...row };

    for (const f of restricted) {
      if (!(f.api_name in copy)) continue;
      if (copy[f.api_name] == null) continue;
      if (!canReadField(user, f, row[ownerKey], capabilities)) {
        copy[f.api_name] = null;
        hidden.push(f.api_name);
      }
    }

    if (hidden.length) copy._restricted = hidden;
    return copy;
  });

  return Array.isArray(rows) ? out : out[0];
}

/* ------------------------------------------------- custom field values */

/** Read every custom field for one record, keyed by api_name. */
export function customValues(entity, recordId) {
  const rows = all(
    `SELECT f.api_name, f.type, v.text_value, v.num_value, v.date_value, v.bool_value
     FROM field_value v
     JOIN field_def f ON f.id = v.field_id AND f.active = 1
     WHERE v.entity = ? AND v.record_id = ?`,
    [entity, recordId],
  );

  const out = {};
  for (const r of rows) {
    const col = storeColumn(r.type);
    out[r.api_name] = col === 'bool_value' ? Boolean(r[col]) : r[col];
  }
  return out;
}

/**
 * Write custom field values.
 *
 * Validation lives here rather than at each caller, because the point of the
 * metadata layer is that a new field is configured once and enforced everywhere
 * — including on writes arriving from automation and integrations, which never
 * touch a form.
 */
export function setCustomValues(entity, recordId, values, { actorId = null, source = 'ui' } = {}) {
  const defs = new Map(fieldsOf(entity).map((f) => [f.api_name, f]));
  const errors = {};
  const written = [];

  transact(() => {
    for (const [apiName, raw] of Object.entries(values ?? {})) {
      const f = defs.get(apiName);
      if (!f || f.storage !== 'value') continue;          // unknown or core field
      if (FIELD_TYPES[f.type]?.derived) continue;         // never written

      if (f.required && (raw == null || raw === '')) {
        errors[apiName] = `${f.label} is required`;
        continue;
      }

      // Cascading picklists, enforced here so an API write cannot bypass them.
      if (f.type === 'picklist' || f.type === 'multipicklist') {
        const controllingValue = f.controlling_field
          ? (values[one('SELECT api_name FROM field_def WHERE id = ?', [f.controlling_field])?.api_name] ?? null)
          : null;
        const allowed = picklistValues(f.id, controllingValue).map((v) => v.value);
        if (raw != null && raw !== '' && allowed.length && !allowed.includes(String(raw))) {
          errors[apiName] = `"${raw}" is not a permitted value for ${f.label}`;
          continue;
        }
      }

      const col = storeColumn(f.type);
      const before = one(
        `SELECT ${col} AS v FROM field_value WHERE entity = ? AND record_id = ? AND field_id = ?`,
        [entity, recordId, f.id],
      )?.v ?? null;

      const value = col === 'bool_value' ? (raw ? 1 : 0) : raw;

      run(
        `INSERT INTO field_value (entity, record_id, field_id, ${col})
         VALUES (?,?,?,?)
         ON CONFLICT(entity, record_id, field_id) DO UPDATE SET ${col} = excluded.${col}`,
        [entity, recordId, f.id, value],
      );

      if (f.history_tracked && String(before ?? '') !== String(value ?? '')) {
        run(
          `INSERT INTO field_history (entity, record_id, field, old_value, new_value, actor_id, source)
           VALUES (?,?,?,?,?,?,?)`,
          [entity, recordId, apiName, before, value, actorId, source],
        );
      }
      written.push(apiName);
    }
  });

  return { ok: Object.keys(errors).length === 0, errors, written };
}

/* ------------------------------------------------------------ history */

/** Record a change to a CORE column. Custom fields are handled above. */
export function recordChange(entity, recordId, field, oldValue, newValue, { actorId = null, source = 'ui' } = {}) {
  if (String(oldValue ?? '') === String(newValue ?? '')) return false;

  const def = fieldDef(entity, field);
  if (!def?.history_tracked) return false;

  run(
    `INSERT INTO field_history (entity, record_id, field, old_value, new_value, actor_id, source)
     VALUES (?,?,?,?,?,?,?)`,
    [entity, recordId, field, oldValue, newValue, actorId, source],
  );
  return true;
}

/** The change history for one record, newest first. */
export const historyFor = (entity, recordId, limit = 100) => all(
  `SELECT h.*, u.name AS actor_name, f.label AS field_label
   FROM field_history h
   LEFT JOIN users u ON u.id = h.actor_id
   LEFT JOIN field_def f ON f.entity = h.entity AND f.api_name = h.field
   WHERE h.entity = ? AND h.record_id = ?
   ORDER BY h.changed_at DESC, h.id DESC LIMIT ?`,
  [entity, recordId, limit],
);

/**
 * Stage entry and exit, derived from history rather than stamped.
 *
 * Six legacy automations exist only because this could not be asked. Here it is
 * a query over data the platform already keeps.
 */
export function stageDurations(entity, recordId, field = 'stage') {
  const rows = all(
    `SELECT old_value, new_value, changed_at FROM field_history
     WHERE entity = ? AND record_id = ? AND field = ?
     ORDER BY changed_at`,
    [entity, recordId, field],
  );

  const spans = [];
  for (let i = 0; i < rows.length; i += 1) {
    const exitAt = rows[i + 1]?.changed_at ?? null;
    spans.push({
      stage: rows[i].new_value,
      entered_at: rows[i].changed_at,
      exited_at: exitAt,
      days: exitAt
        ? Math.round((Date.parse(`${exitAt.replace(' ', 'T')}Z`) - Date.parse(`${rows[i].changed_at.replace(' ', 'T')}Z`)) / 86_400_000)
        : null,
    });
  }
  return spans;
}

/* ------------------------------------------------------- config audit */

/** Every schema change, with before and after. */
export function auditConfig(area, target, action, before, after, actorId) {
  run(
    `INSERT INTO config_audit (area, target, action, before_json, after_json, actor_id)
     VALUES (?,?,?,?,?,?)`,
    [area, target, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actorId],
  );
}
