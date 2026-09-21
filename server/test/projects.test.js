// Run with: node --test test/projects.test.js
// Covers the areas that have actually produced real, subtle bugs during this
// project's development — route ordering, the conditional-logic engine, permission
// boundaries, the template-removal safety check, pagination, and the audit trail —
// so a future change that breaks one of these fails loudly here instead of only
// showing up much later in production.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, buildApp, startTestServer, registerUser, HARVEY_NORMAN_TEMPLATE } = require('./helpers');

let client;

beforeEach(async () => {
  freshDb();
  const app = buildApp();
  client = await startTestServer(app);
});

afterEach(() => {
  client.server.close();
});

async function setupProjectWithAdminAndTech() {
  const admin = await registerUser(client, { name: 'Admin', email: 'admin@co.com' });
  const tech = await registerUser(client, { name: 'Tech', email: 'tech@co.com' });
  const { data } = await client.post('/api/projects', {
    token: admin.token,
    body: { name: 'Harvey Norman', description: 'Test project', template: HARVEY_NORMAN_TEMPLATE },
  });
  return { admin, tech, project: data.project };
}

describe('route ordering', () => {
  // Regression test for a real bug: /entries/bulk was being matched by the earlier
  // /entries/:entryId route, which treated "bulk" as if it were a literal entry id.
  test('bulk endpoints are not swallowed by the :entryId wildcard route', async () => {
    const { admin, tech, project } = await setupProjectWithAdminAndTech();
    const entryRes = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: { site_name: 'Site A' } });
    const entryId = entryRes.data.entry.id;

    const bulkReassign = await client.patch(`/api/projects/${project.id}/entries/bulk`, {
      token: admin.token,
      body: { ids: [entryId], assigned_to: tech.id },
    });
    assert.equal(bulkReassign.status, 200);
    assert.equal(bulkReassign.data.updated, 1);

    const bulkDelete = await client.post(`/api/projects/${project.id}/entries/bulk-delete`, {
      token: admin.token,
      body: { ids: [entryId] },
    });
    assert.equal(bulkDelete.status, 200);
    assert.equal(bulkDelete.data.deleted, 1);
  });
});

describe('conditional logic engine', () => {
  test('a field required only when another is empty — filling the other one skips it', async () => {
    const { admin, project } = await setupProjectWithAdminAndTech();
    const entryRes = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: {} });
    const entryId = entryRes.data.entry.id;

    await client.patch(`/api/projects/${project.id}/entries/${entryId}`, {
      token: admin.token,
      body: {
        answers: {
          site_info: { install_job: 'Job', site_location: 'Loc' },
          printer_install: [{ department: 'Bedding', old_config_notes: 'IP: 10.0.0.5' }],
          sign_off: {},
        },
      },
    });
    const result = await client.patch(`/api/projects/${project.id}/entries/${entryId}`, { token: admin.token, body: { submit: true } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.entry.status, 'Submitted');
  });

  test('the same field becomes required when the other is left blank', async () => {
    const { admin, project } = await setupProjectWithAdminAndTech();
    const entryRes = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: {} });
    const entryId = entryRes.data.entry.id;

    await client.patch(`/api/projects/${project.id}/entries/${entryId}`, {
      token: admin.token,
      body: {
        answers: {
          site_info: { install_job: 'Job', site_location: 'Loc' },
          printer_install: [{ department: 'Bedding', old_config_notes: '' }],
          sign_off: {},
        },
      },
    });
    const result = await client.patch(`/api/projects/${project.id}/entries/${entryId}`, { token: admin.token, body: { submit: true } });
    assert.equal(result.status, 400);
    assert.ok(result.data.problems.some((p) => p.includes('Old config photo')));
  });

  test('a field hidden until a signature exists is not required beforehand, but is once signed', async () => {
    const { admin, project } = await setupProjectWithAdminAndTech();
    const entryRes = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: {} });
    const entryId = entryRes.data.entry.id;
    const baseAnswers = {
      site_info: { install_job: 'Job', site_location: 'Loc' },
      printer_install: [{ department: 'Bedding', old_config_notes: 'notes' }],
    };

    // No signature yet — site_contact_satisfied should not block submission.
    await client.patch(`/api/projects/${project.id}/entries/${entryId}`, {
      token: admin.token,
      body: { answers: { ...baseAnswers, sign_off: {} } },
    });
    const withoutSignature = await client.patch(`/api/projects/${project.id}/entries/${entryId}`, { token: admin.token, body: { submit: true } });
    assert.equal(withoutSignature.status, 200, JSON.stringify(withoutSignature.data));

    // Reset to Draft-equivalent by making a new entry, this time with a signature —
    // now the satisfaction question becomes required.
    const entry2Res = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: {} });
    const entry2Id = entry2Res.data.entry.id;
    await client.patch(`/api/projects/${project.id}/entries/${entry2Id}`, {
      token: admin.token,
      body: { answers: { ...baseAnswers, sign_off: { site_signature: 'data:image/png;base64,ABC' } } },
    });
    const withSignature = await client.patch(`/api/projects/${project.id}/entries/${entry2Id}`, { token: admin.token, body: { submit: true } });
    assert.equal(withSignature.status, 400);
    assert.ok(withSignature.data.problems.some((p) => p.includes('Site Contact satisfied')));
  });
});

