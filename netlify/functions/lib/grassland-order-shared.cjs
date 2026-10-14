'use strict'

// DEPRECATED 2026-10-13: this file was the single-customer (Grassland-only)
// shared module. It has been split into:
//   - lib/order-agent-common.cjs  (shared plumbing + dispatcher)
//   - lib/adapters/grassland.cjs  (everything Grassland-specific)
//   - lib/adapters/richelieu.cjs  (the new second customer)
// Nothing in this repo requires this file anymore as of that split.
// Left in place (not deleted) rather than removed outright — re-exports the
// new module so anything that still somehow requires this old path keeps
// working, but new code should require order-agent-common.cjs directly.

module.exports = require('./order-agent-common.cjs')
