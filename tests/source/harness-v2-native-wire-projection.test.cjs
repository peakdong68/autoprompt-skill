'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { validateJsonSchema } = require('../../agents/codex/workflow/json-schema-validator.js')
const {
  OUTCOME_SCHEMA_ID,
  PROJECTION_VERSION,
  NativeWireProjectionError,
  nativeOutcomeDescriptionProjection,
} = require('../../scripts/harness-v2-native-wire-projection.cjs')

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/contracts/schemas/outcome.schema.json'), 'utf8'))
const record = { logicalRole: 'independent-reviewer', providerRole: 'ap-independent-checker' }
const hash = 'a'.repeat(64)

function output(code = 'PASS') {
  return {
    schemaVersion: '2.0.0', code, stateClass: 'terminal', runId: 'check-run-1',
    requestEnvelopeHash: hash, currentVersionHash: hash, completedResults: [], nextReadyWork: [],
    cause: { event: 'CHECK_COMPLETE', reason: 'The assigned check completed.', unblockPath: null },
    payloadSchemaId: 'autoprompt.independent-check.v2', payload: {}, recordedAt: '2026-09-08T00:00:00.000Z',
  }
}

function projection() {
  const value = nativeOutcomeDescriptionProjection(record, schema)
  assert.ok(value)
  return value
}

test('native checker wire projection derives only the controller-owned outcome description', () => {
  const value = projection()
  const raw = output()
  const rawText = JSON.stringify(raw)
  const canonical = value.toCanonical(raw)
  assert.equal(JSON.stringify(raw), rawText, 'raw native terminal bytes remain unchanged for its receipt/hash')
  assert.equal(Object.hasOwn(raw, 'description'), false, 'raw native terminal object remains byte-accounted and unchanged')
  assert.notEqual(canonical, raw)
  assert.equal(canonical.description, value.descriptionByCode.PASS)
  assert.equal(validateJsonSchema(value.wireSchema, raw).valid, true)
  assert.equal(validateJsonSchema(schema, canonical).valid, true)
  assert.equal(value.metadata.version, PROJECTION_VERSION)
  assert.equal(value.metadata.schemaId, OUTCOME_SCHEMA_ID)
  assert.equal(value.metadata.schemaSha256, crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'), 'projection binding is the exact canonical launch schema')
  assert.equal(value.wireSchema.required.includes('description'), false)
  assert.equal(schema.required.includes('description'), true)
})

test('native checker wire projection retains the fixed ordinary descriptions and the conditional verification-limited DONE description', () => {
  const value = projection()
  const branches = schema.allOf.find(clause => Array.isArray(clause.oneOf)).oneOf
  const expected = Object.fromEntries(branches.map(branch => [branch.properties.code.const,
    branch.properties.code.const === 'DONE'
      ? 'Every requested result passed its current required checks.'
      : branch.properties.description.const]))
  assert.equal(Object.keys(expected).length, 26)
  assert.deepEqual(value.descriptionByCode, expected)
  for (const branch of value.wireSchema.allOf.find(clause => Array.isArray(clause.oneOf)).oneOf) {
    assert.equal(branch.required.includes('description'), false)
    if (branch.properties.code.const === 'DONE') assert.deepEqual(branch.properties.description.enum, [
      'Every requested result passed its current required checks.',
      'The usable requested results are preserved, but the required verification evidence is incomplete.',
    ])
    else assert.equal(typeof branch.properties.description.const, 'string')
  }
})

test('native checker wire projection derives the matching conditional DONE description and rejects its conflicting form', () => {
  const value = projection()
  const ordinary = output('DONE')
  assert.equal(value.toCanonical(ordinary).description, 'Every requested result passed its current required checks.')
  const limited = output('DONE')
  limited.payload = { providerTerminal: { status: 'DONE_WITH_VERIFICATION_LIMITATIONS' } }
  assert.equal(value.toCanonical(limited).description,
    'The usable requested results are preserved, but the required verification evidence is incomplete.')
  assert.throws(() => value.toCanonical({ ...ordinary,
    description: 'The usable requested results are preserved, but the required verification evidence is incomplete.' }),
  error => error instanceof NativeWireProjectionError && error.code === 'NATIVE_WIRE_PROJECTION_INVALID')
  assert.throws(() => value.toCanonical({ ...limited,
    description: 'Every requested result passed its current required checks.' }),
  error => error instanceof NativeWireProjectionError && error.code === 'NATIVE_WIRE_PROJECTION_INVALID')
})

test('native checker wire projection bounds optional payload evidenceIds without changing canonical schema or raw output', () => {
  const schemaBefore = JSON.stringify(schema)
  const value = projection()
  for (const evidenceIds of [null, 'evidence-1', {}, [{ id: 'evidence-1' }], [null], [3], [''], ['evidence-1', ''], ['evidence-1', 'evidence-1']]) {
    const candidate = output()
    candidate.payload = { evidenceIds }
    assert.throws(() => value.toCanonical(candidate), error =>
      error instanceof NativeWireProjectionError && error.code === 'NATIVE_WIRE_PROJECTION_INVALID')
  }
  for (const evidenceIds of [undefined, [], ['evidence-1', 'a'.repeat(64)]]) {
    const candidate = output()
    candidate.payload = evidenceIds === undefined ? {} : { evidenceIds }
    const rawBefore = JSON.stringify(candidate)
    const canonical = value.toCanonical(candidate)
    assert.equal(JSON.stringify(candidate), rawBefore, 'raw output is not rewritten during projection')
    assert.equal(canonical.description, value.descriptionByCode.PASS)
  }
  assert.equal(JSON.stringify(schema), schemaBefore, 'canonical schema is not mutated by projection')
  assert.equal(nativeOutcomeDescriptionProjection({ ...record, logicalRole: 'worker', providerRole: 'ap-worker' }, schema), null)
})

test('native checker wire projection rejects contradictory, unknown, ambiguous, and incomplete wire output', () => {
  const value = projection()
  const wrongDescription = { ...output(), description: 'model-selected prose' }
  const unknownCode = { ...output('NOT_A_CANONICAL_CODE') }
  const missingPayload = output(); delete missingPayload.payload
  for (const candidate of [wrongDescription, unknownCode, missingPayload]) {
    assert.throws(() => value.toCanonical(candidate), error => error instanceof NativeWireProjectionError && error.code === 'NATIVE_WIRE_PROJECTION_INVALID')
  }
  const ambiguous = structuredClone(schema)
  const clause = ambiguous.allOf.find(item => Array.isArray(item.oneOf))
  clause.oneOf.push(structuredClone(clause.oneOf[0]))
  assert.throws(() => nativeOutcomeDescriptionProjection(record, ambiguous), error => error instanceof NativeWireProjectionError && error.code === 'NATIVE_WIRE_PROJECTION_INVALID')
})

test('native checker wire projection leaves probes and noncanonical schema/roles untouched', () => {
  assert.equal(nativeOutcomeDescriptionProjection({ ...record, logicalRole: 'worker', providerRole: 'ap-worker' }, schema), null)
  assert.equal(nativeOutcomeDescriptionProjection(record, { ...schema, $id: 'https://autoprompt.local/schemas/v2/probe.schema.json' }), null)
  assert.equal(nativeOutcomeDescriptionProjection({ logicalRole: 'diagnostic-probe', providerRole: 'ap-worker' }, { type: 'object', required: ['ok'], properties: { ok: { const: true } } }), null)
})
