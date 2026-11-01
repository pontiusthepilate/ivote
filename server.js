require('./lib/env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const { db, q, stmts, normalizeCode, locate, recollate } = require('./lib/db');
const { results, clearCache } = require('./lib/results');
const storage = require('./lib/storage');
const { FEATURED, KNOWN, COLORS, OTHER_COLOR, normalizeParty } = require('./lib/parties');

const PORT = process.env.PORT || 4600;
const UPLOADS = storage.UPLOADS;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ELECTIONS = { pres: 'Presidential', sen: 'Senate', rep: 'House of Reps' };
const MAX_VIDEO_SECONDS = 30;

fs.mkdirSync(path.join(UPLOADS, 'tmp'), { recursive: true });

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// ---- Rate limiting -------------------------------------------------------------
// Many phones in Nigeria share one carrier IP, so the IP limit is generous;
// the per-device limit does the real work.
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < windowMs);
  h.push(now); hits.set(key, h);
  return h.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (!h.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
function rateLimit(req, res, next) {
  const dev = String(req.headers['x-device-id'] || '').slice(0, 64);
  if (limited(`ip:${req.ip}`, 600, 600e3) || (dev && limited(`dev:${dev}`, 40, 600e3)))
    return res.status(429).json({ error: 'Too many reports from this phone. Please wait a few minutes and try again.' });
  next();
}

// ---- Uploads -------------------------------------------------------------------
const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|quicktime|3gpp|webm)|application\/pdf)$/;
const upload = multer({
  dest: path.join(UPLOADS, 'tmp'),
  limits: { fileSize: 60 * 1024 * 1024, files: 10, fields: 40 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
});
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/3gpp': '3gp', 'video/webm': 'webm', 'application/pdf': 'pdf' };

let ffprobe = null;
execFile('ffprobe', ['-version'], (err) => { ffprobe = err ? null : 'ffprobe'; });
function videoSeconds(file) {
  return new Promise((resolve) => {
    if (!ffprobe) return resolve(null);
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 15000 },
      (err, out) => resolve(err ? null : parseFloat(out)));
  });
}

