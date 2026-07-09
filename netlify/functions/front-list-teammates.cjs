// DISABLED — was a temporary diagnostic to pull Front teammate IDs (2026-07-08).
// Teammate IDs have been captured; this endpoint served no further purpose and
// was returning all 87 teammates' emails/admin status to any unauthenticated caller.
// Safe to delete this file entirely on next commit touching netlify/functions.
exports.handler = async function () {
  return {
    statusCode: 410,
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ error: 'disabled' }),
  };
};
