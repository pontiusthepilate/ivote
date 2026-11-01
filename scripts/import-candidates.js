// Loads INEC's registered parties and final candidate lists into the database.
// Called by build-db.js; can also be run on its own:  node scripts/import-candidates.js
//
// Sources (data/sources/):
//   parties.csv            code,name,logo        (logos in public/img/parties/)
//   candidates_pres.csv    party,name,running_mate
//   candidates_senate.csv  parsed from INEC's "2027 SENATE FINAL LIST OF CANDIDATES.pdf"
//   candidates_reps.csv    parsed from INEC's "2027 REPS FINAL LIST OF CANDIDATES.pdf"
// The Senate/Reps PDFs mix the district and name columns, so each row's raw text is matched
// against the official district names already in the database.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'sources');

function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const read = (f) => parseCsv(fs.readFileSync(path.join(SRC, f), 'utf8'));

const ROMAN = /^(i|ii|iii|iv|v)$/i;
const title = (s) => s.replace(/\s+/g, ' ').replace(/-\s+/g, '-').trim().toLowerCase()
  .replace(/[a-z0-9’']+/g, (w) => (ROMAN.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const pairs = (s) => { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const p = s.slice(i, i + 2); out.set(p, (out.get(p) || 0) + 1); } return out; };
function dice(a, b) {
  if (a === b) return 1;
  const A = pairs(a), B = pairs(b); let n = 0, sa = 0, sb = 0;
  for (const v of A.values()) sa += v; for (const v of B.values()) sb += v;
  for (const [k, v] of A) n += Math.min(v, B.get(k) || 0);
  return (2 * n) / (sa + sb || 1);
}
const DIRECTIONS = /^(NORTH|SOUTH|EAST|WEST|CENTRAL|NORTH-EAST|NORTH-WEST|SOUTH-EAST|SOUTH-WEST)$/i;
const stateKey = (s) => squash(s).replace('federalcapitalterritory', 'fct').replace('abuja', '');

// Finds which district a row belongs to: the district name that best matches the
// first few words of the row's text. Returns { area, words } or null.
function matchDistrict(tokens, districts) {
  let best = null;
  for (const d of districts) {
    const target = squash(d.name);
    for (let k = 1; k <= Math.min(tokens.length - 1, 8); k++) {
      const score = dice(squash(tokens.slice(0, k).join('')), target);
      if (!best || score > best.score) best = { area: d.id, k, score };
    }
  }
  return best && best.score >= 0.72 ? best : null;
}

function importCandidates(db) {
  db.exec('DELETE FROM candidates; DELETE FROM parties;');
  const insParty = db.prepare('INSERT INTO parties (code, name, logo) VALUES (?, ?, ?)');
  for (const p of read('parties.csv')) insParty.run(p.code, p.name, p.logo || null);
  const parties = new Set(read('parties.csv').map((p) => p.code));

  const states = new Map(db.prepare('SELECT code, name FROM states').all().map((s) => [stateKey(s.name), s.code]));
  const areas = {
    sen: db.prepare('SELECT id, state_code, name FROM senatorial_districts').all(),
    rep: db.prepare('SELECT id, state_code, name FROM constituencies').all(),
  };
  const ins = db.prepare('INSERT OR IGNORE INTO candidates (election, area_id, party, name, running_mate) VALUES (?, ?, ?, ?, ?)');
  const report = {};

  db.exec('BEGIN');
  for (const r of read('candidates_pres.csv')) ins.run('pres', 0, r.party, title(r.name), title(r.running_mate));
  report.pres = { rows: read('candidates_pres.csv').length };

  for (const [election, file] of [['sen', 'candidates_senate.csv'], ['rep', 'candidates_reps.csv']]) {
    const rows = read(file);
    let matched = 0, carried = 0, skipped = 0, dup = 0, prev = null;
    for (const r of rows) {
      const st = states.get(stateKey(r.state));
      if (!st || !parties.has(r.party)) { skipped++; continue; }
      const tokens = r.raw.split(/\s+/).filter(Boolean);
      const districts = areas[election].filter((a) => a.state_code === st);
      let m, name;
      if (election === 'sen') {
        // Senate districts are "<State> <direction>", but the direction often wraps into
        // the middle of the name ("LAGOS WAHAB SOLOMON CENTRAL OLADIMEJI"): pick it out anywhere.
        const stateWords = new Set(r.state.toUpperCase().split(/\s+/));
        const dirs = tokens.filter((t) => DIRECTIONS.test(t));
        const rest = tokens.filter((t, i) => !DIRECTIONS.test(t) && !(stateWords.has(t.toUpperCase()) && i < 3));
        const key = squash(r.state + dirs.join(''));
        const best = districts.map((d) => [d, dice(key, squash(d.name))]).sort((a, b) => b[1] - a[1])[0];
        if (best && (best[1] >= 0.75 || districts.length === 1)) { m = { area: best[0].id }; name = rest.join(' '); matched++; }
      } else if (r.constituency) {
        // Mixed-case pages: the parser already separated the district ("Aba North/ Aba South")
        // from the upper-case name, wherever the district wrapped.
        const best = districts.map((d) => [d, dice(squash(r.constituency), squash(d.name))]).sort((a, b) => b[1] - a[1])[0];
        // Some official names are shortened in the polling unit data ("Owode/Odeda" for
        // "Abeokuta North/Obafemi-Owode/Odeda"): accept the longest name contained in INEC's.
        const inside = districts.filter((d) => squash(r.constituency).includes(squash(d.name))).sort((a, b) => b.name.length - a.name.length)[0];
        const pick = best && best[1] >= 0.6 ? best[0] : inside;
        if (pick) { m = { area: pick.id }; name = r.name; matched++; }
      } else {
        // All-capitals pages: the district is the first few words.
        m = matchDistrict(tokens, districts);
        if (m) { name = tokens.slice(m.k).join(' '); matched++; }
      }
      if (m) { /* placed above */ }
      else if (prev && prev.state === st) {
        // Lists are grouped by district: a row we cannot place belongs with the one above.
        m = { area: prev.area }; name = r.name || tokens.join(' '); carried++;
      } else { skipped++; continue; }
      prev = { state: st, area: m.area };
      const res = ins.run(election, m.area, r.party, title(name), null);
      if (!res.changes) dup++;
    }
    const covered = db.prepare('SELECT COUNT(DISTINCT area_id) n FROM candidates WHERE election = ?').get(election).n;
    report[election] = { rows: rows.length, matched, carried, skipped, duplicate: dup, districts: `${covered}/${areas[election].length}` };
  }
  // Bundled photos (public/img/candidates, freely licensed, see credits.json). Uploaded
  // photos already in candidate_photos win: INSERT OR IGNORE never replaces them.
  const credits = path.join(__dirname, '..', 'public', 'img', 'candidates', 'credits.json');
  const insPhoto = db.prepare("INSERT OR IGNORE INTO candidate_photos (election, area_id, party, path, store) VALUES (?, ?, ?, ?, 'static')");
  for (const c of fs.existsSync(credits) ? JSON.parse(fs.readFileSync(credits, 'utf8')) : []) {
    const m = c.file.match(/^(pres|sen|rep)-(\d+-)?([A-Z]+)\./);
    if (m) insPhoto.run(m[1], m[2] ? parseInt(m[2], 10) : 0, m[3], `/img/candidates/${c.file}`);
  }
  db.exec('COMMIT');
  return report;
}

module.exports = { importCandidates };

if (require.main === module) {
  require('../lib/env');
  const { DatabaseSync } = require('node:sqlite');
  const { REFERENCE } = require('../lib/schema');
  const { REPORTS } = require('../lib/schema');
  const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ivote.sqlite'));
  db.exec(REFERENCE); db.exec(REPORTS);
  console.log(importCandidates(db));
}
