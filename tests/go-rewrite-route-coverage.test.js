'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scanGoRoutes, compareCoverage, coverage } = require('../tools/go-rewrite/route-coverage');

test('route scanner ignores comments and strings, handles multiline literals, rejects dynamic registration', () => {
  const result = scanGoRoutes([
    '// r.Get("/comment", nil)',
    '/* r.Post("/block", nil) */',
    'message := `r.Get("/string", nil)`',
    'r.Get(',
    '  "/api/guides/{id}", handler)',
    'r.Post(`/api/config`, handler)',
    'r.Get(prefix + "/dynamic", handler)',
    'r.Route("/nested", nested)',
    'r.Method("GET", "/indirect", handler)',
  ].join('\n'));
  assert.deepEqual(result.routes, [
    { method: 'GET', path: '/api/guides/{id}', line: 4 },
    { method: 'POST', path: '/api/config', line: 6 },
  ]);
  assert.deepEqual(result.unresolved.map(item => item.reason), ['nonliteral-route-path', 'unsupported-router-call:Route', 'unsupported-router-call:Method']);
});

test('coverage uses unique exact method+path and excludes development routes', () => {
  const inventory = { routes: [
    { method: 'GET', path: '/api/same', line: 1 },
    { method: 'POST', path: '/api/same', line: 2 },
    { method: 'POST', path: '/api/dev', line: 3, developmentOnly: true },
  ], unresolved: [] };
  const result = compareCoverage(inventory, scanGoRoutes('r.Get("/api/same", h)\nr.Put("/api/same", h)'));
  assert.equal(result.denominator, 2);
  assert.equal(result.registeredCount, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.excludedDevelopmentCount, 1);
  assert.equal(result.missing[0].method, 'POST');
  assert.equal(result.additionalGoRoutes[0].method, 'PUT');
  assert.equal(result.contractAcceptance, 'not-evaluated');
  assert.equal(result.browserAcceptance, 'not-evaluated');
});

test('duplicate registrations and unresolved inventory methods cannot produce a clean report', () => {
  const result = compareCoverage({ routes: [{ method: 'REVIEW', path: '/unknown', line: 1 }] }, scanGoRoutes('r.Get("/api/me", h)\nr.Get("/api/me", other)'));
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.goRegistrationCount, 1);
  assert.equal(result.unresolved[0].reason, 'unresolved-http-method');
});

test('current Go registry covers every nondevelopment legacy method+path', () => {
  const result = coverage(path.join(__dirname, '..'));
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.registeredCount, result.denominator);
  assert(result.registered.some(route => route.path === '/api/wiki/guides/{id}'));
  assert(result.registered.some(route => route.method === 'GET' && route.path === '/events'));
});
