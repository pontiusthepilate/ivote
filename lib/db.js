const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { REFERENCE, REPORTS } = require('./schema');
const { shape, km } = require('./geo');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'ivote.sqlite');

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Run: npm run build-db`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
const q = (sql) => db.prepare(sql);
db.exec(REPORTS);
// Databases created before cloud storage lack media.store.
if (!q("SELECT 1 FROM pragma_table_info('media') WHERE name = 'store'").get()) db.exec("ALTER TABLE media ADD COLUMN store TEXT NOT NULL DEFAULT 'local'");
if (!q("SELECT 1 FROM pragma_table_info('incidents') WHERE name = 'problem'").get()) db.exec('ALTER TABLE incidents ADD COLUMN problem INTEGER NOT NULL DEFAULT 1');
// Parties and candidates come from data/sources and are reloaded on every start, so a
// deploy with a new INEC list updates the live database (uploaded photos are kept).
db.exec(REFERENCE);
const t0 = Date.now();
require('../scripts/import-candidates').importCandidates(db);
console.log(`Loaded parties and candidates in ${Date.now() - t0} ms`);


// ---- Location hierarchy --------------------------------------------------
const stmts = {
  states: q('SELECT code, name FROM states ORDER BY name'),
  lgas: q('SELECT id, code, name FROM lgas WHERE state_code = ? ORDER BY name'),
  wards: q('SELECT id, code, name FROM wards WHERE lga_id = ? ORDER BY name'),
  pus: q('SELECT code, name FROM polling_units WHERE ward_id = ? ORDER BY code'),
  pu: q(`SELECT p.code, p.name, p.lat, p.lng, p.geo,
           w.id ward_id, w.name ward, l.id lga_id, l.name lga, s.code state_code, s.name state,
           sd.id sen_id, sd.name sen, c.id rep_id, c.name rep
         FROM polling_units p
         JOIN wards w ON w.id = p.ward_id JOIN lgas l ON l.id = p.lga_id JOIN states s ON s.code = p.state_code
         JOIN senatorial_districts sd ON sd.id = p.sen_id JOIN constituencies c ON c.id = p.rep_id
         WHERE p.code = ?`),
  ward: q(`SELECT w.id ward_id, w.name ward, l.id lga_id, l.name lga, s.code state_code, s.name state
           FROM wards w JOIN lgas l ON l.id = w.lga_id JOIN states s ON s.code = w.state_code WHERE w.id = ?`),
  wardsWithCentre: q('SELECT id, lat, lng FROM wards WHERE lga_id = ? AND lat IS NOT NULL'),
  pusWithPoint: q('SELECT code, lat, lng FROM polling_units WHERE lga_id = ? AND lat IS NOT NULL'),
};

// Accepts 01/02/03/004, 1-2-3-4, "01 02 03 004" or 010203004.
function normalizeCode(raw) {
  const s = String(raw || '').trim();
  let parts = s.split(/[^0-9]+/).filter(Boolean);
  if (parts.length === 1 && parts[0].length === 9) {
    const d = parts[0]; parts = [d.slice(0, 2), d.slice(2, 4), d.slice(4, 6), d.slice(6)];
  }
  if (parts.length !== 4) return null;
  const [a, b, c, d] = parts.map(Number);
  if ([a, b, c, d].some((n) => !Number.isFinite(n))) return null;
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(a, 2)}/${p(b, 2)}/${p(c, 2)}/${p(d, 3)}`;
}

// ---- Locate from GPS -------------------------------------------------------
const lgaShapes = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geo', 'lgas.geojson'), 'utf8')).features.map(shape);

function locate(lat, lng) {
  let lga = lgaShapes.find((s) => s.contains(lng, lat));
  if (!lga) {
    // Just outside a boundary (simplified shapes are coarse): take the closest within 5 km.
    const near = lgaShapes.map((s) => [s, s.bboxKm(lng, lat)]).sort((a, b) => a[1] - b[1])[0];
    if (!near || near[1] > 5) return null;
    lga = near[0];
  }
  const lgaId = lga.props.id;
  // Closest polling unit with a trusted point, if the phone is right at it.
  let best = null;
  for (const p of stmts.pusWithPoint.all(lgaId)) {
    const d = km(lat, lng, p.lat, p.lng);
    if (!best || d < best.d) best = { code: p.code, d };
  }
  if (best && best.d <= 0.35) return { ...stmts.pu.get(best.code), match: 'pu', distance_m: Math.round(best.d * 1000) };
  let ward = null;
  for (const w of stmts.wardsWithCentre.all(lgaId)) {
    const d = km(lat, lng, w.lat, w.lng);
    if (!ward || d < ward.d) ward = { id: w.id, d };
  }
  if (ward) return { ...stmts.ward.get(ward.id), match: 'ward' };
  return { lga_id: lgaId, lga: lga.props.name, state_code: lga.props.state, match: 'lga' };
}

// ---- Collation ----------------------------------------------------------------
const col = {
  candidates: q(`SELECT id, scores_key, status, created_at FROM reports
                 WHERE election = ? AND pu_code = ? AND status IN ('pending','verified')`),
  upsert: q(`INSERT INTO pu_results (election, pu_code, report_id, n_reports, n_versions, agree)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (election, pu_code) DO UPDATE SET
               report_id = excluded.report_id, n_reports = excluded.n_reports,
               n_versions = excluded.n_versions, agree = excluded.agree`),
  remove: q('DELETE FROM pu_results WHERE election = ? AND pu_code = ?'),
};

// Decides which report counts for one polling unit:
// a verified report wins; otherwise the result most reporters agree on (newest breaks ties).
function recollate(election, pu) {
  const rows = col.candidates.all(election, pu);
  if (!rows.length) { col.remove.run(election, pu); return; }
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.scores_key) || { n: 0, latest: r, verified: null };
    g.n++;
    if (r.created_at >= g.latest.created_at) g.latest = r;
    if (r.status === 'verified' && (!g.verified || r.created_at >= g.verified.created_at)) g.verified = r;
    groups.set(r.scores_key, g);
  }
  const list = [...groups.values()];
  const verified = list.filter((g) => g.verified).sort((a, b) => (a.verified.created_at < b.verified.created_at ? 1 : -1))[0];
  const pick = verified || list.sort((a, b) => b.n - a.n || (a.latest.created_at < b.latest.created_at ? 1 : -1))[0];
  col.upsert.run(election, pu, (pick.verified || pick.latest).id, rows.length, groups.size, pick.n);
}

module.exports = { db, q, stmts, normalizeCode, locate, recollate };
