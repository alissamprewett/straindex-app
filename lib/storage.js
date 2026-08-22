// storage.js — uploads check-in photos to Cloudflare R2 instead of storing
// them as base64 blobs directly in the database. R2 is S3-compatible, so
// this uses the standard AWS S3 SDK pointed at R2's endpoint.
//
// Falls back gracefully to storing the raw base64 data URL (the original
// behavior) if R2 credentials aren't configured -- so local development
// without R2 set up still works, it just won't get the storage benefit.
//
// Existing check-ins with base64 photos already in the database are
// unaffected -- this only applies to new uploads going forward. No
// migration needed, since <img src="..."> renders either a data: URL or
// a real https:// URL identically.

const crypto = require('node:crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const R2_CONFIGURED = !!(
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_ENDPOINT &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_PUBLIC_URL
);

const client = R2_CONFIGURED
  ? new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

// Accepts a base64 data URL (e.g. "data:image/jpeg;base64,...") and
// returns a public https URL to the uploaded object. If the input isn't
// a data URL (already a URL, or empty/null), it's returned unchanged --
// this covers editing an entry without changing its photo. `folder` lets
// different features (check-ins, grow journal, etc.) keep their uploads
// in separate prefixes within the same bucket.
async function uploadPhoto(dataUrl, folder = 'checkins') {
  if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl || null;
  if (!R2_CONFIGURED) {
    console.warn('[storage] R2 not configured -- falling back to storing the photo as base64 in the database.');
    return dataUrl;
  }

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return dataUrl; // not a recognizable image data URL, leave as-is

  const contentType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const key = `${folder}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;

  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
}
// Kept for backward compatibility with existing check-in code -- just
// calls the general uploader with the same 'checkins' folder as before.
async function uploadCheckinPhoto(dataUrl) {
  return uploadPhoto(dataUrl, 'checkins');
}

module.exports = { uploadCheckinPhoto, uploadPhoto, R2_CONFIGURED };
