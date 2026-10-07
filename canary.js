// canary.js -- run `node canary.js` before/after uploading files to GitHub.
// Exits non-zero and lists anything missing if server.js or lib/db.js has
// lost features that were deliberately restored. Born from the repeated
// "an older whole-file upload silently overwrote a newer one" problem
// (see RESTORE_NOTES.md). Not wired into `npm start` on purpose -- a false
// alarm should never be able to take the site down.
const fs = require('node:fs');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');
const db = fs.readFileSync(__dirname + '/lib/db.js', 'utf8');
const auth = fs.readFileSync(__dirname + '/lib/auth.js', 'utf8');
const storage = fs.readFileSync(__dirname + '/lib/storage.js', 'utf8');
const migrations = fs.existsSync(__dirname + '/lib/data-migrations.js') ? fs.readFileSync(__dirname + '/lib/data-migrations.js', 'utf8') : '';
const mustHaveInServer = [
  'requireCsrfHeader', 'verifyCsrfToken', 'CSRF_EXEMPT_POST_PATHS', 'csrfTokenFor',
  'isSubmissionRateLimited', 'db.pruneAndCountAttempts', 'db.recordRateLimitAttempt',
  'safeRedirectPath', 'pageSharedCheckin', 'pageRecap', 'pageSharedRecap', 'pageGearCare',
  'pageLeaderboard', 'pageAddToHomeScreen', 'isPublicSharePath', 'SITE_URL',
  'pageAdminInbox', 'pageAdminGrowTips', 'pageAdminRecipeEdit', 'pageAdminUserEdit',
  'wrapResponseWithGzip', 'isGenericRateLimited', 'storage.deletePhotos', '; Secure',
  // user-confirmed behaviors that must never be removed without asking (see HANDOFF.md "Protected behaviors")
  'renderEffectPills', '/strains?effect=', 'DO NOT REMOVE, SIMPLIFY, OR TURN THIS BACK INTO PLAIN TEXT',
  'renderCustomStrainPrompts', 'handleCustomStrainResolve', 'USER-CONFIRMED BEHAVIOR', 'DO NOT REMOVE OR WEAKEN THIS BLOCK',
];
const mustHaveInDb = ['listPendingCustomStrainPrompts', 'resolveCustomStrainPrompt', 'custom_strain_choices', 'pruneAndCountAttempts', 'getYearInReview', 'getKudosLeaderboard', 'bumpSessionVersion', 'listUserPhotoUrls', 'DELETE FROM forum_threads WHERE user_id', 'DELETE FROM grow_journal_entries WHERE user_id', 'DELETE FROM checkin_reactions WHERE checkin_id = ?'];
const mustHaveInAuth = ['setSessionVersionLookup', 'timingSafeEqual'];
const mustHaveInStorage = ['deletePhotos'];
const mustHaveInMigrations = ['STRAIN_MERGES', 'strains_audit_sync_2026_10_07', 'strain_merge_log'];
const missing = [
  ...mustHaveInServer.filter(s => !server.includes(s)).map(s => 'server.js: ' + s),
  ...mustHaveInDb.filter(s => !db.includes(s)).map(s => 'lib/db.js: ' + s),
  ...mustHaveInAuth.filter(s => !auth.includes(s)).map(s => 'lib/auth.js: ' + s),
  ...mustHaveInStorage.filter(s => !storage.includes(s)).map(s => 'lib/storage.js: ' + s),
  ...mustHaveInMigrations.filter(s => !migrations.includes(s)).map(s => 'lib/data-migrations.js: ' + s),
  ...(db.includes("require('./data-migrations')") ? [] : ['lib/db.js: data-migrations is not wired into init()']),
];
// Menu placement the user asked for: Cleaning & Gear Care belongs in Discover, not Growing.
{
  const disc = server.indexOf("title: 'Discover'"), gear = server.indexOf("t: 'Cleaning & Gear Care'"), nextSec = server.indexOf("title: 'Recipes'", disc);
  if (!(disc > -1 && gear > disc && gear < nextSec)) missing.push("server.js: 'Cleaning & Gear Care' is no longer in the More menu's Discover section");
}
// A raw (unvalidated) redirect target would reopen the open-redirect hole.
const rawRedirects = (server.match(/(?<!safeRedirectPath\()f\.redirect_to \|\|/g) || []).length;
if (rawRedirects) missing.push(`server.js: ${rawRedirects} unvalidated redirect_to use(s)`);
// Wrong-folder check. GitHub's web uploader puts a file in the repo ROOT unless you drag in the folder it belongs to.
// Files that must live in lib/ and files that must live at the root:
{
  const LIB_FILES = ['db.js', 'auth.js', 'storage.js', 'data-migrations.js', 'render.js', 'body.js', 'chat.js', 'mockdata.js', 'geodispensaries.js'];
  for (const f of LIB_FILES) {
    const inLib = fs.existsSync(__dirname + '/lib/' + f), inRoot = fs.existsSync(__dirname + '/' + f);
    if (inRoot) missing.push(`${f} is in the repo ROOT -- it belongs in lib/${f}. Move it (GitHub: open the file > pencil > change the name to lib/${f} > Commit).`);
    if (!inLib && f === 'data-migrations.js') missing.push('lib/data-migrations.js is MISSING (the app requires it at startup)');
  }
  // Only meaningful inside a FULL repo checkout (the unzipped upload folder has no package.json).
  if (fs.existsSync(__dirname + '/package.json')) {
    for (const f of ['server.js', 'seed.js', 'instrument.js']) {
      if (!fs.existsSync(__dirname + '/' + f)) missing.push(`${f} is missing from the repo root`);
      if (fs.existsSync(__dirname + '/lib/' + f)) missing.push(`${f} is inside lib/ -- it belongs in the repo root.`);
    }
  }
}
try { require(__dirname + '/lib/data-migrations').assertValidMerges(); }
catch (e) { missing.push('lib/data-migrations.js: ' + e.message); }
if (missing.length) {
  console.error('CANARY FAILED -- something is missing, outdated, or in the wrong folder:\n  - ' + missing.join('\n  - '));
  console.error('\nDo NOT deploy until this is fixed. (If a file is simply old, re-download the latest; server.js should be ~7,500 lines.)');
  process.exit(1);
}
console.log('canary OK: security + restored features present (' + server.split('\n').length + ' lines in server.js)');
