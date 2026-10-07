// canary.js -- run `node canary.js` before/after uploading files to GitHub.
// Exits non-zero and lists anything missing if server.js or lib/db.js has
// lost features that were deliberately restored. Born from the repeated
// "an older whole-file upload silently overwrote a newer one" problem
// (see RESTORE_NOTES.md). Not wired into `npm start` on purpose -- a false
// alarm should never be able to take the site down.
const fs = require('node:fs');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');
const db = fs.readFileSync(__dirname + '/lib/db.js', 'utf8');
const mustHaveInServer = [
  'requireCsrfHeader', 'verifyCsrfToken', 'CSRF_EXEMPT_POST_PATHS', 'csrfTokenFor',
  'isSubmissionRateLimited', 'db.pruneAndCountAttempts', 'db.recordRateLimitAttempt',
  'safeRedirectPath', 'pageSharedCheckin', 'pageRecap', 'pageSharedRecap', 'pageGearCare',
  'pageLeaderboard', 'pageAddToHomeScreen', 'isPublicSharePath', 'SITE_URL',
];
const mustHaveInDb = ['pruneAndCountAttempts', 'getYearInReview', 'getKudosLeaderboard'];
const missing = [
  ...mustHaveInServer.filter(s => !server.includes(s)).map(s => 'server.js: ' + s),
  ...mustHaveInDb.filter(s => !db.includes(s)).map(s => 'lib/db.js: ' + s),
];
// A raw (unvalidated) redirect target would reopen the open-redirect hole.
const rawRedirects = (server.match(/(?<!safeRedirectPath\()f\.redirect_to \|\|/g) || []).length;
if (rawRedirects) missing.push(`server.js: ${rawRedirects} unvalidated redirect_to use(s)`);
if (missing.length) {
  console.error('CANARY FAILED -- this looks like an OLDER file than expected. Missing:\n  - ' + missing.join('\n  - '));
  console.error('\nDo NOT deploy. Re-download the latest server.js / lib/db.js and check line counts (server.js should be ~7,200 lines).');
  process.exit(1);
}
console.log('canary OK: security + restored features present (' + server.split('\n').length + ' lines in server.js)');
