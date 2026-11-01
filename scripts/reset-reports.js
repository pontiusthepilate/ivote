// Deletes ALL reports, incidents and uploaded files (keeps the polling unit list).
// Use before going live to clear test and demo data. Empties the bucket too when BUCKET_NAME is set.
//   node scripts/reset-reports.js --yes
require('../lib/env');
const fs = require('fs');
const path = require('path');
if (!process.argv.includes('--yes')) { console.log('This deletes every report and upload. Re-run with --yes to confirm.'); process.exit(1); }
const { db } = require('../lib/db');
const { UPLOADS } = require('../lib/storage');

(async () => {
  db.exec('BEGIN; DELETE FROM media; DELETE FROM incidents; DELETE FROM pu_results; DELETE FROM report_scores; DELETE FROM reports; COMMIT; VACUUM;');
  for (const f of fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : []) if (f !== 'tmp') fs.rmSync(path.join(UPLOADS, f), { recursive: true, force: true });
  if (process.env.BUCKET_NAME) {
    const S = require('@aws-sdk/client-s3');
    const c = new S.S3Client({ region: process.env.AWS_REGION || 'auto', endpoint: process.env.AWS_ENDPOINT_URL_S3 });
    let n = 0, token;
    do {
      const l = await c.send(new S.ListObjectsV2Command({ Bucket: process.env.BUCKET_NAME, ContinuationToken: token }));
      const keys = (l.Contents || []).map((o) => ({ Key: o.Key }));
      if (keys.length) await c.send(new S.DeleteObjectsCommand({ Bucket: process.env.BUCKET_NAME, Delete: { Objects: keys } }));
      n += keys.length; token = l.NextContinuationToken;
    } while (token);
    console.log(`Deleted ${n} files from bucket ${process.env.BUCKET_NAME}.`);
  }
  console.log('All reports and uploads deleted.');
})();
