// ITF Time Card: the managed list of clients / projects.
//
// Contractors pick from this list, so one client isn't logged under several
// spellings ("Westmead Hospital", "Westmead hospital", "westmead hospital ").
// Names match regardless of capitals or extra spaces. If someone types a name
// that isn't on the list yet it's added, and admins tidy the list in
// ITF Time Card → Projects: rename, merge duplicates, hide old ones.
const { v4: uuid } = require('uuid');
const { db } = require('./db');
const { logActivity } = require('./activity');

class ProjectError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.friendly = true; }
}

// "  westmead   Hospital " → "westmead Hospital"
const tidy = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 200);

// The first time this runs, the list is built from the names already used —
// spellings that differ only in capitals or spaces become one, using whichever
// spelling was used most, and old entries are updated to match.
function ensureSeeded() {
  const done = db.prepare("SELECT value FROM timecard_meta WHERE key = 'projects_seeded'").get();
  if (done) return;
  db.transaction(() => {
    const used = db.prepare(`SELECT client_project AS name, COUNT(*) AS n FROM timecard_entries
      WHERE client_project IS NOT NULL AND TRIM(client_project) != '' GROUP BY client_project`).all();
    const groups = new Map();
    used.forEach(({ name, n }) => {
      const clean = tidy(name);
      const key = clean.toLowerCase();
      if (!groups.has(key)) groups.set(key, { spellings: new Map(), raw: [] });
      const g = groups.get(key);
      g.spellings.set(clean, (g.spellings.get(clean) || 0) + n);
      g.raw.push(name);
    });
    const insert = db.prepare('INSERT OR IGNORE INTO timecard_projects (id, name, created_by) VALUES (?, ?, ?)');
    const fix = db.prepare('UPDATE timecard_entries SET client_project = ? WHERE client_project = ?');
    groups.forEach((g) => {
      // Most-used spelling wins; on a tie, the one with more capitals ("Westmead Hospital").
      const best = [...g.spellings.entries()].sort((a, b) => b[1] - a[1]
        || (b[0].match(/[A-Z]/g) || []).length - (a[0].match(/[A-Z]/g) || []).length)[0][0];
      insert.run(uuid(), best, 'Existing timesheets');
      g.raw.forEach((raw) => { if (raw !== best) fix.run(best, raw); });
    });
    db.prepare("INSERT OR REPLACE INTO timecard_meta (key, value) VALUES ('projects_seeded', ?)").run(new Date().toISOString());
  })();
}

const byName = (name) => db.prepare('SELECT * FROM timecard_projects WHERE name = ? COLLATE NOCASE').get(tidy(name));
const byId = (id) => db.prepare('SELECT * FROM timecard_projects WHERE id = ?').get(String(id));

// The name to store on a time entry: the list's spelling if it's already there,
// otherwise the new name is added to the list.
function canonicalName(name, user) {
  const clean = tidy(name);
  if (!clean) return '';
  ensureSeeded();
  const found = byName(clean);
  if (found) return found.name;
  db.prepare('INSERT INTO timecard_projects (id, name, created_by) VALUES (?, ?, ?)').run(uuid(), clean, user?.name || null);
  logActivity('timecard.project_added', { who: user ? { id: user.id, name: user.name } : null, target: { type: 'project', name: clean }, details: 'Typed in on a timesheet' });
  return clean;
}

// What contractors choose from: every shown project, with the ones this person
// used most recently first.
function choicesFor(userId) {
  ensureSeeded();
  const all = db.prepare('SELECT name FROM timecard_projects WHERE active = 1 ORDER BY name COLLATE NOCASE').all().map((r) => r.name);
  const recent = db.prepare(`SELECT e.client_project AS name, MAX(COALESCE(e.date, e.created_at, '')) AS last
      FROM timecard_entries e JOIN timecard_projects p ON p.name = e.client_project AND p.active = 1
      WHERE e.user_id = ? GROUP BY e.client_project ORDER BY last DESC LIMIT 5`).all(userId).map((r) => r.name);
  return { projects: all, recentProjects: recent };
}

// Admin list, with how much each one has been used.
function listProjects() {
  ensureSeeded();
  return db.prepare(`SELECT p.id, p.name, p.active, p.created_by, p.created_at,
      COUNT(e.id) AS entries, COALESCE(SUM(e.hours), 0) AS hours, COUNT(DISTINCT e.user_id) AS people,
      MAX(e.date) AS lastUsed
    FROM timecard_projects p LEFT JOIN timecard_entries e ON e.client_project = p.name
    GROUP BY p.id ORDER BY p.name COLLATE NOCASE`).all().map((r) => ({
    id: r.id, name: r.name, active: !!r.active, createdBy: r.created_by, createdAt: r.created_at,
    entries: r.entries, hours: Math.round(r.hours * 100) / 100, people: r.people, lastUsed: r.lastUsed || null,
  }));
}

function addProject(name, admin) {
  ensureSeeded();
  const clean = tidy(name);
  if (!clean) throw new ProjectError('Type a client / project name.');
  const existing = byName(clean);
  if (existing) {
    if (!existing.active) throw new ProjectError(`"${existing.name}" is already in the list but hidden — show it instead.`, 409);
    throw new ProjectError(`"${existing.name}" is already in the list.`, 409);
  }
  const id = uuid();
  db.prepare('INSERT INTO timecard_projects (id, name, created_by) VALUES (?, ?, ?)').run(id, clean, admin?.name || null);
  return { id, name: clean };
}

// Rename (or fix the capitals of) a project; every time entry under it follows.
function renameProject(id, newName) {
  const p = byId(id);
  if (!p) throw new ProjectError('Project not found.', 404);
  const clean = tidy(newName);
  if (!clean) throw new ProjectError('Type a name.');
  const clash = byName(clean);
  if (clash && clash.id !== p.id) throw new ProjectError(`"${clash.name}" is already in the list — use Merge to combine them.`, 409);
  let moved = 0;
  db.transaction(() => {
    db.prepare('UPDATE timecard_projects SET name = ? WHERE id = ?').run(clean, p.id);
    moved = db.prepare('UPDATE timecard_entries SET client_project = ? WHERE client_project = ?').run(clean, p.name).changes;
  })();
  return { from: p.name, to: clean, entries: moved };
}

function setActive(id, active) {
  const p = byId(id);
  if (!p) throw new ProjectError('Project not found.', 404);
  db.prepare('UPDATE timecard_projects SET active = ? WHERE id = ?').run(active ? 1 : 0, p.id);
  return { name: p.name, active: !!active };
}

// Merge several projects into one: their time entries move to it and they leave the list.
function mergeProjects(fromIds, intoId) {
  const into = byId(intoId);
  if (!into) throw new ProjectError('Choose the project to keep.', 404);
  const from = [...new Set((fromIds || []).map(String))].filter((id) => id !== into.id).map(byId).filter(Boolean);
  if (!from.length) throw new ProjectError('Choose at least one other project to merge into it.');
  let moved = 0;
  db.transaction(() => {
    from.forEach((p) => {
      moved += db.prepare('UPDATE timecard_entries SET client_project = ? WHERE client_project = ?').run(into.name, p.name).changes;
      db.prepare('DELETE FROM timecard_projects WHERE id = ?').run(p.id);
    });
  })();
  return { into: into.name, merged: from.map((p) => p.name), entries: moved };
}

module.exports = { ProjectError, tidy, ensureSeeded, canonicalName, choicesFor, listProjects, addProject, renameProject, setActive, mergeProjects };
