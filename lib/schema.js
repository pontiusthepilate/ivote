// Shared SQLite schema. Reference tables are (re)built by scripts/build-db.js;
// report tables are created on server start and never dropped by a rebuild.

const REFERENCE = `
CREATE TABLE IF NOT EXISTS states (
  code TEXT PRIMARY KEY,          -- '01'
  name TEXT NOT NULL,
  lat REAL, lng REAL
);
CREATE TABLE IF NOT EXISTS lgas (
  id TEXT PRIMARY KEY,            -- '01/02'
  state_code TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  lat REAL, lng REAL
);
CREATE TABLE IF NOT EXISTS wards (
  id TEXT PRIMARY KEY,            -- '01/02/03'
  lga_id TEXT NOT NULL,
  state_code TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  lat REAL, lng REAL
);
CREATE TABLE IF NOT EXISTS senatorial_districts (
  id INTEGER PRIMARY KEY,
  state_code TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS constituencies (
  id INTEGER PRIMARY KEY,
  state_code TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS polling_units (
  code TEXT PRIMARY KEY,          -- '01/02/03/004' (INEC delimitation)
  ward_id TEXT NOT NULL,
  lga_id TEXT NOT NULL,
  state_code TEXT NOT NULL,
  name TEXT NOT NULL,
  sen_id INTEGER NOT NULL,
  rep_id INTEGER NOT NULL,
  lat REAL, lng REAL,
  geo TEXT                        -- 'locator' | 'geocoded' | NULL (no trusted point)
);
-- INEC registered parties; logo is a path under public/ (e.g. /img/parties/APC.jpg).
CREATE TABLE IF NOT EXISTS parties (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo TEXT
);
-- INEC final list of candidates. area_id: 0 for presidential, senatorial_districts.id, or constituencies.id.
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  election TEXT NOT NULL,
  area_id INTEGER NOT NULL,
  party TEXT NOT NULL,
  name TEXT NOT NULL,
  running_mate TEXT,
  UNIQUE (election, area_id, party)
);
CREATE INDEX IF NOT EXISTS pu_ward ON polling_units(ward_id);
CREATE INDEX IF NOT EXISTS pu_lga ON polling_units(lga_id);
CREATE INDEX IF NOT EXISTS pu_sen ON polling_units(sen_id);
CREATE INDEX IF NOT EXISTS pu_rep ON polling_units(rep_id);
CREATE INDEX IF NOT EXISTS ward_lga ON wards(lga_id);
CREATE INDEX IF NOT EXISTS lga_state ON lgas(state_code);
`;

const REPORTS = `
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  client_id TEXT UNIQUE,          -- set by the phone so offline retries never double count
  election TEXT NOT NULL CHECK (election IN ('pres','sen','rep')),
  pu_code TEXT NOT NULL,
  device_id TEXT,
  ip TEXT,
  total_votes INTEGER NOT NULL,
  scores_key TEXT NOT NULL,       -- canonical "APC:120|PDP:80" string, used to find agreeing reports
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','replaced')),
  flags TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS rep_pu ON reports(election, pu_code);

CREATE TABLE IF NOT EXISTS report_scores (
  report_id INTEGER NOT NULL REFERENCES reports(id),
  party TEXT NOT NULL,
  votes INTEGER NOT NULL,
  PRIMARY KEY (report_id, party)
);

-- One row per (election, polling unit): the report that currently counts.
CREATE TABLE IF NOT EXISTS pu_results (
  election TEXT NOT NULL,
  pu_code TEXT NOT NULL,
  report_id INTEGER NOT NULL,
  n_reports INTEGER NOT NULL,
  n_versions INTEGER NOT NULL,    -- >1 means reporters disagree: needs review
  agree INTEGER NOT NULL,         -- how many reports match the counted one
  PRIMARY KEY (election, pu_code)
);

-- Candidate photos, kept apart from candidates so a rebuild never loses them.
CREATE TABLE IF NOT EXISTS candidate_photos (
  election TEXT NOT NULL,
  area_id INTEGER NOT NULL,
  party TEXT NOT NULL,
  path TEXT NOT NULL,              -- static path (/img/...) or storage key
  store TEXT NOT NULL,             -- 'static' | 'local' | 's3'
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (election, area_id, party)
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  client_id TEXT UNIQUE,
  election TEXT NOT NULL,
  pu_code TEXT NOT NULL,
  device_id TEXT,
  ip TEXT,
  note TEXT,
  problem INTEGER NOT NULL DEFAULT 1, -- 0 when the submission was only extra result photos
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS inc_pu ON incidents(pu_code);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  election TEXT NOT NULL,
  pu_code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('result_sheet','incident')),
  report_id INTEGER,
  incident_id INTEGER,
  path TEXT NOT NULL,              -- key under uploads/ or in the bucket: <state>/<lga>/<ward>/<unit>/<election>/<kind>/<file>
  store TEXT NOT NULL DEFAULT 'local', -- 'local' | 's3'
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS media_pu ON media(pu_code);
`;

module.exports = { REFERENCE, REPORTS };
