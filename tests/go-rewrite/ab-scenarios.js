'use strict';

// The scenario names are the acceptance denominator. An implementation may
// report skip while its fixture is unavailable, but a skip is never converted
// to a pass in the report.
const scenarios = [
  { id: 'auth', name: 'register login logout', domains: ['identity'], requires: ['browser', 'node', 'go'] },
  { id: 'fishing', name: 'fish equip stow reopen and reconnect', domains: ['fishing', 'sse'], requires: ['browser', 'node', 'go'] },
  { id: 'multi-tab', name: 'multi tab stream lease', domains: ['sse', 'social'], requires: ['browser', 'node', 'go'] },
  { id: 'trade', name: 'two player trade invite cancel timeout duplicate confirm', domains: ['trade'], requires: ['browser', 'node', 'go'] },
  { id: 'market', name: 'market list partial fill cancel expiry', domains: ['economy', 'sse'], requires: ['browser', 'node', 'go'] },
  { id: 'workshop', name: 'workshop recast forge and chest', domains: ['workshop'], requires: ['browser', 'node', 'go'] },
  { id: 'sea', name: 'voyage party friends events autosetup', domains: ['sea_party', 'social'], requires: ['browser', 'node', 'go'] },
  { id: 'admin-mfa', name: 'admin MFA permissions config snapshot records', domains: ['admin'], requires: ['browser', 'node', 'go'] },
  { id: 'wiki', name: 'Wiki submit quota review delete and official update', domains: ['wiki'], requires: ['browser', 'node', 'go'] },
  { id: 'sse-init', name: 'SSE init and current snapshot', domains: ['sse'], requires: ['http', 'node', 'go'] },
  { id: 'sse-pagination-tail', name: 'SSE pagination tail and watermark retry', domains: ['sse'], requires: ['http', 'node', 'go'] },
  { id: 'sse-reconnect', name: 'SSE reconnect and expired session', domains: ['sse'], requires: ['http', 'node', 'go'] },
  { id: 'sse-slow', name: 'SSE slow connection and read failure', domains: ['sse'], requires: ['http', 'node', 'go'] },
  { id: 'sse-duplicate', name: 'SSE duplicate events and stale assets', domains: ['sse'], requires: ['http', 'node', 'go'] },
  { id: 'asset-revision', name: 'asset revision ordering against HTTP', domains: ['fishing', 'workshop', 'sse'], requires: ['http', 'node', 'go'] },
  { id: 'persistence', name: 'visible response matches authoritative database state', domains: ['all'], requires: ['http', 'node', 'go'] },
  { id: 'security', name: 'authentication CSRF permission and MFA gates', domains: ['identity', 'admin'], requires: ['http', 'node', 'go'] },
  { id: 'fixtures', name: 'controlled clock random and semantic fixture parity', domains: ['all'], requires: ['http', 'node', 'go'] },
];

module.exports = { scenarios };
