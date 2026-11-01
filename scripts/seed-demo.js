// Fills the database with made-up reports so the dashboard can be tried out.
//   node scripts/seed-demo.js           # add demo reports
//   node scripts/seed-demo.js --clear   # remove every demo report (do this before going live)
const { db, q, recollate } = require('../lib/db');

const DEMO = 'demo-seed';
if (process.argv.includes('--clear')) {
  const rows = q('SELECT DISTINCT election, pu_code FROM reports WHERE device_id = ?').all(DEMO);
  db.exec('BEGIN');
  q('DELETE FROM report_scores WHERE report_id IN (SELECT id FROM reports WHERE device_id = ?)').run(DEMO);
  q('DELETE FROM reports WHERE device_id = ?').run(DEMO);
  for (const r of rows) recollate(r.election, r.pu_code);
  db.exec('COMMIT');
  console.log(`Removed demo reports for ${rows.length} polling units`);
  process.exit(0);
}

const n = +(process.argv[2] || 25000);
const pus = q('SELECT code, state_code FROM polling_units ORDER BY random() LIMIT ?').all(n);
// Each state leans to a party so the map looks like a real result.
const lean = {};
const parties = ['APC', 'PDP', 'ADC', 'NDC', 'LP', 'NNPP'];
const ins = q(`INSERT INTO reports (election, pu_code, device_id, total_votes, scores_key) VALUES (?, ?, ?, ?, ?)`);
const sc = q('INSERT INTO report_scores (report_id, party, votes) VALUES (?, ?, ?)');
db.exec('BEGIN');
for (const p of pus) {
  for (const e of ['pres', 'sen', 'rep']) {
    if (Math.random() < (e === 'pres' ? 0.05 : 0.35)) continue;
    const L = lean[`${e}${p.state_code}`] || (lean[`${e}${p.state_code}`] = parties[Math.floor(Math.random() * 4)]);
    const scores = parties.map((x) => [x, Math.round(Math.random() * 60 + (x === L ? 120 : 0) + (x === 'APC' || x === 'PDP' ? 30 : 0))])
      .filter(([x, v]) => v > 5 && (x !== 'NNPP' || Math.random() < 0.4)).sort();
    const total = scores.reduce((s, [, v]) => s + v, 0);
    const id = Number(ins.run(e, p.code, DEMO, total, scores.map(([x, v]) => `${x}:${v}`).join('|')).lastInsertRowid);
    for (const [x, v] of scores) sc.run(id, x, v);
    recollate(e, p.code);
  }
}
db.exec('COMMIT');
console.log(`Seeded demo results for ${pus.length} polling units`);
