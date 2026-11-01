// Where uploaded files live. With BUCKET_NAME set (Tigris / any S3), files go to the
// bucket and are served through short-lived signed links; otherwise to local disk.
const fs = require('fs');
const path = require('path');

const UPLOADS = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const BUCKET = process.env.BUCKET_NAME || '';
const LINK_SECONDS = 3600;

let s3 = null, S3 = null, presign = null;
if (BUCKET) {
  S3 = require('@aws-sdk/client-s3');
  presign = require('@aws-sdk/s3-request-presigner').getSignedUrl;
  s3 = new S3.S3Client({
    region: process.env.AWS_REGION || 'auto',
    endpoint: process.env.AWS_ENDPOINT_URL_S3 || undefined,
    forcePathStyle: false,
  });
}

const mode = BUCKET ? 's3' : 'local';

// Moves a multer temp file to its permanent key. Returns the store used.
async function put(tmpPath, key, mime) {
  if (BUCKET) {
    await s3.send(new S3.PutObjectCommand({
      Bucket: BUCKET, Key: key, ContentType: mime,
      Body: fs.createReadStream(tmpPath), ContentLength: fs.statSync(tmpPath).size,
    }));
    fs.rm(tmpPath, { force: true }, () => {});
    return 's3';
  }
  fs.mkdirSync(path.join(UPLOADS, path.dirname(key)), { recursive: true });
  fs.renameSync(tmpPath, path.join(UPLOADS, key));
  return 'local';
}

async function remove(key, store) {
  try {
    if (store === 's3' && s3) await s3.send(new S3.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    else fs.rmSync(path.join(UPLOADS, key), { force: true });
  } catch {}
}

// Sends the file to the browser: a redirect to a signed link, or the file itself.
async function serve(res, m) {
  if (m.store === 's3') {
    if (!s3) return res.sendStatus(404);
    const url = await presign(s3, new S3.GetObjectCommand({ Bucket: BUCKET, Key: m.path, ResponseContentType: m.mime }), { expiresIn: LINK_SECONDS });
    res.set('Cache-Control', `private, max-age=${LINK_SECONDS - 300}`);
    return res.redirect(302, url);
  }
  res.type(m.mime);
  res.sendFile(path.join(UPLOADS, m.path), { maxAge: '7d' });
}

module.exports = { UPLOADS, mode, put, remove, serve };
