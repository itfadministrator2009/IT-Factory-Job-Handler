// Disk space warning: the Super Admin is emailed at 90% full, reminded daily, reset below 90%.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

let db, sent, checkDiskSpace;
const GB = 1024 ** 3;
const space = (pct) => ({ total: 100 * GB, used: pct * GB, free: (100 - pct) * GB });

before(() => {
  ({ db } = freshDb());
  sent = [];
  require('../email').sendMail = async (m) => { sent.push(m); };
  ({ checkDiskSpace } = require('../diskAlert'));
  const add = db.prepare("INSERT INTO users (id, name, email, password_hash, role, super_admin) VALUES (?, ?, ?, 'x', ?, ?)");
  add.run('u1', 'Robert Nahas', 'RNahas@itfactory.com.au', 'admin', 1);
  add.run('u2', 'Ana Admin', 'ana@itf.test', 'admin', 0);
});

test('under 90%: no email', async () => {
  const r = await checkDiskSpace({ space: space(89.9) });
  assert.equal(r.status, 'ok');
  assert.equal(sent.length, 0);
});

test('at 90%: only the Super Admin is emailed, then reminded once a day', async () => {
  const t0 = Date.UTC(2026, 9, 25, 0, 0);
  let r = await checkDiskSpace({ space: space(91), now: t0 });
  assert.equal(r.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'rnahas@itfactory.com.au');
  assert.match(sent[0].subject, /91% full/);
  assert.match(sent[0].text, /Free: 9\.00 GB/);

  // An hour later, still full: held back.
  r = await checkDiskSpace({ space: space(92), now: t0 + 60 * 60 * 1000 });
  assert.equal(r.status, 'held');
  assert.equal(sent.length, 1);

  // A day later: reminded.
  r = await checkDiskSpace({ space: space(93), now: t0 + 24 * 60 * 60 * 1000 });
  assert.equal(r.status, 'sent');
  assert.equal(sent.length, 2);

  // Logged in the activity log.
  const log = db.prepare("SELECT details FROM activity_log WHERE action = 'settings.disk_alert'").all();
  assert.equal(log.length, 2);
});

test('dropping below 90% resets it, so filling up again emails straight away', async () => {
  const t = Date.UTC(2026, 9, 26, 6, 0);
  await checkDiskSpace({ space: space(80), now: t });
  const r = await checkDiskSpace({ space: space(90), now: t + 60 * 1000 });
  assert.equal(r.status, 'sent');
  assert.equal(sent.length, 3);
});

test('sent even when error alerts are switched off', async () => {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('alerts_enabled', 'off') ON CONFLICT(key) DO UPDATE SET value = 'off'").run();
  await checkDiskSpace({ space: space(50) });
  const r = await checkDiskSpace({ space: space(95) });
  assert.equal(r.status, 'sent');
});
