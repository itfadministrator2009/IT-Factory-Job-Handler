// ITF Asset Tracker tools: filters, duplicate-serial checks, customer name
// grouping, and allocation batches with a packing list.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, staff, base;
const add = (id, f) => db.prepare('INSERT INTO assets (id, fields_json) VALUES (?, ?)').run(id, JSON.stringify(f));
const ids = (r) => r.data.assets.map((a) => a.id).sort();

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/assets', require('../routes/assets'));
  client = await startTestServer(app);
  server = client.server;
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);
  add('a1', { asset_tag: 'T1', serial_number: 'SER-1', category: 'Laptop', customer: 'Acme', status: 'Available' });
  add('a2', { asset_tag: 'T2', serial_number: 'SER-2', category: 'Laptop', customer: 'ACME ', status: 'Sold', asset_sent_to: 'Wholesale' });
  add('a3', { asset_tag: 'T3', serial_number: 'ser-2', category: 'Monitor', customer: 'Beta', status: 'Available' });
  add('a4', { asset_tag: 'T4', serial_number: 'SER-4', category: 'Monitor', status: 'Available' });
  // Most tests here add bare-bones assets; the required-fields test turns requirements back on.
  db.prepare('UPDATE asset_field_defs SET required = 0').run();
});

after(() => server.close());

test('filters: exact field values, customer spellings as one, blank, duplicates only', async () => {
  assert.deepEqual(ids(await client.get('/api/assets?category=laptop', { token: staff.token })), ['a1', 'a2']);
  assert.deepEqual(ids(await client.get('/api/assets?customer=acme', { token: staff.token })), ['a1', 'a2']);
  assert.deepEqual(ids(await client.get('/api/assets?customer=__none__', { token: staff.token })), ['a4']);
  assert.deepEqual(ids(await client.get('/api/assets?category=Monitor&status=Available', { token: staff.token })), ['a3', 'a4']);
  assert.deepEqual(ids(await client.get('/api/assets?dupes=1', { token: staff.token })), ['a2', 'a3']);
  const all = await client.get('/api/assets/all-ids?sent_to=Wholesale', { token: staff.token });
  assert.deepEqual(all.data.ids, ['a2']);

  const opts = await client.get('/api/assets/filter-options', { token: staff.token });
  assert.deepEqual(opts.data.customer, [{ value: 'Acme', count: 2 }, { value: 'Beta', count: 1 }]);
  assert.ok(opts.data.category.includes('Laptop') && opts.data.sent_to.includes('ITF Australia'));
});

test('reports group customer spellings together', async () => {
  const { data } = await client.get('/api/assets/reports/summary', { token: admin.token });
  assert.deepEqual(data.byCompany.find((r) => r.company === 'Acme'), { company: 'Acme', count: 2 });
  assert.equal(data.byCompany.some((r) => r.company === 'ACME '), false);
  assert.equal(data.classRows.filter((r) => r.customer === 'Acme').reduce((t, r) => t + r.count, 0), 2);

  // One customer (any spelling): every count narrows, By Customer still lists all.
  const one = (await client.get('/api/assets/reports/summary?customer=acme', { token: admin.token })).data;
  assert.equal(one.total, 2);
  assert.equal(one.byMonth.reduce((t, r) => t + r.count, 0), 2);
  assert.equal(one.byTech.reduce((t, r) => t + r.count, 0), 2);
  assert.equal(one.classRows.reduce((t, r) => t + r.count, 0), 2);
  assert.ok(one.byCompany.some((r) => r.company === 'Beta'));
});