// Files are kept per polling unit: <state>/<lga>/<ward>/<unit>/<election>/<kind>/<file>
// (in the bucket, or under uploads/ when no bucket is configured).
// kind: one kind for all files, or an array with a kind per file.
async function storeFiles(files, pu, election, kind) {
  const stored = [];
  try {
    for (const [i, f] of files.entries()) {
      const k = Array.isArray(kind) ? kind[i] : kind;
      const key = [...pu.split('/'), election, k, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXT[f.mimetype]}`].join('/');
      stored.push({ file: f, key, kind: k, store: await storage.put(f.path, key, f.mimetype) });
    }
  } catch (e) {
    for (const s of stored) storage.remove(s.key, s.store);
    throw Object.assign(new Error('Could not save your files. Please try again.'), { status: 503, cause: e });
  }
  return stored;
}
const unstore = (stored) => { for (const s of stored || []) storage.remove(s.key, s.store); };
// Validation problems are 400 (the phone drops the report); anything else is 5xx so the phone retries.
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const cleanup = (files) => { for (const f of files || []) fs.rm(f.path, { force: true }, () => {}); };

// ---- Lookup API ----------------------------------------------------------------
app.get('/api/meta', (req, res) => {
  res.json({ elections: ELECTIONS, featured: FEATURED, parties: KNOWN, colors: COLORS, other_color: OTHER_COLOR, max_video_seconds: MAX_VIDEO_SECONDS });
});
app.get('/api/states', (req, res) => res.json(stmts.states.all()));
app.get('/api/lgas', (req, res) => res.json(stmts.lgas.all(String(req.query.state || ''))));
app.get('/api/wards', (req, res) => res.json(stmts.wards.all(String(req.query.lga || ''))));
app.get('/api/pus', (req, res) => res.json(stmts.pus.all(String(req.query.ward || ''))));
app.get('/api/pu', (req, res) => {
  const code = normalizeCode(req.query.code);
  const pu = code && stmts.pu.get(code);
  if (!pu) return res.status(404).json({ error: 'We could not find that polling unit number. Check it and try again.' });
  res.json(pu);
});
app.get('/api/locate', (req, res) => {
  const lat = +req.query.lat, lng = +req.query.lng;
  if (!(lat > 3 && lat < 15 && lng > 2 && lng < 15.5)) return res.status(404).json({ error: 'You appear to be outside Nigeria.' });
  const hit = locate(lat, lng);
  if (!hit) return res.status(404).json({ error: 'We could not match your location. Please choose below.' });
  res.json(hit);
});

// ---- Ballot: parties, logos and candidates for a polling unit ----------------------
const ballot = {
  parties: q('SELECT code, name, logo FROM parties ORDER BY code'),
  candidates: q(`SELECT c.party, c.name, c.running_mate, p.path, p.store, p.updated_at
                 FROM candidates c LEFT JOIN candidate_photos p
                   ON p.election = c.election AND p.area_id = c.area_id AND p.party = c.party
                 WHERE c.election = ? AND c.area_id = ? ORDER BY c.party`),
  photo: q('SELECT path, store FROM candidate_photos WHERE election = ? AND area_id = ? AND party = ?'),
  area: { sen: q('SELECT name FROM senatorial_districts WHERE id = ?'), rep: q('SELECT name FROM constituencies WHERE id = ?') },
  candidate: q('SELECT 1 FROM candidates WHERE election = ? AND area_id = ? AND party = ?'),
};
const photoUrl = (election, area, c) => !c.path ? null
  : c.store === 'static' ? c.path : `/api/candidate-photo/${election}/${area}/${c.party}?v=${encodeURIComponent(c.updated_at)}`;

// Which district a polling unit votes in for an election (0 = whole country).
function areaFor(election, puCode) {
  if (election === 'pres') return 0;
  const pu = stmts.pu.get(normalizeCode(puCode) || '');
  return pu ? (election === 'sen' ? pu.sen_id : pu.rep_id) : null;
}

app.get('/api/ballot', (req, res) => {
  const election = String(req.query.election || '');
  if (!ELECTIONS[election]) return res.status(400).json({ error: 'bad election' });
  const area = req.query.area != null && req.query.area !== '' ? Number(req.query.area) : areaFor(election, req.query.pu);
  const out = { election, area, area_name: area ? ballot.area[election].get(area)?.name : 'Nigeria', parties: ballot.parties.all(), candidates: [] };
  if (area != null) out.candidates = ballot.candidates.all(election, area).map((c) => ({
    party: c.party, name: c.name, running_mate: c.running_mate, photo: photoUrl(election, area, c),
  }));
  res.set('Cache-Control', 'public, max-age=300');
  res.json(out);
});

// Districts in a state, for the candidates page.
app.get('/api/areas', (req, res) => {
  const t = req.query.election === 'sen' ? 'senatorial_districts' : req.query.election === 'rep' ? 'constituencies' : null;
  if (!t) return res.json([{ id: 0, name: 'Nigeria' }]);
  res.json(q(`SELECT id, name FROM ${t} WHERE state_code = ? ORDER BY name`).all(String(req.query.state || '')));
});

app.get('/api/candidate-photo/:election/:area/:party', (req, res) => {
  const p = ballot.photo.get(req.params.election, Number(req.params.area), req.params.party);
  if (!p) return res.sendStatus(404);
  if (p.store === 'static') return res.redirect(302, p.path);
  storage.serve(res, { path: p.path, store: p.store, mime: { png: 'image/png', webp: 'image/webp' }[p.path.split('.').pop()] || 'image/jpeg' }).catch(() => res.sendStatus(502));
});

const photoUpload = multer({
  dest: path.join(UPLOADS, 'tmp'), limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});
const isAdmin = (req) => ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY;

app.post('/api/admin/candidate-photo', (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: 'Not allowed' })),
  photoUpload.single('photo'), async (req, res) => {
    try {
      const { election, party } = req.body; const area = Number(req.body.area);
      if (!req.file) throw bad('Choose a JPEG, PNG or WebP photo.');
      if (!ballot.candidate.get(election, area, party)) throw bad('No such candidate.');
      const key = `candidates/${election}/${area}/${party}-${Date.now()}.${EXT[req.file.mimetype]}`;
      const store = await storage.put(req.file.path, key, req.file.mimetype);
      const old = ballot.photo.get(election, area, party);
      q(`INSERT INTO candidate_photos (election, area_id, party, path, store) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (election, area_id, party) DO UPDATE SET path = excluded.path, store = excluded.store,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(election, area, party, key, store);
      if (old && old.store !== 'static') storage.remove(old.path, old.store);
      res.json({ ok: true, photo: photoUrl(election, area, { party, path: key, store, updated_at: new Date().toISOString() }) });
    } catch (e) {
      cleanup([req.file]);
      fail(res, e, () => null);
    }
  });

