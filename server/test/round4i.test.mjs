/**
 * Ritesh's Part 4, item 8.4 (16 Oct 2026): every action says what it did.
 *
 * Ruled the same day: every action button in the CRM. The list of every write
 * the client makes, and what each now says, is
 * docs/feedback/PART-4-ACTION-FEEDBACK.md. These checks hold the mechanism and
 * the screens that said nothing before to it.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const read = (...rel) => fs.readFileSync(path.join(REPO, ...rel), 'utf8').replace(/\r\n/g, '\n');
const client = (rel) => read('client', 'src', ...rel.split('/'));

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nPart 4, item 8.4: every action says what it did (source checks)');

test('one way to say it: announce(), shown until OK, in the CRM and the partner portal', () => {
  const ui = client('components/ui.jsx');
  assert(/export function announce\(title, lines = \[\], tone = 'ok'\)/.test(ui), 'no announce()');
  assert(/export function OutcomeHost\(\)/.test(ui), 'no OutcomeHost');
  const host = ui.slice(ui.indexOf('export function OutcomeHost('), ui.indexOf('export function Outcome('));
  assert(/onClick=\{\(\) => close\(o\.id\)\}>OK<\/button>/.test(host), 'a message cannot be closed with OK');
  assert(!/setTimeout/.test(host), 'a message goes away by itself, before anybody has read it');
  assert(/<OutcomeHost \/>/.test(client('crm/Crm.jsx')), 'the CRM does not show them');
  assert(/<OutcomeHost \/>/.test(client('portal/PartnerPortal.jsx')), 'the partner portal does not show them');
});

/* The screens whose actions said nothing, and the action each now reports. */
const SILENT_BEFORE = {
  'crm/admin/Automations.jsx': /announce\(`"\$\{r\.rule\.name\}" converted`/,
  'crm/admin/FlowBuilder.jsx': /announce\(action === 'activate' \? 'Automation activated' : 'Automation paused'/,
  'crm/admin/CaptureForms.jsx': /announce\('Form saved'/,
  'crm/Messages.jsx': /announce\(approve \? 'Transfer approved' : 'Transfer declined'/,
  'crm/PartnerProfile.jsx': /announce\('Portal access withdrawn'/,
  'crm/admin/Campaigns.jsx': /announce\('Campaign sent'/,
  'crm/LeadDetail.jsx': /announce\('Task created'/,
  'crm/Tickets.jsx': /announce\(`\$\{ticket\.ref\} reopened`/,
  'crm/admin/MetaConnector.jsx': /announce\('Audience pushed'/,
  'crm/admin/MessagingSetup.jsx': /announce\('Messaging suspended'/,
  'crm/admin/users.jsx': /announce\(user\.active \? `\$\{user\.name\} disabled`/,
  'crm/GroupsSetup.jsx': /announce\('Group deleted'/,
  'portal/PartnerPortal.jsx': /announce\(`Request \$\{t\.ref\} raised`/,
  'crm/admin/WebhookEndpoints.jsx': /announce\(e\.active \? 'Webhook paused' : 'Webhook resumed'/,
  'crm/admin/Sla.jsx': /announce\('Category restored'/,
  'crm/admin/Rules.jsx': /announce\(r\.enabled \? 'Rule disabled' : 'Rule enabled'/,
  'crm/ValidationRules.jsx': /announce\('Validation rule deleted'/,
  'crm/Tasks.jsx': /announce\('Task created'/,
  'crm/ProductsSetup.jsx': /announce\(p\.active \?/,
  'crm/Libraries.jsx': /announce\('Added to the library'/,
  'crm/ApiAccess.jsx': /announce\('Key revoked'/,
  'crm/KycConsole.jsx': /announce\('Stall check done'/,
  'crm/FieldMasking.jsx': /announce\('Masking saved'/,
  'crm/Clients.jsx': /announce\('Clients exported'/,
  'crm/ObjectManager.jsx': /announce\('Field order saved'/,
  'crm/admin/TestRecords.jsx': /announce\('Unmarked'/,
  'crm/admin/Calendars.jsx': /announce\('Day removed'/,
  'crm/TabVisibility.jsx': /announce\('Tabs saved'/,
  'crm/Partners.jsx': /announce\('Partners exported'/,
  'crm/LeadLists.jsx': /announce\('List refreshed'/,
  'crm/Dispositions.jsx': /announce\('Call outcome saved'/,
  'crm/DataTools.jsx': /announce\('Lead restored'/,
  'crm/admin/UserExport.jsx': /announce\(required \? 'Field required' : 'Field optional'/,
  'crm/UsersSetup.jsx': /announce\(active \? 'Users enabled' : 'Users disabled'/,
  'crm/Calendar.jsx': /announce\('Calendar synced'/,
  'crm/BusinessPolicies.jsx': /announce\('Policies saved'/,
  'crm/Attendance.jsx': /announce\(what === 'check-in'/,
};

test('each screen that said nothing now says what it did', () => {
  const missing = Object.entries(SILENT_BEFORE)
    .filter(([file, says]) => !says.test(client(file))
      || !/import \{[^}]*\bannounce\b[^}]*\} from '[^']*components\/ui\.jsx'/.test(client(file)))
    .map(([file]) => file);
  assert.deepEqual(missing, [], `still silent: ${missing.join(', ')}`);
});

test('a message names what the server answered, not a guess (spot checks)', () => {
  // The campaign send says how many it reached, from the answer.
  assert(/went to \$\{r\.sent\}/.test(client('crm/admin/Campaigns.jsx')));
  // The audience push says it left India unless simulated.
  assert(/Hashed identifiers have left India/.test(client('crm/admin/MetaConnector.jsx')));
  // A library item says whether it can be sent, from its status.
  assert(/item\?\.status === 'approved'/.test(client('crm/Libraries.jsx')));
  // A list refresh says the count it now holds.
  assert(/r\.after/.test(client('crm/LeadLists.jsx')));
});

test('the KYC stall sweep is a button, not bare text, and says what it found', () => {
  const kyc = client('crm/KycConsole.jsx');
  assert(/<button type="button" className="btn" onClick=\{async \(\) => \{\s*try \{\s*const r = await api\.post\('\/kyc\/sweep'\)/.test(kyc), 'still bare text that says nothing');
});

test('the list of every action, and what it says, is kept', () => {
  const doc = read('docs', 'feedback', 'PART-4-ACTION-FEEDBACK.md');
  const rows = doc.split('\n').filter((l) => /^\| [a-z]/.test(l));
  assert(rows.length >= 120, `only ${rows.length} rows`);
  for (const file of Object.keys(SILENT_BEFORE)) {
    const screen = file.replace(/\.jsx$/, '');
    assert(rows.some((r) => r.startsWith(`| ${screen} `) || r.includes(screen)), `${screen} is not in the list`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
