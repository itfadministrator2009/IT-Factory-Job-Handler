// Public sign-up: the very first account can be made from the sign-up page, but
// after that only an admin adds people (unless ALLOW_PUBLIC_SIGNUP=true).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer } = require('./helpers');

let client, server;

before(async () => {
  freshDb();
  delete process.env.ALLOW_PUBLIC_SIGNUP;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  client = await startTestServer(app);
  server = client.server;
});

after(() => { process.env.ALLOW_PUBLIC_SIGNUP = 'true'; server.close(); });

const signUp = (email) => client.post('/api/auth/register', { body: { name: 'Someone', email, password: 'password123' } });

test('the first account can still be created', async () => {
  const res = await signUp('first@example.com');
  assert.equal(res.status, 201);
});

test('later sign-ups are refused with a plain message', async () => {
  const res = await signUp('stranger@example.com');
  assert.equal(res.status, 403);
  assert.equal(res.data.code, 'signup_closed');
  assert.match(res.data.error, /admin/i);
});

test('ALLOW_PUBLIC_SIGNUP=true reopens sign-up', async () => {
  process.env.ALLOW_PUBLIC_SIGNUP = 'true';
  try {
    const res = await signUp('invited@example.com');
    assert.equal(res.status, 201);
  } finally { delete process.env.ALLOW_PUBLIC_SIGNUP; }
});
