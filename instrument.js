// instrument.js — initializes Sentry error reporting. This must be
// required BEFORE any other module in the app (server.js, db.js, etc.)
// so Sentry can patch things like the HTTP module as they load — that's
// why package.json's start script uses `node --require ./instrument.js
// server.js` instead of a plain require inside server.js itself.
//
// Env var required: SENTRY_DSN (get it from sentry.io after creating a
// project). If it's not set, this silently no-ops instead of crashing
// the app — so local development without a DSN still works fine.

const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Keep this low -- it samples performance traces, not errors.
    // Errors are always captured regardless of this setting. Free-tier
    // Sentry quotas are shared between errors and traces, so a low
    // number here leaves more room for the errors that actually matter.
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV || 'production',
  });
  console.log('[sentry] Error reporting enabled.');
} else {
  console.log('[sentry] SENTRY_DSN not set — error reporting disabled.');
}

module.exports = Sentry;
