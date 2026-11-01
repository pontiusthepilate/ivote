// Builds the reference database (states → LGAs → wards → polling units, plus
// senatorial districts and federal constituencies) from data/sources/, and
// writes the map shapes the dashboard uses to public/geo/.
//
//   node scripts/build-db.js            # writes data/ivote.sqlite
//
// Report tables already in the database are left untouched.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { REFERENCE, REPORTS } = require('../lib/schema');
const { shape } = require('../lib/geo');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'sources');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'ivote.sqlite');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const ROMAN = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/i;
function title(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/[a-z0-9]+/g, (w) => (ROMAN.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
}
const norm = (s) => s.toLowerCase().replace(/federal capital territory|abuja/g, 'fct').replace(/[^a-z0-9]/g, '');

// Known typos in the source district names.
function fixDistrict(s) {
  return s.replace(/\bdeltal\b/g, 'delta').replace(/\bnkokwa\b/g, 'ndokwa');
}

function main() {
  console.log('Reading polling unit master list…');
  const rows = parseCsv(fs.readFileSync(path.join(SRC, 'polling_units.csv'), 'utf8'));
  console.log(`  ${rows.length} polling units`);

  const states = new Map(), lgas = new Map(), wards = new Map(), sens = new Map(), reps = new Map();
  const pus = [];
  for (const r of rows) {
    const s = r.state_code, l = `${s}/${r.lg_code}`, w = `${l}/${r.ward_code}`;
    if (!states.has(s)) states.set(s, { code: s, name: r.state === 'fct' ? 'FCT Abuja' : title(r.state) });
    if (!lgas.has(l)) lgas.set(l, { id: l, state_code: s, code: r.lg_code, name: title(r.lg) });
    if (!wards.has(w)) wards.set(w, { id: w, lga_id: l, state_code: s, code: r.ward_code, name: title(r.ward) });
    const sk = `${s}|${r.senatorial}`, rk = `${s}|${r.house_of_rep}`;
    if (!sens.has(sk)) sens.set(sk, { id: sens.size + 1, state_code: s, name: title(fixDistrict(r.senatorial)) });
    if (!reps.has(rk)) reps.set(rk, { id: reps.size + 1, state_code: s, name: title(fixDistrict(r.house_of_rep)) });
    pus.push({
      code: r.code, ward_id: w, lga_id: l, state_code: s,
      name: r.location.replace(/\s+/g, ' ').trim().toUpperCase(),
      sen_id: sens.get(sk).id, rep_id: reps.get(rk).id, lat: null, lng: null, geo: null,
    });
  }
  console.log(`  ${states.size} states, ${lgas.size} LGAs, ${wards.size} wards, ${sens.size} senatorial districts, ${reps.size} federal constituencies`);

  // ---- Map shapes -------------------------------------------------------
  const stateGeo = JSON.parse(fs.readFileSync(path.join(SRC, 'states.geojson'), 'utf8'));
  const lgaGeo = JSON.parse(fs.readFileSync(path.join(SRC, 'lgas.geojson'), 'utf8'));
  const stateByNorm = new Map([...states.values()].map((s) => [norm(s.name), s]));
  const stateShapes = new Map();
  for (const f of stateGeo.features) {
    const st = stateByNorm.get(norm(f.properties.shapeName));
    if (!st) throw new Error(`No INEC state for shape ${f.properties.shapeName}`);
    f.properties = { code: st.code, name: st.name };
    stateShapes.set(st.code, shape(f));
  }
  const lgaShapes = lgaGeo.features.map(shape);

  // ---- Coordinates: prefer INEC locator points, then geocoded ones --------
  const puByCode = new Map(pus.map((p) => [p.code, p]));
  const candidates = new Map(); // code -> [{lat,lng,src}]
  for (const [file, src] of [['pu_geo_locator.csv', 'locator'], ['pu_geo_mykeels.csv', 'geocoded']]) {
    for (const r of parseCsv(fs.readFileSync(path.join(SRC, file), 'utf8'))) {
      const lat = +r.lat, lng = +r.lng;
      if (!puByCode.has(r.code) || !(lat > 4 && lat < 14 && lng > 2.6 && lng < 14.8)) continue;
      if (!candidates.has(r.code)) candidates.set(r.code, []);
      candidates.get(r.code).push({ lat, lng, src });
    }
  }
  // Geocoders fall back to a town centre when they cannot find a school, so the
  // same point gets reused for many units. Those are not precise enough to pick a
  // polling unit with.
  const seen = new Map();
  for (const list of candidates.values()) for (const c of list) {
    const k = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }

  // Match each INEC LGA to a boundary shape by where its units fall.
  console.log('Matching LGAs to map boundaries…');
  const votes = new Map(); // lga_id -> Map(shapeIdx -> n)
  for (const p of pus) {
    const c = (candidates.get(p.code) || [])[0];
    if (!c || !stateShapes.get(p.state_code).contains(c.lng, c.lat)) continue;
    const idx = lgaShapes.findIndex((s) => s.contains(c.lng, c.lat));
    if (idx < 0) continue;
    if (!votes.has(p.lga_id)) votes.set(p.lga_id, new Map());
    const m = votes.get(p.lga_id); m.set(idx, (m.get(idx) || 0) + 1);
  }
  const lgaToShape = new Map(), shapeTaken = new Map();
  const ranked = [...votes].map(([id, m]) => {
    const [idx, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    return { id, idx, n };
  }).sort((a, b) => b.n - a.n);
  for (const { id, idx } of ranked) {
    if (shapeTaken.has(idx)) continue;
    lgaToShape.set(id, idx); shapeTaken.set(idx, id);
  }
  // Leftovers: match by name within the same state.
  // Spellings differ between INEC and the boundary data ("S/Birni" vs "Sabon Birni"),
  // so score by shared letter pairs and take the best unclaimed shape in the state.
  const shapeState = (s) => {
    const g = lgaGeo.features[lgaShapes.indexOf(s)].geometry;
    const ring = (g.type === 'Polygon' ? g.coordinates : g.coordinates[0])[0];
    const n = new Map();
    for (let i = 0; i < ring.length; i += Math.max(1, ring.length >> 5))
      for (const [code, st] of stateShapes) if (st.contains(ring[i][0], ring[i][1])) n.set(code, (n.get(code) || 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const pairs = (s) => { const t = norm(s), out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
  const dice = (a, b) => { const A = pairs(a), B = pairs(b); let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size || 1); };
  const freeByState = new Map();
  lgaShapes.forEach((s, i) => {
    if (shapeTaken.has(i)) return;
    const st = shapeState(s); if (!st) return;
    if (!freeByState.has(st)) freeByState.set(st, []);
    freeByState.get(st).push(i);
  });
  for (const l of lgas.values()) {
    if (lgaToShape.has(l.id)) continue;
    const free = (freeByState.get(l.state_code) || []).filter((i) => !shapeTaken.has(i));
    const best = free.map((i) => [i, dice(l.name, lgaShapes[i].props.shapeName)]).sort((a, b) => b[1] - a[1])[0];
    if (best && (best[1] > 0.3 || free.length === 1)) { lgaToShape.set(l.id, best[0]); shapeTaken.set(best[0], l.id); continue; }
    // Border LGAs can look like they belong to the neighbouring state; accept an exact name match anywhere.
    const exact = lgaShapes.findIndex((s, i) => !shapeTaken.has(i) && norm(s.props.shapeName) === norm(l.name));
    if (exact >= 0) { lgaToShape.set(l.id, exact); shapeTaken.set(exact, l.id); }
    else console.log(`  no boundary for ${l.name}`);
  }
  console.log(`  ${lgaToShape.size}/${lgas.size} LGAs matched to a boundary`);
  lgaShapes.forEach((s, i) => { if (!shapeTaken.has(i)) console.log(`  unused boundary: ${s.props.shapeName} (${shapeState(s)})`); });

  // Keep a point only if it lands inside (or within 3 km of) the unit's own LGA.
  let kept = { locator: 0, geocoded: 0 };
  for (const p of pus) {
    const shp = lgaShapes[lgaToShape.get(p.lga_id)];
    for (const c of candidates.get(p.code) || []) {
      const ok = shp ? shp.contains(c.lng, c.lat) || shp.bboxKm(c.lng, c.lat) < 3
        : stateShapes.get(p.state_code).contains(c.lng, c.lat);
      if (!ok) continue;
      const dup = seen.get(`${c.lat.toFixed(4)},${c.lng.toFixed(4)}`) > 3;
      if (dup && c.src === 'geocoded') continue;
      Object.assign(p, { lat: c.lat, lng: c.lng, geo: c.src }); kept[c.src]++;
      break;
    }
  }
  console.log(`  trusted points: ${kept.locator} from INEC locator, ${kept.geocoded} geocoded`);

  // ---- Centres for wards / LGAs / states ------------------------------------
  const median = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
  const group = (key) => {
    const m = new Map();
    for (const p of pus) if (p.lat != null) {
      const k = p[key]; if (!m.has(k)) m.set(k, { lat: [], lng: [] });
      m.get(k).lat.push(p.lat); m.get(k).lng.push(p.lng);
    }
    return m;
  };
  for (const [k, v] of group('ward_id')) Object.assign(wards.get(k), { lat: median(v.lat), lng: median(v.lng) });
  for (const [k, v] of group('lga_id')) Object.assign(lgas.get(k), { lat: median(v.lat), lng: median(v.lng) });
  for (const [k, v] of group('state_code')) Object.assign(states.get(k), { lat: median(v.lat), lng: median(v.lng) });
  for (const l of lgas.values()) {
    const s = lgaShapes[lgaToShape.get(l.id)];
    if (l.lat == null && s) Object.assign(l, { lat: (s.bbox[1] + s.bbox[3]) / 2, lng: (s.bbox[0] + s.bbox[2]) / 2 });
  }
  // Wards with no trusted unit points: use the published ward centroid list (matched by name).
  const centroidList = JSON.parse(fs.readFileSync(path.join(SRC, 'ward_centroids.json'), 'utf8'));
  const cIndex = new Map();
  for (const s of centroidList) for (const l of s.lgas) for (const w of l.wards)
    cIndex.set(`${norm(s.state)}|${norm(l.name)}|${norm(w.name)}`, w);
  let filled = 0;
  for (const w of wards.values()) {
    if (w.lat != null) continue;
    const l = lgas.get(w.lga_id), s = states.get(w.state_code);
    const c = cIndex.get(`${norm(s.name)}|${norm(l.name)}|${norm(w.name)}`);
    if (c) { w.lat = c.latitude; w.lng = c.longitude; filled++; }
    else if (l.lat != null) { w.lat = l.lat; w.lng = l.lng; }
  }
  console.log(`  ${filled} ward centres filled from the published centroid list`);

  // ---- Write database -------------------------------------------------------
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('DROP TABLE IF EXISTS candidates; DROP TABLE IF EXISTS parties; DROP TABLE IF EXISTS polling_units; DROP TABLE IF EXISTS wards; DROP TABLE IF EXISTS lgas; DROP TABLE IF EXISTS states; DROP TABLE IF EXISTS senatorial_districts; DROP TABLE IF EXISTS constituencies;');
  db.exec(REFERENCE);
  db.exec(REPORTS);
  const insert = (table, objs) => {
    const cols = Object.keys(objs[0]);
    const st = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    db.exec('BEGIN');
    for (const o of objs) st.run(...cols.map((c) => o[c] ?? null));
    db.exec('COMMIT');
  };
  insert('states', [...states.values()]);
  insert('lgas', [...lgas.values()]);
  insert('wards', [...wards.values()]);
  insert('senatorial_districts', [...sens.values()]);
  insert('constituencies', [...reps.values()]);
  insert('polling_units', pus);
  console.log('Importing parties and INEC candidate lists…');
  console.log(' ', JSON.stringify(require('./import-candidates').importCandidates(db)));
  db.close();
  console.log(`Wrote ${DB_PATH}`);

  // ---- Write map files ------------------------------------------------------
  const round = (g) => JSON.parse(JSON.stringify(g), (k, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v));
  const outDir = path.join(ROOT, 'public', 'geo');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'states.geojson'), JSON.stringify(round(stateGeo)));
  const lgaOut = { type: 'FeatureCollection', features: [] };
  lgaGeo.features.forEach((f, i) => {
    const id = shapeTaken.get(i); if (!id) return;
    const l = lgas.get(id);
    lgaOut.features.push({ type: 'Feature', properties: { id, state: l.state_code, name: l.name }, geometry: round(f.geometry) });
  });
  fs.writeFileSync(path.join(outDir, 'lgas.geojson'), JSON.stringify(lgaOut));
  console.log(`Wrote map files to ${outDir}`);
}

main();
