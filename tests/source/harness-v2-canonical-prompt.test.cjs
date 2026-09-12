'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { validateJsonSchema } = require('../../agents/codex/workflow/json-schema-validator.js')
const schemas = Object.fromEntries(['role-report', 'outcome', 'route-recommendation', 'route-decision'].map(name => [name, require(`../../agents/contracts/schemas/${name}.schema.json`)]))

test('native canonical guidance keeps role mappings and excludes capability probe schemas', () => {
  for (const [logicalRole, route, name] of [
    ['worker', 'DIRECT', 'role-report'], ['run-owner', 'DIRECT', 'role-report'],
    ['run-owner', 'PRE_ROUTE', 'route-decision'], ['route-analyst', 'PRE_ROUTE', 'route-recommendation'],
    ...['plan-checker', 'independent-checker', 'independent-reviewer', 'independent-tester', 'technical-decision-reviewer'].map(role => [role, 'DIRECT', 'outcome']),
  ]) {
    const record = { logicalRole, route, runId: 'bound-run', workItemId: 'bound-assignment' }
    const result = core.nativeCompactCanonicalOutputContract(record, schemas[name])
    assert.match(result, /the final JSON object must be/)
    assert.doesNotMatch(result, /canonicalJson/)
    assert.match(result, /Do not copy schema metadata/)
    if (name !== 'route-recommendation' && name !== 'route-decision') assert.match(result, /bound-run/)
    for (const other of Object.keys(schemas).filter(key => key !== name)) assert.equal(core.nativeCompactCanonicalOutputContract(record, schemas[other]), '')
    assert.equal(core.nativeCompactCanonicalOutputContract(record, { type: 'object', properties: { ok: { const: true } } }), '')
  }
  assert.equal(core.nativeCompactCanonicalOutputContract({ logicalRole: 'unknown' }, schemas['role-report']), '')
})

test('checker descriptions come from exact schema literals for native and Codex transports', () => {
  const record = { logicalRole: 'independent-checker', canonicalAssignment: { checks: ['Exact full assigned check ID.'] } }
  const schema = structuredClone(schemas.outcome)
  const branches = schema.allOf.flatMap(clause => clause.oneOf || []).filter(branch => branch.properties?.description?.const)
  assert.ok(branches.length > 1)
  branches[0].properties.description.const = 'An exact schema-derived fixture description.'
  for (const prompt of [core.nativeCompactCanonicalOutputContract(record, schema), core.codexCompactCanonicalOutputContract(record, JSON.stringify(schema))]) {
    for (const branch of branches) assert.ok(prompt.includes(JSON.stringify(branch.properties.description.const)))
    assert.match(prompt, /completedResults:\[\]/)
    assert.match(prompt, /Exact full assigned check ID\./)
    assert.match(prompt, /do not invent fingerprint/)
    assert.match(prompt, /task-specific explanations in cause.reason/)
  }
})

test('native wire outcome guidance omits only the controller-owned description', () => {
  const record = { logicalRole: 'independent-reviewer', canonicalAssignment: { checks: ['Exact assigned checker obligation.'] } }
  const projected = core.nativeCompactCanonicalOutputContract(record, schemas.outcome, { omitControllerOwnedDescription: true })
  const defaultPrompt = core.nativeCompactCanonicalOutputContract(record, schemas.outcome)
  assert.doesNotMatch(projected, /,description,stateClass/)
  assert.doesNotMatch(projected, /For each outcome code, description must be/)
  assert.match(projected, /stateClass:"terminal"\|"intermediate"/)
  assert.match(projected, /CHECK_INCONCLUSIVE always uses stateClass:"intermediate"/)
  assert.match(projected, /PASS, FAIL, and RUNTIME_FAILURE always use stateClass:"terminal"/)
  assert.match(projected, /Exact assigned checker obligation\./)
  assert.match(defaultPrompt, /,description,stateClass/)
  assert.match(defaultPrompt, /For each outcome code, description must be/)
})

test('worker compact guidance preserves the resource preimage hash null-or-digest union', () => {
  const record = { logicalRole: 'worker', route: 'DIRECT', runId: 'bound-run', workItemId: 'bound-assignment' }
  const field = { ...schemas['role-report'].$defs.resource.properties.expectedPreimageHash, $defs: schemas['role-report'].$defs }
  assert.equal(validateJsonSchema(field, null).valid, true)
  assert.equal(validateJsonSchema(field, 'a'.repeat(64)).valid, true)
  assert.equal(validateJsonSchema(field, 'null').valid, false)
  const prompt = core.nativeCompactCanonicalOutputContract(record, schemas['role-report'])
  assert.match(prompt, /expectedPreimageHash must be a lowercase 64-hex SHA-256 string or the JSON literal null/)
  assert.match(prompt, /never the quoted string "null"/)
  assert.match(prompt, /filesChanged names only normalized paths relative to the repository root/u)
  assert.match(prompt, /do not use \.\/ or \.\.\/ prefixes, absolute paths, or private tool paths/u)
})

test('checker cause guidance exposes the actual field validator including the public lowercase-event failure', () => {
  const record = { logicalRole: 'independent-reviewer', canonicalAssignment: { checks: ['exact-diff'] } }
  for (const pattern of ['^[A-Z][A-Z0-9_]+$', '^CHECK_[A-Z]+$']) {
    const schema = structuredClone(schemas.outcome)
    schema.properties.cause.properties.event.pattern = pattern
    for (const prompt of [
      core.codexCompactCanonicalOutputContract(record, JSON.stringify(schema)),
      core.nativeCompactCanonicalOutputContract(record, schema),
      core.nativeCompactCanonicalOutputContract(record, schema, { omitControllerOwnedDescription: true }),
    ]) {
      const prefix = 'cause must match this exact field schema: '
      const line = prompt.split('\n').find(line => line.startsWith(prefix))
      assert.ok(line, 'both transports must show the constraint hidden by the compact cause placeholder')
      const displayed = JSON.parse(line.slice(prefix.length))
      assert.deepEqual(displayed, schema.properties.cause)
      assert.equal(validateJsonSchema(displayed, {
        event: 'independent_check_completed', reason: 'Checks executed.', unblockPath: null,
      }).valid, false, 'the actual public-run event is visibly invalid under the supplied contract')
      assert.equal(validateJsonSchema(displayed, {
        event: 'CHECK_COMPLETE', reason: 'Checks executed.', unblockPath: null,
      }).valid, true)
      assert.equal(validateJsonSchema(displayed, {
        event: 'CHECK_COMPLETE', reason: '', unblockPath: null,
      }).valid, false)
    }
  }
})