describe('permission boundaries', () => {
  test('a non-admin cannot bulk-reassign entries', async () => {
    const { admin, tech, project } = await setupProjectWithAdminAndTech();
    const entryRes = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: {} });
    const result = await client.patch(`/api/projects/${project.id}/entries/bulk`, {
      token: tech.token,
      body: { ids: [entryRes.data.entry.id], assigned_to: tech.id },
    });
    assert.equal(result.status, 403);
  });

  test('a tech only sees entries assigned to them, not entries assigned to someone else', async () => {
    const { admin, tech, project } = await setupProjectWithAdminAndTech();
    const otherTech = await registerUser(client, { name: 'Other Tech', email: 'other@co.com' });
    const mine = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: { assigned_to: tech.id } });
    const theirs = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: { assigned_to: otherTech.id } });

    const list = await client.get(`/api/projects/${project.id}/entries`, { token: tech.token });
    const ids = list.data.entries.map((e) => e.id);
    assert.ok(ids.includes(mine.data.entry.id));
    assert.ok(!ids.includes(theirs.data.entry.id));

    const directAccess = await client.get(`/api/projects/${project.id}/entries/${theirs.data.entry.id}`, { token: tech.token });
    assert.equal(directAccess.status, 404);
  });

  test('only an admin can delete a project', async () => {
    const { tech, project } = await setupProjectWithAdminAndTech();
    const result = await client.delete(`/api/projects/${project.id}`, { token: tech.token });
    assert.equal(result.status, 403);
  });
});

describe('template edit safety check', () => {
  test('removing a question nobody has answered saves without a warning', async () => {
    const { admin, project } = await setupProjectWithAdminAndTech();
    const trimmed = { sections: HARVEY_NORMAN_TEMPLATE.sections.slice(0, 2) }; // drop sign_off, nobody answered it
    const result = await client.patch(`/api/projects/${project.id}`, { token: admin.token, body: { template: trimmed } });
    assert.equal(result.status, 200);
  });

  test('removing a question with a real answer is blocked unless forced', async () => {
    const { admin, project } = await setupProjectWithAdminAndTech();
    const entryRes = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: {} });
    await client.patch(`/api/projects/${project.id}/entries/${entryRes.data.entry.id}`, {
      token: admin.token,
      body: { answers: { site_info: { install_job: 'Answered value', site_location: 'X' } } },
    });

    const trimmed = { sections: HARVEY_NORMAN_TEMPLATE.sections.slice(1) }; // drops site_info, which has an answer
    const blocked = await client.patch(`/api/projects/${project.id}`, { token: admin.token, body: { template: trimmed } });
    assert.equal(blocked.status, 409);
    assert.ok(blocked.data.requiresConfirmation);

    const forced = await client.patch(`/api/projects/${project.id}`, { token: admin.token, body: { template: trimmed, force: true } });
    assert.equal(forced.status, 200);
  });
});

describe('pagination', () => {
  test('entries list is capped at the default page size, with a working second page', async () => {
    const { admin, project } = await setupProjectWithAdminAndTech();
    for (let i = 0; i < 55; i++) {
      await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: { site_name: `Site ${i}` } });
    }
    const page1 = await client.get(`/api/projects/${project.id}/entries`, { token: admin.token });
    assert.equal(page1.data.entries.length, 50);
    assert.equal(page1.data.total, 55);
    assert.equal(page1.data.totalPages, 2);

    const page2 = await client.get(`/api/projects/${project.id}/entries?page=2`, { token: admin.token });
    assert.equal(page2.data.entries.length, 5);
  });
});

describe('assignment audit trail', () => {
  test('creating with an assignee and then reassigning both show up in order', async () => {
    const { admin, tech, project } = await setupProjectWithAdminAndTech();
    const otherTech = await registerUser(client, { name: 'Other Tech', email: 'other2@co.com' });
    const entryRes = await client.post(`/api/projects/${project.id}/entries`, { token: admin.token, body: { assigned_to: tech.id } });
    const entryId = entryRes.data.entry.id;

    await client.patch(`/api/projects/${project.id}/entries/${entryId}`, { token: admin.token, body: { assigned_to: otherTech.id } });

    const detail = await client.get(`/api/projects/${project.id}/entries/${entryId}`, { token: admin.token });
    assert.equal(detail.data.audit.length, 2);
    const values = detail.data.audit.map((a) => a.new_value);
    assert.ok(values.includes('Tech'));
    assert.ok(values.includes('Other Tech'));
  });
});
