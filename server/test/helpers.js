// Shared setup for the automated test suite. Builds a real Express app wired up
// exactly like production (same routes, same db.js, same auth middleware) but
// pointed at a throwaway SQLite file, with the Microsoft Graph calendar/email
// dependency swapped for a fake so tests never make real network calls or send
// real email.
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DB_PATH = path.join(os.tmpdir(), `worksdesk-test-${process.pid}.db`);
const TEST_UPLOAD_DIR = path.join(os.tmpdir(), `worksdesk-test-uploads-${process.pid}`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;
process.env.JWT_SECRET = 'test-secret';

// calendar.js is required by email.js and backup.js — faking it here means every
// test run is fully offline, with no real Microsoft Graph calls possible. This
// needs to be re-applied every time freshDb() clears the require cache below, since
// that clear would otherwise wipe this override out too.
function fakeCalendarModule() {
  const calendarPath = require.resolve('../calendar.js');
  require.cache[calendarPath] = {
    id: calendarPath,
    filename: calendarPath,
    loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      configured: false,
      detectState: () => null,
    },
  };
}

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

function freshDb() {
  // Several modules (permissions.js, email.js, projectPdfBuilder.js, etc.) each do
  // their own `require('../db')` at load time and hold onto that reference — if only
  // db.js itself were cleared here, those modules would keep pointing at the OLD,
  // now-deleted database connection from a previous test. Clearing every
  // project-local module (anything outside node_modules) guarantees everything gets
  // a fresh reference to the new database together.
  const serverDir = path.join(__dirname, '..');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(serverDir) && !key.includes(`${path.sep}node_modules${path.sep}`)) {
      delete require.cache[key];
    }
  }
  try { fs.unlinkSync(TEST_DB_PATH); } catch (e) { /* fine if absent */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch (e) { /* fine if absent */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch (e) { /* fine if absent */ }
  if (fs.existsSync(TEST_UPLOAD_DIR)) fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
  fakeCalendarModule();
  return require('../db');
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/projects', require('../routes/projects'));
  return app;
}

// Minimal HTTP client for the test app — starts it on an ephemeral port and gives
// back simple get/post/patch/delete helpers, so tests read like real API calls.
function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;
      async function call(method, urlPath, { token, body } = {}) {
        const res = await fetch(base + urlPath, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let data = null;
        try { data = await res.json(); } catch (e) { /* no body */ }
        return { status: res.status, data };
      }
      resolve({
        server,
        get: (p, opts) => call('GET', p, opts),
        post: (p, opts) => call('POST', p, opts),
        patch: (p, opts) => call('PATCH', p, opts),
        delete: (p, opts) => call('DELETE', p, opts),
      });
    });
  });
}

async function registerUser(client, { name, email, password = 'password123' }) {
  const { data } = await client.post('/api/auth/register', { body: { name, email, password } });
  return { token: data.token, id: data.user.id, name: data.user.name, role: data.user.role };
}

const HARVEY_NORMAN_TEMPLATE = {
  sections: [
    {
      id: 'site_info',
      title: 'Site Info',
      repeatable: false,
      fields: [
        { id: 'install_job', type: 'text', label: 'Install Job', required: true },
        { id: 'site_location', type: 'text', label: 'Site Location', required: true },
      ],
    },
    {
      id: 'printer_install',
      title: 'Install',
      repeatable: true,
      fields: [
        { id: 'department', type: 'text', label: 'Department', required: true },
        { id: 'old_config_notes', type: 'textarea', label: 'Old config notes' },
        { id: 'old_config_photo', type: 'photo', label: 'Old config photo', requiredIf: { field: 'old_config_notes', empty: true } },
      ],
    },
    {
      id: 'sign_off',
      title: 'Sign Off',
      repeatable: false,
      fields: [
        { id: 'site_signature', type: 'signature', label: 'Site Contact Signature' },
        { id: 'site_contact_satisfied', type: 'yesno', label: 'Site Contact satisfied?', visibleIf: { field: 'site_signature', notEmpty: true }, requiredIf: { field: 'site_signature', notEmpty: true } },
      ],
    },
  ],
};

module.exports = { freshDb, buildApp, startTestServer, registerUser, HARVEY_NORMAN_TEMPLATE, TEST_UPLOAD_DIR };
