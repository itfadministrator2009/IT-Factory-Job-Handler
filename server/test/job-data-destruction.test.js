// Jobs: Classification and Data Destruction are saved (a set choice or custom text).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin;

before(async () => {
  ({ db } = freshDb());
  // No real calendar or email from tests.
  const cal = require.cache[require.resolve('../calendar')];
  cal.exports = { ...cal.exports, createCalendarEvent: async () => null, syncCalendarEvent: async () => null, deleteCalendarEvent: async () => null };
  const mail = require('../email');
  const quiet = async () => {};
  require.cache[require.resolve('../email')].exports = { ...mail, notifyNewReply: quiet, notifyStatusChange: quiet, notifyTicketCreated: quiet, notifyJobComplete: quiet, notifyJobClosed: quiet, notifyJobAssigned: quiet };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/jobs', require('../routes/jobs'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
});

after(() => server.close());

test('a job saves its classification and data destruction method', async () => {
  const made = await client.post('/api/jobs', {
    token: admin.token,
    body: { contact_name: 'Pat', subject: 'Laptop pickup', classifications: 'Collection of IT Equipment', data_destruction: 'Blancco' },
  });
  assert.equal(made.status, 201);
  assert.equal(made.data.job.classifications, 'Collection of IT Equipment');
  assert.equal(made.data.job.data_destruction, 'Blancco');

  // Custom text, then cleared.
  const id = made.data.job.id;
  const custom = await client.patch(`/api/jobs/${id}`, { token: admin.token, body: { data_destruction: 'Degauss + shred' } });
  assert.equal(custom.status, 200);
  assert.equal(db.prepare('SELECT data_destruction FROM jobs WHERE id = ?').get(id).data_destruction, 'Degauss + shred');
  await client.patch(`/api/jobs/${id}`, { token: admin.token, body: { data_destruction: '' } });
  assert.equal(db.prepare('SELECT data_destruction FROM jobs WHERE id = ?').get(id).data_destruction, null);
});