// ---- Reporting -----------------------------------------------------------------
const ins = {
  report: q(`INSERT INTO reports (client_id, election, pu_code, device_id, ip, total_votes, scores_key, flags)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  score: q('INSERT INTO report_scores (report_id, party, votes) VALUES (?, ?, ?)'),
  replace: q(`UPDATE reports SET status = 'replaced'
              WHERE election = ? AND pu_code = ? AND device_id = ? AND status = 'pending' AND id <> ?`),
  incident: q('INSERT INTO incidents (client_id, election, pu_code, device_id, ip, note, problem) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  media: q(`INSERT INTO media (election, pu_code, kind, report_id, incident_id, path, store, mime, size, comment)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  byClient: q('SELECT id FROM reports WHERE client_id = ?'),
  incByClient: q('SELECT id FROM incidents WHERE client_id = ?'),
};

function common(req) {
  const election = String(req.body.election || '');
  if (!ELECTIONS[election]) throw bad('Please choose an election.');
  const code = normalizeCode(req.body.pu_code);
  if (!code || !stmts.pu.get(code)) throw bad('Please choose your polling unit.');
  const clientId = String(req.body.client_id || '').slice(0, 64) || null;
  const device = String(req.headers['x-device-id'] || req.body.device_id || '').slice(0, 64) || null;
  return { election, code, clientId, device };
}

async function checkVideos(files, durations) {
  for (let i = 0; i < files.length; i++) {
    if (!files[i].mimetype.startsWith('video/')) continue;
    const secs = (await videoSeconds(files[i].path)) ?? +durations[i];
    if (secs > MAX_VIDEO_SECONDS + 1) throw bad(`Videos must be ${MAX_VIDEO_SECONDS} seconds or shorter.`);
  }
}

app.post('/api/reports', rateLimit, upload.array('sheet', 5), async (req, res) => {
  let stored = null;
  try {
    const { election, code, clientId, device } = common(req);
    const dup = clientId && ins.byClient.get(clientId);
    if (dup) { cleanup(req.files); return res.json({ ok: true, id: dup.id, duplicate: true }); }
    let raw;
    try { raw = JSON.parse(req.body.scores || '[]'); } catch { raw = null; }
    if (!Array.isArray(raw)) throw bad('Scores are missing.');
    const scores = new Map();
    for (const r of raw) {
      const party = normalizeParty(r.party);
      const votes = Number(r.votes);
      if (!party || r.votes === '' || r.votes == null) continue;
      if (!Number.isInteger(votes) || votes < 0 || votes > 100000) throw bad(`The score for ${party} must be a whole number.`);
      scores.set(party, (scores.get(party) || 0) + votes);
    }
    if (!scores.size) throw bad('Enter the score for at least one party.');
    const sorted = [...scores].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const total = sorted.reduce((s, [, v]) => s + v, 0);
    const flags = [];
    if (total > 3000) flags.push('high_total');
    if (!(req.files || []).length) flags.push('no_sheet');

    // Upload first (slow, over the network), then write everything in one quick transaction.
    stored = await storeFiles(req.files || [], code, election, 'result_sheet');
    db.exec('BEGIN');
    let id;
    try {
      id = Number(ins.report.run(clientId, election, code, device, req.ip, total,
        sorted.map(([p, v]) => `${p}:${v}`).join('|'), flags.join(',') || null).lastInsertRowid);
      for (const [p, v] of sorted) ins.score.run(id, p, v);
      // A phone's newer report for the same unit replaces its older one (corrections).
      if (device) ins.replace.run(election, code, device, id);
      for (const s of stored) ins.media.run(election, code, 'result_sheet', id, null, s.key, s.store, s.file.mimetype, s.file.size, null);
      recollate(election, code);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true, id });
  } catch (e) {
    cleanup(req.files); unstore(stored);
    fail(res, e, () => ins.byClient.get(String(req.body.client_id || '')));
  }
});

app.post('/api/incidents', rateLimit, upload.array('files', 10), async (req, res) => {
  let stored = null;
  try {
    const { election, code, clientId, device } = common(req);
    const dup = clientId && ins.incByClient.get(clientId);
    if (dup) { cleanup(req.files); return res.json({ ok: true, id: dup.id, duplicate: true }); }
    const files = req.files || [];
    let comments = [], durations = [], kinds = [];
    try {
      comments = JSON.parse(req.body.comments || '[]'); durations = JSON.parse(req.body.durations || '[]');
      kinds = JSON.parse(req.body.kinds || '[]');
    } catch {}
    // Each photo is either an extra result-sheet photo or part of the problem report.
    kinds = files.map((f, i) => (kinds[i] === 'result_sheet' && f.mimetype.startsWith('image/') ? 'result_sheet' : 'incident'));
    const note = String(req.body.note || '').trim().slice(0, 2000);
    if (!files.length && !note) throw bad('Add a photo, video, file or a short note.');
    await checkVideos(files, durations);
    stored = await storeFiles(files, code, election, kinds);
    const problem = note || kinds.includes('incident') ? 1 : 0;
    db.exec('BEGIN');
    let id;
    try {
      id = Number(ins.incident.run(clientId, election, code, device, req.ip, note || null, problem).lastInsertRowid);
      stored.forEach((s, i) => ins.media.run(election, code, s.kind, null, id, s.key, s.store,
        s.file.mimetype, s.file.size, String(comments[i] || '').trim().slice(0, 500) || null));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true, id });
  } catch (e) {
    cleanup(req.files); unstore(stored);
    fail(res, e, () => ins.incByClient.get(String(req.body.client_id || '')));
  }
});

