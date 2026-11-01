// Live collation queries. Every number comes from pu_results, i.e. one counted
// report per polling unit per election.

const { q } = require('./db');

const GROUP_COL = { state: 'state_code', lga: 'lga_id', ward: 'ward_id', pu: 'code', sen: 'sen_id', rep: 'rep_id' };
const SCOPE_COL = { state: 'state_code', lga: 'lga_id', ward: 'ward_id', sen: 'sen_id', rep: 'rep_id' };
const NAMES = {
  state: q('SELECT code id, name FROM states').all(),
  lga: q('SELECT id, name FROM lgas').all(),
  ward: q('SELECT id, name, lat, lng FROM wards').all(),
  sen: q('SELECT id, name FROM senatorial_districts').all(),
  rep: q('SELECT id, name FROM constituencies').all(),
};
const nameMap = Object.fromEntries(Object.entries(NAMES).map(([k, rows]) => [k, new Map(rows.map((r) => [String(r.id), r]))]));

const totalsCache = new Map();
function puTotals(group, scope, id) {
  const key = `${group}|${scope}|${id}`;
  if (totalsCache.has(key)) return totalsCache.get(key);
  const where = scope ? `WHERE ${SCOPE_COL[scope]} = ?` : '';
  const rows = q(`SELECT ${GROUP_COL[group]} gid, COUNT(*) n FROM polling_units ${where} GROUP BY gid`).all(...(scope ? [id] : []));
  const m = new Map(rows.map((r) => [String(r.gid), r.n]));
  totalsCache.set(key, m);
  return m;
}

const cache = new Map();
const TTL_MS = 5000;

function results({ election, scope, id, group }) {
  if (!['pres', 'sen', 'rep'].includes(election)) throw new Error('bad election');
  if (!GROUP_COL[group]) throw new Error('bad group');
  if (scope && !SCOPE_COL[scope]) throw new Error('bad scope');
  const key = JSON.stringify([election, scope, id, group]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const g = GROUP_COL[group];
  const where = ['r.election = ?'];
  const args = [election];
  if (scope) { where.push(`p.${SCOPE_COL[scope]} = ?`); args.push(id); }
  const W = where.join(' AND ');

  const scoreRows = q(`SELECT p.${g} gid, rs.party, SUM(rs.votes) votes
      FROM pu_results r JOIN polling_units p ON p.code = r.pu_code JOIN report_scores rs ON rs.report_id = r.report_id
      WHERE ${W} GROUP BY gid, rs.party`).all(...args);
  const countRows = q(`SELECT p.${g} gid, COUNT(*) reported, SUM(r.n_versions > 1) disputed
      FROM pu_results r JOIN polling_units p ON p.code = r.pu_code WHERE ${W} GROUP BY gid`).all(...args);
  const incRows = q(`SELECT p.${g} gid, COUNT(*) n FROM incidents i JOIN polling_units p ON p.code = i.pu_code
      WHERE i.election = ? AND i.problem = 1 ${scope ? `AND p.${SCOPE_COL[scope]} = ?` : ''} GROUP BY gid`).all(...args);

  const totals = puTotals(group, scope, id);
  const groups = new Map();
  const names = group === 'pu'
    ? new Map(q(`SELECT code id, name, lat, lng FROM polling_units ${scope ? `WHERE ${SCOPE_COL[scope]} = ?` : ''}`).all(...(scope ? [id] : [])).map((r) => [r.id, r]))
    : nameMap[group];
  for (const [gid, n] of totals) {
    const meta = names.get(gid) || {};
    groups.set(gid, { id: gid, name: meta.name || gid, lat: meta.lat ?? null, lng: meta.lng ?? null, total: n, reported: 0, disputed: 0, incidents: 0, votes: {} });
  }
  for (const r of scoreRows) { const x = groups.get(String(r.gid)); if (x) x.votes[r.party] = r.votes; }
  for (const r of countRows) { const x = groups.get(String(r.gid)); if (x) { x.reported = r.reported; x.disputed = r.disputed; } }
  for (const r of incRows) { const x = groups.get(String(r.gid)); if (x) x.incidents = r.n; }

  const national = {};
  let reported = 0, disputed = 0, total = 0, incidents = 0;
  for (const x of groups.values()) {
    const ranked = Object.entries(x.votes).sort((a, b) => b[1] - a[1]);
    x.leader = ranked[0]?.[0] || null;
    x.cast = ranked.reduce((s, [, v]) => s + v, 0);
    for (const [p, v] of ranked) national[p] = (national[p] || 0) + v;
    reported += x.reported; disputed += x.disputed; total += x.total; incidents += x.incidents;
  }
  const data = {
    election, scope: scope || null, id: id || null, group,
    totals: Object.entries(national).map(([party, votes]) => ({ party, votes })).sort((a, b) => b.votes - a.votes),
    reported, total, disputed, incidents,
    groups: [...groups.values()].sort((a, b) => (group === 'pu' ? (a.id < b.id ? -1 : 1) : a.name.localeCompare(b.name))),
    updated_at: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

function clearCache() { cache.clear(); }

module.exports = { results, clearCache, NAMES };