test('adding or editing an asset warns about a serial already on file, unless told to save anyway', async () => {
  const dup = await client.post('/api/assets', { token: staff.token, body: { fields: { serial_number: ' ser-1 ' } } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'duplicate_serial');
  assert.equal(dup.data.matches[0].assetTag, 'T1');
  const forced = await client.post('/api/assets', { token: staff.token, body: { fields: { serial_number: 'SER-1', asset_tag: 'T5' }, allowDuplicateSerial: true } });
  assert.equal(forced.status, 201);

  // Editing other fields of an asset never trips the check; changing its serial to one in use does.
  assert.equal((await client.patch('/api/assets/a3', { token: staff.token, body: { fields: { status: 'Sold', serial_number: 'ser-2' } } })).status, 200);
  const clash = await client.patch('/api/assets/a4', { token: staff.token, body: { fields: { serial_number: 'SER-2' } } });
  assert.equal(clash.status, 409);
  assert.equal((await client.patch('/api/assets/a4', { token: staff.token, body: { fields: { serial_number: 'SER-NEW' } } })).status, 200);
  db.prepare("DELETE FROM assets WHERE id = ?").run(forced.data.asset.id);
});

test('import skips rows whose serial is already on file (or repeated in the file) unless asked', async () => {
  const csv = 'Serial Number,Category\nSER-1,Laptop\nNEW-1,Laptop\nnew-1,Laptop\nNEW-2,Monitor\n';
  const send = async (extra) => {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'import.csv');
    if (extra === true) form.append('allowDuplicates', '1');
    if (Array.isArray(extra)) form.append('onlyRows', JSON.stringify(extra));
    const r = await fetch(`${base}/api/assets/import`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form });
    return r.json();
  };
  const before = db.prepare('SELECT COUNT(*) c FROM assets').get().c;
  const r1 = await send(false);
  assert.equal(r1.created, 2);
  assert.deepEqual(r1.duplicateSerials, ['SER-1', 'new-1']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assets').get().c, before + 2);
  assert.deepEqual(r1.skippedRows, [1, 3]);
  // "Import the skipped rows anyway" re-sends the file with just those rows.
  const r2 = await send(r1.skippedRows);
  assert.equal(r2.created, 2, 'only the two skipped rows are added');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assets').get().c, before + 4);
  const r3 = await send(true);
  assert.equal(r3.created, 4, 'everything imported when duplicates are allowed');
});