// Two retries of the same report can race; the loser hits the UNIQUE client_id and
// should get the same "ok" answer as the winner.
function fail(res, e, findDup) {
  if (/UNIQUE constraint failed: \w+\.client_id/.test(e.message)) {
    const dup = findDup();
    if (dup) return res.json({ ok: true, id: dup.id, duplicate: true });
  }
  if (!e.status || e.status >= 500) console.error(e.cause || e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Please try again.' });
}

// ---- Collation & review ----------------------------------------------------------
app.get('/api/results', (req, res) => {
  try {
    const { election = 'pres', scope = '', id = '', group = 'state' } = req.query;
    res.json(results({ election, scope: scope || null, id: String(id), group }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const review = {
  reports: q(`SELECT r.id, r.election, r.status, r.total_votes, r.flags, r.created_at, r.device_id,
                (SELECT report_id FROM pu_results x WHERE x.election = r.election AND x.pu_code = r.pu_code) = r.id counted
              FROM reports r WHERE r.pu_code = ? ORDER BY r.created_at DESC`),
  scores: q('SELECT party, votes FROM report_scores WHERE report_id = ? ORDER BY votes DESC'),
  incidents: q('SELECT id, election, note, created_at FROM incidents WHERE pu_code = ? AND problem = 1 ORDER BY created_at DESC'),
  media: q('SELECT id, election, kind, report_id, incident_id, mime, size, comment, created_at FROM media WHERE pu_code = ? ORDER BY created_at DESC'),
  status: q('SELECT election, pu_code FROM reports WHERE id = ?'),
  setStatus: q('UPDATE reports SET status = ? WHERE id = ?'),
  mediaPath: q('SELECT path, store, mime FROM media WHERE id = ?'),
  results: q('SELECT election, report_id, n_reports, n_versions, agree FROM pu_results WHERE pu_code = ?'),
};

app.get('/api/review', (req, res) => {
  const code = normalizeCode(req.query.code);
  const pu = code && stmts.pu.get(code);
  if (!pu) return res.status(404).json({ error: 'Unknown polling unit' });
  const isAdmin = ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY;
  const reports = review.reports.all(code).map((r) => ({
    ...r, counted: !!r.counted, scores: review.scores.all(r.id),
    device_id: isAdmin ? r.device_id : r.device_id ? r.device_id.slice(0, 6) : null,
  }));
  res.json({ pu, reports, incidents: review.incidents.all(code), media: review.media.all(code), results: review.results.all(code) });
});

app.get('/media/:id', (req, res) => {
  const m = review.mediaPath.get(Number(req.params.id));
  if (!m) return res.sendStatus(404);
  storage.serve(res, m).catch(() => res.sendStatus(502));
});

app.post('/api/admin/reports/:id/status', (req, res) => {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Not allowed' });
  const status = req.body.status;
  if (!['pending', 'verified', 'rejected'].includes(status)) return res.status(400).json({ error: 'bad status' });
  const r = review.status.get(Number(req.params.id));
  if (!r) return res.sendStatus(404);
  review.setStatus.run(status, Number(req.params.id));
  recollate(r.election, r.pu_code);
  clearCache();
  res.json({ ok: true });
});

app.get('/api/admin/check', (req, res) => res.json({ ok: !!ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY }));

// Polling units where reporters disagree, newest first — the review queue.
app.get('/api/disputed', (req, res) => {
  const election = ELECTIONS[req.query.election] ? req.query.election : 'pres';
  res.json(q(`SELECT r.pu_code code, p.name, w.name ward, l.name lga, s.name state, r.n_reports, r.n_versions
              FROM pu_results r JOIN polling_units p ON p.code = r.pu_code JOIN wards w ON w.id = p.ward_id
              JOIN lgas l ON l.id = p.lga_id JOIN states s ON s.code = p.state_code
              WHERE r.election = ? AND r.n_versions > 1 ORDER BY r.rowid DESC LIMIT 200`).all(election));
});

app.use('/geo', express.static(path.join(__dirname, 'public', 'geo'), { maxAge: '1d' }));
// Everything else revalidates on each load (cheap ETag check) so fixes reach phones immediately.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, extensions: ['html'] }));

app.use((err, req, res, next) => {
  cleanup(req.files);
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'One of the files is too big (60 MB max).'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Too many files (10 max).' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`Ivote running on http://localhost:${PORT} (uploads: ${storage.mode === 's3' ? `bucket ${process.env.BUCKET_NAME}` : UPLOADS})`));
