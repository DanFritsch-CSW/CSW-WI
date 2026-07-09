// DISABLED — was a temporary diagnostic to pull Front channel IDs (2026-07-08).
// Channel IDs have been captured; this endpoint served no further purpose and
// was returning all Front channels (including private ones) to any caller.
// Safe to delete this file entirely on next commit touching netlify/functions.
exports.handler = async function () {
  return {
    statusCode: 410,
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ error: 'disabled' }),
  };
};
