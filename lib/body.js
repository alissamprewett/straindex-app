// body.js — read & parse request bodies without any npm dependency.
const querystring = require('node:querystring');

function readRawBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseForm(req) {
  // Cached on the request object so this is safe to call twice -- once
  // centrally (the CSRF check in server.js, which needs the fields before
  // any route handler runs) and once again inside the handler itself,
  // which still just calls parseForm(req) exactly as before and has no
  // idea the body was already read. A Node request body is a stream that
  // can only be consumed once; without this cache the handler's own call
  // would hang waiting on an already-drained stream.
  if (req.__parsedFormBody) return req.__parsedFormBody;
  const raw = await readRawBody(req);
  const fields = querystring.parse(raw.toString('utf8'));
  req.__parsedFormBody = fields;
  return fields;
}

async function parseJson(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { return {}; }
}

module.exports = { readRawBody, parseForm, parseJson };