test('allocation batches: create from assets, add/remove, packing list, and filter the list by batch', async () => {
  assert.equal((await client.post('/api/assets/batches', { token: staff.token, body: { name: 'X', assetIds: ['a1'] } })).status, 403);
  assert.equal((await client.post('/api/assets/batches', { token: admin.token, body: { name: ' ', assetIds: ['a1'] } })).status, 400);

  const created = await client.post('/api/assets/batches', { token: admin.token, body: { name: 'Wholesale – Buyer X – Oct', notes: 'Pick up Friday', assetIds: ['a1', 'a2', 'nope'] } });
  assert.equal(created.status, 201);
  assert.equal(created.data.added, 2);
  const bid = created.data.batch.id;
  assert.equal(created.data.batch.number, 1);

  const more = await client.post(`/api/assets/batches/${bid}/items`, { token: admin.token, body: { assetIds: ['a2', 'a3'] } });
  assert.equal(more.data.added, 1, 'an asset already in the batch is not added twice');
  assert.deepEqual(ids(await client.get(`/api/assets?batch=${bid}`, { token: admin.token })), ['a1', 'a2', 'a3']);

  await client.post(`/api/assets/batches/${bid}/remove`, { token: admin.token, body: { assetIds: ['a3'] } });
  // A deleted asset stays on the batch from its snapshot.
  db.prepare("DELETE FROM assets WHERE id = 'a1'").run();
  const detail = await client.get(`/api/assets/batches/${bid}`, { token: admin.token });
  assert.equal(detail.data.batch.count, 2);
  const gone = detail.data.items.find((i) => i.assetId === 'a1');
  assert.equal(gone.deleted, true);
  assert.equal(gone.fields.serial_number, 'SER-1');

  const list = await client.get('/api/assets/batches', { token: admin.token });
  assert.equal(list.data.batches[0].name, 'Wholesale – Buyer X – Oct');

  // Non-admins can't see batches, their packing lists, or filter the list by batch.
  assert.equal((await client.get('/api/assets/batches', { token: staff.token })).status, 403);
  assert.equal((await client.get(`/api/assets/batches/${bid}`, { token: staff.token })).status, 403);
  assert.equal((await fetch(`${base}/api/assets/batches/${bid}/pdf`, { headers: { Authorization: `Bearer ${staff.token}` } })).status, 403);
  assert.deepEqual(ids(await client.get(`/api/assets?batch=${bid}`, { token: staff.token })), ids(await client.get('/api/assets', { token: staff.token })), 'the batch filter is ignored for non-admins');

  const pdf = await fetch(`${base}/api/assets/batches/${bid}/pdf`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  assert.equal((await client.patch(`/api/assets/batches/${bid}`, { token: admin.token, body: { name: 'Renamed' } })).data.batch.name, 'Renamed');
  assert.equal((await client.delete(`/api/assets/batches/${bid}`, { token: admin.token })).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM assets WHERE id = 'a2'").get(), 'deleting a batch leaves the assets alone');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM asset_batch_items').get().c, 0);
});

test('month filter: assets created in a Sydney month, with month options and counts', async () => {
  const addAt = (id, at) => db.prepare('INSERT INTO assets (id, fields_json, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify({ asset_tag: id }), at);
  addAt('m1', '2025-03-31 12:59:59'); // 31 Mar 11:59pm Sydney (daylight saving, +11)
  addAt('m2', '2025-03-31 13:00:00'); // 1 Apr 12:00am Sydney
  addAt('m3', '2025-04-15 02:00:00'); // 15 Apr Sydney
  addAt('m4', '2025-06-30 14:00:00'); // 1 Jul 12:00am Sydney (standard time, +10)
  assert.deepEqual(ids(await client.get('/api/assets?month=2025-03', { token: staff.token })), ['m1']);
  assert.deepEqual(ids(await client.get('/api/assets?month=2025-04', { token: staff.token })), ['m2', 'm3']);
  assert.deepEqual(ids(await client.get('/api/assets?month=2025-07', { token: staff.token })), ['m4']);
  assert.deepEqual((await client.get('/api/assets/all-ids?month=2025-04', { token: staff.token })).data.ids.sort(), ['m2', 'm3']);
  const opts = (await client.get('/api/assets/filter-options', { token: staff.token })).data.month;
  assert.deepEqual(opts.filter((o) => o.value.startsWith('2025')), [{ value: '2025-07', count: 1 }, { value: '2025-04', count: 2 }, { value: '2025-03', count: 1 }]);
  assert.ok(opts.every((o, i) => i === 0 || opts[i - 1].value > o.value), 'newest month first');
  assert.ok((await client.get('/api/assets?month=nonsense', { token: staff.token })).data.assets.length > 4, 'a bad month is ignored');
});

test('month update: every asset from a month gets the new Status and Sent to (admins only)', async () => {
  const { ids: monthIds } = (await client.get('/api/assets/all-ids?month=2025-04', { token: admin.token })).data;
  assert.deepEqual(monthIds.sort(), ['m2', 'm3']);
  assert.equal((await client.patch('/api/assets/bulk-edit', { token: staff.token, body: { ids: monthIds, updates: { status: 'Sold' } } })).status, 403);
  const r = await client.patch('/api/assets/bulk-edit', { token: admin.token, body: { ids: monthIds, updates: { status: 'Sold', asset_sent_to: 'Wholesale' } } });
  assert.equal(r.data.updated, 2);
  const f = (id) => JSON.parse(db.prepare('SELECT fields_json FROM assets WHERE id = ?').get(id).fields_json);
  assert.equal(f('m2').status, 'Sold'); assert.equal(f('m3').asset_sent_to, 'Wholesale');
  assert.equal(f('m1').status, undefined, 'other months are left alone');
  assert.deepEqual(ids(await client.get('/api/assets?month=2025-04&status=Sold&sent_to=Wholesale', { token: admin.token })), ['m2', 'm3']);
});

test('Asset Location is a drop-down (ITF Sydney / ITF Melbourne) right after Audit Month', async () => {
  const { fields } = (await client.get('/api/assets/field-defs', { token: staff.token })).data;
  const keys = fields.map((f) => f.field_key);
  assert.equal(keys.indexOf('asset_location'), keys.indexOf('audit_month') + 1);
  const loc = fields.find((f) => f.field_key === 'asset_location');
  assert.equal(loc.label, 'Asset Location');
  assert.equal(loc.type, 'dropdown');
  assert.deepEqual(loc.options, ['ITF Sydney', 'ITF Melbourne']);
  assert.equal(new Set(fields.map((f) => f.sort_order)).size, fields.length, 'no two fields share a position');
});

test('a new asset gets this month as its Audit Month unless one is given', async () => {
  const now = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', month: 'long', year: 'numeric' }).format(new Date());
  const a = await client.post('/api/assets', { token: staff.token, body: { fields: { asset_tag: 'AM1', serial_number: 'AM-SER-1' } } });
  assert.equal(a.status, 201);
  assert.equal(a.data.asset.fields.audit_month, now);
  assert.match(now, /^[A-Z][a-z]+ \d{4}$/);
  const b = await client.post('/api/assets', { token: staff.token, body: { fields: { asset_tag: 'AM2', serial_number: 'AM-SER-2', audit_month: 'September 2026' } } });
  assert.equal(b.data.asset.fields.audit_month, 'September 2026');
});

test('Zoho Ticket Number is now called ITF Workdesk Job Number', async () => {
  const { fields } = (await client.get('/api/assets/field-defs', { token: staff.token })).data;
  assert.equal(fields.find((f) => f.field_key === 'zoho_ticket_number').label, 'ITF Workdesk Job Number');
});

test('Location filter: ITF Sydney / ITF Melbourne, with the options listed', async () => {
  add('loc1', { asset_tag: 'L1', asset_location: 'ITF Sydney' });
  add('loc2', { asset_tag: 'L2', asset_location: 'ITF Melbourne' });
  add('loc3', { asset_tag: 'L3', asset_location: 'itf sydney ' });
  assert.deepEqual(ids(await client.get('/api/assets?location=ITF Sydney', { token: staff.token })), ['loc1', 'loc3']);
  assert.deepEqual(ids(await client.get('/api/assets?location=ITF Melbourne', { token: staff.token })), ['loc2']);
  const opts = (await client.get('/api/assets/filter-options', { token: staff.token })).data.location;
  assert.ok(opts.includes('ITF Sydney') && opts.includes('ITF Melbourne'));
});

test('Asset Tag fills in with the next number, starting at ITF52816', async () => {
  const next = async () => (await client.get('/api/assets/next-tag', { token: staff.token })).data.tag;
  assert.equal(await next(), 'ITF52816', 'starts at ITF52816 (older ITF5280x tags and other tags are below it)');
  add('tag1', { asset_tag: 'ITF52806' });
  assert.equal(await next(), 'ITF52816');
  const first = await client.post('/api/assets', { token: staff.token, body: { fields: { asset_tag: 'ITF52816', serial_number: 'TAG-1' }, autoTag: true } });
  assert.equal(first.data.asset.fields.asset_tag, 'ITF52816');
  assert.equal(await next(), 'ITF52817');
  // Two people opened the form at once: the second save gets the next free number.
  const second = await client.post('/api/assets', { token: staff.token, body: { fields: { asset_tag: 'itf52816 ', serial_number: 'TAG-2' }, autoTag: true } });
  assert.equal(second.data.asset.fields.asset_tag, 'ITF52817');
  // A tag typed by hand is kept as typed.
  const typed = await client.post('/api/assets', { token: staff.token, body: { fields: { asset_tag: 'ITF52816', serial_number: 'TAG-3' } } });
  assert.equal(typed.data.asset.fields.asset_tag, 'ITF52816');
  add('tag2', { asset_tag: 'ITF52900' });
  add('tag3', { asset_tag: 'ITF5299X' });
  assert.equal(await next(), 'ITF52901');
});

test('Model Name / Model Number / Customer drop-down lists, with + Add', async () => {
  add('vl1', { manufacturer: 'Dell', model_name: 'Latitude', model_number: '5490' });
  add('vl2', { manufacturer: 'dell ', model_name: 'Latitude', model_number: '5490' });
  add('vl3', { manufacturer: 'Dell', model_name: 'latitude', model_number: '7400' });
  add('vl4', { manufacturer: 'HP', model_name: 'EliteBook', model_number: '840 G5', customer: 'Zeta Corp' });
  add('vl5', { customer: 'Zeta Corp' });
  add('vl6', { customer: 'zeta  corp ' });
  const list = async (qs) => (await client.get(`/api/assets/value-options?${qs}`, { token: staff.token })).data.values;

  const names = await list('field=model_name&manufacturer=DELL');
  const lat = names.find((v) => v.value.toLowerCase() === 'latitude');
  assert.equal(lat.value, 'Latitude', 'most used spelling');
  assert.equal(lat.count, 3);
  assert.equal(lat.match, true);
  assert.equal(names.find((v) => v.value === 'EliteBook').match, false, 'other makes still listed, just not first');

  const nums = await list('field=model_number&manufacturer=Dell&model_name=Latitude');
  assert.deepEqual(nums.filter((v) => v.match).map((v) => v.value), ['5490', '7400']);
  const zeta = (await list('field=customer')).find((v) => v.value.toLowerCase() === 'zeta corp');
  assert.deepEqual([zeta.value, zeta.count], ['Zeta Corp', 3], 'spellings differing in capitals/spaces are one customer');
  assert.equal((await client.get('/api/assets/value-options?field=serial_number', { token: staff.token })).status, 400);

  // + Add a new model number for Dell Latitude: listed (first for Dell Latitude) before any asset uses it.
  const made = await client.post('/api/assets/value-options', { token: staff.token, body: { field: 'model_number', value: ' 5420 ', manufacturer: 'Dell', modelName: 'Latitude' } });
  assert.equal(made.status, 201);
  assert.equal(made.data.value, '5420');
  const after = await list('field=model_number&manufacturer=Dell&model_name=Latitude');
  assert.equal(after.find((v) => v.value === '5420').match, true);
  assert.equal((await list('field=model_number&manufacturer=HP')).find((v) => v.value === '5420').match, false);
  // Adding one that's already there gives back the existing spelling, once.
  const again = await client.post('/api/assets/value-options', { token: staff.token, body: { field: 'customer', value: 'ZETA corp' } });
  assert.equal(again.data.value, 'Zeta Corp', 'the most used spelling already on file, not the one typed');
  assert.equal(again.data.existed, true);
  assert.equal((await list('field=customer')).filter((v) => v.value.toLowerCase() === 'zeta corp').length, 1);
  assert.equal((await client.post('/api/assets/value-options', { token: staff.token, body: { field: 'customer', value: '  ' } })).status, 400);
});

test('a new asset cannot be saved until every required field is filled in', async () => {
  db.prepare('UPDATE asset_field_defs SET required = 1').run();
  try {
    const defs = (await client.get('/api/assets/field-defs', { token: staff.token })).data.fields;
    assert.ok(defs.every((f) => f.required === true), 'every field starts required');

    const bare = await client.post('/api/assets', { token: staff.token, body: { fields: { asset_tag: 'RQ1', serial_number: 'RQ-SER-1' } } });
    assert.equal(bare.status, 400);
    assert.equal(bare.data.code, 'missing_fields');
    assert.ok(bare.data.missing.includes('category'));
    assert.ok(!bare.data.missing.includes('asset_tag'));
    assert.ok(!bare.data.missing.includes('audit_month'), 'Audit Month fills itself');
    assert.match(bare.data.error, /^Please fill in: /);

    // Fill everything (a pick-several field needs at least one ticked; blank spaces don't count).
    const full = {};
    defs.forEach((f) => { full[f.field_key] = f.type === 'multiselect' ? [f.options?.[0] || 'Ok'] : f.type === 'dropdown' ? (f.options?.[0] || 'x') : 'x'; });
    full.serial_number = 'RQ-SER-2';
    const k = defs.find((f) => f.type === 'multiselect').field_key;
    const noTick = await client.post('/api/assets', { token: staff.token, body: { fields: { ...full, [k]: [] } } });
    assert.deepEqual(noTick.data.missing, [k]);
    const spaces = await client.post('/api/assets', { token: staff.token, body: { fields: { ...full, comments: '   ' } } });
    assert.deepEqual(spaces.data.missing, ['comments']);
    assert.equal((await client.post('/api/assets', { token: staff.token, body: { fields: full } })).status, 201);

    // An admin can make a field optional on Manage Fields; staff can't.
    const buyer = defs.find((f) => f.field_key === 'buyer');
    assert.equal((await client.patch(`/api/assets/field-defs/${buyer.id}`, { token: staff.token, body: { required: false } })).status, 403);
    const off = await client.patch(`/api/assets/field-defs/${buyer.id}`, { token: admin.token, body: { required: false } });
    assert.equal(off.data.field.required, false);
    const noBuyer = await client.post('/api/assets', { token: staff.token, body: { fields: { ...full, serial_number: 'RQ-SER-3', buyer: '' } } });
    assert.equal(noBuyer.status, 201);
  } finally {
    db.prepare('UPDATE asset_field_defs SET required = 0').run();
  }
});

test('picking a model number brings the Category, Manufacturer and Model Name it is usually saved with', async () => {
  add('mf1', { category: 'Desktop', manufacturer: 'Dell', model_name: 'Optiplex', model_number: '7050 SFF' });
  add('mf2', { category: 'Desktop', manufacturer: 'Dell', model_name: 'Optiplex', model_number: '7050 sff ' });
  add('mf3', { category: 'Laptop', manufacturer: 'Dell', model_name: 'Optiplx', model_number: '7050 SFF' });
  add('mf4', { category: 'Laptop', manufacturer: 'HP', model_name: 'EliteBook', model_number: 'G9' });
  add('mf5', { category: 'Desktop', manufacturer: 'Lenovo', model_name: 'ThinkCentre', model_number: 'G9' });
  add('mf6', { category: 'Laptop', manufacturer: 'HP', model_name: 'EliteBook', model_number: 'G9' });
  const list = async (qs) => (await client.get(`/api/assets/value-options?field=model_number${qs}`, { token: staff.token })).data.values;
  const find = (vs, v) => vs.find((x) => x.value.toLowerCase() === v.toLowerCase());

  assert.deepEqual(find(await list(''), '7050 SFF').fill, { category: 'Desktop', manufacturer: 'Dell', model_name: 'Optiplex' }, 'most used combination');
  assert.deepEqual(find(await list(''), 'G9').fill, { category: 'Laptop', manufacturer: 'HP', model_name: 'EliteBook' });
  // A Manufacturer already chosen wins: the same number under Lenovo fills Lenovo's details.
  assert.deepEqual(find(await list('&manufacturer=lenovo'), 'G9').fill, { category: 'Desktop', manufacturer: 'Lenovo', model_name: 'ThinkCentre' });

  // A number added by hand fills the make/model it was added under.
  await client.post('/api/assets/value-options', { token: staff.token, body: { field: 'model_number', value: 'NEW-1', manufacturer: 'Dell', modelName: 'Latitude' } });
  assert.deepEqual(find(await list(''), 'NEW-1').fill, { manufacturer: 'Dell', model_name: 'Latitude' });
  // Other lists don't carry fill-ins.
  const names = (await client.get('/api/assets/value-options?field=model_name', { token: staff.token })).data.values;
  assert.equal(names[0].fill, undefined);
});

test('Model Number sits where Category was (straight after Asset Tag), and Category where Model Number was', async () => {
  const keys = (await client.get('/api/assets/field-defs', { token: staff.token })).data.fields.map((f) => f.field_key);
  assert.deepEqual(keys.slice(0, 5), ['asset_tag', 'model_number', 'manufacturer', 'model_name', 'category']);
});

test('N/A or NA as the serial (any capitals) is never a duplicate', async () => {
  add('na1', { asset_tag: 'NA1', serial_number: 'N/A' });
  add('na2', { asset_tag: 'NA2', serial_number: 'n/a' });
  add('na3', { asset_tag: 'NA3', serial_number: 'NA' });
  add('na4', { asset_tag: 'NA4', serial_number: ' na ' });
  for (const serial of ['N/A', 'n/a', 'NA', 'na', 'Na ']) {
    const r = await client.post('/api/assets', { token: staff.token, body: { fields: { asset_tag: `NA-${serial.trim()}`, serial_number: serial } } });
    assert.equal(r.status, 201, `${serial} saves without a duplicate warning`);
  }
  const dupes = (await client.get('/api/assets?dupes=1&limit=500', { token: staff.token })).data.assets;
  assert.ok(!dupes.some((a) => ['N/A', 'NA'].includes(String(a.fields.serial_number).trim().toUpperCase())), 'not in "Duplicate serials only"');
  // Editing one of them doesn't warn either.
  assert.equal((await client.patch('/api/assets/na1', { token: staff.token, body: { fields: { asset_tag: 'NA1', serial_number: 'NA' } } })).status, 200);
  // A real serial still warns.
  assert.equal((await client.post('/api/assets', { token: staff.token, body: { fields: { serial_number: 'SER-1' } } })).data.code, 'duplicate_serial');
  // Bulk serial search doesn't list it as a duplicate.
  const found = (await client.post('/api/assets/serial-search', { token: staff.token, body: { serials: 'N/A' } })).data;
  assert.deepEqual(found.duplicates, []);
});

test('the Status option "Store" becomes "In Storage", on the list and on assets', () => {
  const def = db.prepare("SELECT id, options_json FROM asset_field_defs WHERE field_key = 'status'").get();
  const before = def.options_json;
  db.prepare('UPDATE asset_field_defs SET options_json = ? WHERE id = ?').run(JSON.stringify(['Available', 'Store', 'Sold']), def.id);
  add('st1', { asset_tag: 'ST1', status: 'Store' });
  add('st2', { asset_tag: 'ST2', status: ' store ' });
  add('st3', { asset_tag: 'ST3', status: 'Sold' });
  // Re-run the start-up step.
  delete require.cache[require.resolve('../db')];
  const fresh = require('../db').db;
  assert.deepEqual(JSON.parse(fresh.prepare("SELECT options_json FROM asset_field_defs WHERE field_key = 'status'").get().options_json), ['Available', 'In Storage', 'Sold']);
  const status = (id) => JSON.parse(fresh.prepare('SELECT fields_json FROM assets WHERE id = ?').get(id).fields_json).status;
  assert.equal(status('st1'), 'In Storage');
  assert.equal(status('st2'), 'In Storage');
  assert.equal(status('st3'), 'Sold');
  db.prepare('UPDATE asset_field_defs SET options_json = ? WHERE id = ?').run(before, def.id);
});

test('period report: assets added between two Sydney dates, broken down', async () => {
  const at = (id, f, utc) => db.prepare('INSERT INTO assets (id, fields_json, created_at, created_by) VALUES (?, ?, ?, ?)').run(id, JSON.stringify(f), utc, staff.id);
  // Sydney is UTC+10 until daylight saving starts on 4 Oct 2026, then UTC+11.
  at('pr1', { category: 'Laptop', customer: 'Acme', asset_sent_to: 'Wholesale', status: 'Sold', buyer: 'Bob', asset_location: 'ITF Sydney' }, '2026-09-30 14:30:00'); // 1 Oct 00:30 Sydney
  at('pr2', { category: 'laptop ', customer: 'ACME', asset_sent_to: 'ITF Australia', status: 'Available', asset_location: 'ITF Melbourne' }, '2026-10-15 02:00:00');
  at('pr3', { category: 'Monitor', customer: 'Beta', status: 'Sold', buyer: 'bob', _imported_creator_name: 'Ian' }, '2026-10-31 12:59:00'); // 31 Oct 23:59 Sydney
  at('pr4', { category: 'Laptop', customer: 'Acme' }, '2026-10-31 13:00:00'); // 1 Nov 00:00 Sydney — outside
  at('pr5', { category: 'Laptop', customer: 'Acme' }, '2026-09-30 13:59:00'); // 30 Sep 23:59 Sydney — outside

  const r = (await client.get('/api/assets/period-report?from=2026-10-01&to=2026-10-31', { token: admin.token })).data;
  assert.equal(r.total, 3);
  assert.equal(r.sold, 2);
  assert.deepEqual(r.byClass, [{ label: 'Laptop', count: 2 }, { label: 'Monitor', count: 1 }]);
  assert.deepEqual(r.byCustomer.map((x) => x.count), [2, 1]);
  assert.deepEqual(r.bySentTo, [{ label: 'ITF Australia', count: 1 }, { label: 'Not set', count: 1 }, { label: 'Wholesale', count: 1 }]);
  assert.deepEqual(r.byLocation.find((x) => x.label === 'ITF Sydney'), { label: 'ITF Sydney', count: 1 });
  assert.deepEqual(r.byStatus, [{ label: 'Sold', count: 2 }, { label: 'Available', count: 1 }]);
  assert.deepEqual(r.soldByBuyer.map((x) => x.count), [2], 'Bob and bob are one buyer');
  assert.deepEqual(r.soldByCustomer.map((x) => x.label).sort(), ['Acme', 'Beta']);
  assert.deepEqual(r.byTechnician.map((x) => [x.label, x.count]), [['Staff Person', 2], ['Ian', 1]]);

  // One day.
  assert.equal((await client.get('/api/assets/period-report?from=2026-11-01&to=2026-11-01', { token: admin.token })).data.total >= 1, true);
  // Admins only, and the dates must make sense.
  assert.equal((await client.get('/api/assets/period-report?from=2026-10-01&to=2026-10-31', { token: staff.token })).status, 403);
  assert.equal((await client.get('/api/assets/period-report?from=2026-10-31&to=2026-10-01', { token: admin.token })).status, 400);
  assert.equal((await client.get('/api/assets/period-report?from=2026-02-30&to=2026-03-01', { token: admin.token })).status, 400);
});

test('Buyer filter, with the buyers listed and counted', async () => {
  add('by1', { asset_tag: 'BY1', buyer: 'Bob Reseller', status: 'Sold' });
  add('by2', { asset_tag: 'BY2', buyer: 'bob  reseller ', status: 'Sold' });
  add('by3', { asset_tag: 'BY3', buyer: 'Zed Traders', status: 'Sold' });
  const opts = (await client.get('/api/assets/filter-options', { token: staff.token })).data.buyer;
  const bob = opts.find((o) => o.value.toLowerCase() === 'bob reseller');
  assert.equal(bob.count >= 2, true);
  assert.equal(opts.filter((o) => o.value.toLowerCase().replace(/\s+/g, ' ').trim() === 'bob reseller').length, 1, 'one entry per buyer');
  const ids = (await client.get('/api/assets?buyer=BOB RESELLER&limit=500', { token: staff.token })).data.assets.map((a) => a.id);
  assert.ok(ids.includes('by1') && ids.includes('by2') && !ids.includes('by3'));
});
