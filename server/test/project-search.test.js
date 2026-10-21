// Projects: searching a project's entries looks through every field on the form,
// not just the site name, and techs still only see their own entries.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, buildApp, startTestServer, registerUser, HARVEY_NORMAN_TEMPLATE } = require('./helpers');

let client, admin, tech, project;

before(async () => {
  const { db } = freshDb();
  client = await startTestServer(buildApp());
  admin = await registerUser(client, { name: 'Admin', email: 'admin@co.com' });
  tech = await registerUser(client, { name: 'Tina Tech', email: 'tech@co.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(tech.id);
  ({ data: { project } } = await client.post('/api/projects', {
    token: admin.token, body: { name: 'Harvey Norman', template: HARVEY_NORMAN_TEMPLATE },
  }));
  const add = async (site, answers, assigned) => {
    const { data } = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: { site_name: site, assigned_to: assigned || null } });
    await client.patch(`/api/projects/${project.id}/entries/${data.entry.id}`, { token: admin.token, body: { answers } });
    return data.entry;
  };
  await add('Penrith', {
    site_info: { install_job: 'HN-1001', site_location: 'Mulgoa Rd' },
    printer_install: [{ department: 'Computers', old_config_notes: 'Old Ricoh serial E334M' }, { department: 'Bedding' }],
    sign_off: { site_signature: 'data:image/png;base64,PENRITHSIG', site_contact_satisfied: true },
  }, tech.id);
  await add('Auburn', { site_info: { install_job: 'HN-1002', site_location: 'Parramatta Rd' }, printer_install: [{ department: 'Whitegoods' }] });
  await add('Moore Park', { site_info: { install_job: 'HN-1003', site_location: 'Bourke St' } });
});

after(() => client.server.close());

const search = (token, q) => client.get(`/api/projects/${project.id}/entries?q=${encodeURIComponent(q)}`, { token });

test('finds entries by answers inside the form, and says which field matched', async () => {
  const res = await search(admin.token, 'e334m');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.entries.map((e) => e.site_name), ['Penrith']);
  assert.equal(res.data.total, 1);
  assert.equal(res.data.entries[0].match.label, 'Old config notes (Install 1)');

  const dept = await search(admin.token, 'whitegoods');
  assert.deepEqual(dept.data.entries.map((e) => e.site_name), ['Auburn']);
});

test('site name, entry number, assignee and several words all work', async () => {
  assert.deepEqual((await search(admin.token, 'moore')).data.entries.map((e) => e.site_name), ['Moore Park']);
  assert.deepEqual((await search(admin.token, 'tina')).data.entries.map((e) => e.site_name), ['Penrith']);
  assert.equal((await search(admin.token, 'HN-100')).data.total, 3);
  assert.deepEqual((await search(admin.token, 'HN rd parramatta')).data.entries.map((e) => e.site_name), ['Auburn']);
  assert.equal((await search(admin.token, 'nothing-like-this')).data.total, 0);
});

test('signature images are not searched', async () => {
  assert.equal((await search(admin.token, 'PENRITHSIG')).data.total, 0);
});

test('a tech only finds entries assigned to them', async () => {
  assert.deepEqual((await search(tech.token, 'HN')).data.entries.map((e) => e.site_name), ['Penrith']);
});

test('no search returns the normal paged list', async () => {
  const res = await client.get(`/api/projects/${project.id}/entries`, { token: admin.token });
  assert.equal(res.data.total, 3);
  assert.equal(res.data.entries[0].match, undefined);
});
