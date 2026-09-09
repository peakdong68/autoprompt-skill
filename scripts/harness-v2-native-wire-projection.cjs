'use strict'

// Native CLIs can reliably emit the controller's typed outcome fields, but the
// outcome description is controller-owned text selected solely by `code`.
// This is deliberately a closed projection: it applies only to the canonical
// outcome schema and an authenticated checker role, retains every supplied
// field's normal constraints, and adds no model-selected value.
const crypto = require('node:crypto')
const { validateJsonSchema } = require('../agents/codex/workflow/json-schema-validator.js')

const OUTCOME_SCHEMA_ID = 'https://autoprompt.local/schemas/v2/outcome.schema.json'
const CHECKER_ROLES = new Set([
  'plan-checker', 'independent-checker', 'independent-reviewer',
  'independent-tester', 'technical-decision-reviewer',
])
const PROJECTION_VERSION = 'native-outcome-description-v2'
const OUTCOME_CODE_COUNT = 26
const DONE = 'DONE'
const DONE_DESCRIPTION = 'Every requested result passed its current required checks.'
const LIMITED_DONE_DESCRIPTION = 'The usable requested results are preserved, but the required verification evidence is incomplete.'
const LIMITED_DONE_STATUS = 'DONE_WITH_VERIFICATION_LIMITATIONS'

class NativeWireProjectionError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'NativeWireProjectionError'
    this.code = 'NATIVE_WIRE_PROJECTION_INVALID'
    this.details = details
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function isCheckerOutcome(record, schema) {
  return Boolean(record && CHECKER_ROLES.has(record.logicalRole) &&
    record.providerRole === 'ap-independent-checker' &&
    schema && schema.$id === OUTCOME_SCHEMA_ID)
}

function requireOutcomeDescriptionBranches(schema) {
  const codes = schema?.properties?.code?.enum
  const clauses = Array.isArray(schema?.allOf) ? schema.allOf.filter(clause => Array.isArray(clause?.oneOf)) : []
  if (!Array.isArray(codes) || codes.length !== OUTCOME_CODE_COUNT ||
      new Set(codes).size !== OUTCOME_CODE_COUNT || !codes.every(code => typeof code === 'string') ||
      clauses.length !== 1 || clauses[0].oneOf.length !== OUTCOME_CODE_COUNT) {
    throw new NativeWireProjectionError('Canonical outcome schema does not have the exact controller-owned description branches')
  }
  const descriptions = new Map()
  for (const branch of clauses[0].oneOf) {
    const code = branch?.properties?.code?.const
    const description = branch?.properties?.description
    const required = branch?.required
    const ordinary = description?.const
    const limitedDone = code === DONE && Array.isArray(description?.enum) && description.enum.length === 2 &&
      new Set(description.enum).size === 2 && description.enum.includes(DONE_DESCRIPTION) && description.enum.includes(LIMITED_DONE_DESCRIPTION)
    if (typeof code !== 'string' || !(typeof ordinary === 'string' && ordinary || limitedDone) ||
        !Array.isArray(required) || !required.includes('code') || !required.includes('description') ||
        descriptions.has(code)) {
      throw new NativeWireProjectionError('Canonical outcome description branch is incomplete or ambiguous')
    }
    descriptions.set(code, limitedDone ? DONE_DESCRIPTION : ordinary)
  }
  if (descriptions.size !== OUTCOME_CODE_COUNT || codes.some(code => !descriptions.has(code))) {
    throw new NativeWireProjectionError('Canonical outcome codes do not have one unique controller-owned description')
  }
  return descriptions
}

function limitedDoneDescriptionRule(schema) {
  const matches = (schema?.allOf || []).filter(clause =>
    clause?.if?.properties?.code?.const === DONE &&
    Array.isArray(clause?.if?.required) && clause.if.required.includes('code') && clause.if.required.includes('payload') &&
    clause?.if?.properties?.payload?.required?.includes('providerTerminal') &&
    clause?.if?.properties?.payload?.properties?.providerTerminal?.required?.includes('status') &&
    clause?.if?.properties?.payload?.properties?.providerTerminal?.properties?.status?.const === LIMITED_DONE_STATUS &&
    clause?.then?.properties?.description?.const === LIMITED_DONE_DESCRIPTION &&
    clause?.then?.properties?.completedResults?.items?.properties?.description?.pattern === '^Requested result [1-9][0-9]* is preserved; required verification evidence is incomplete\\.$' &&
    clause?.else?.if?.properties?.code?.const === DONE &&
    clause?.else?.if?.required?.includes('code') &&
    clause?.else?.then?.properties?.description?.const === DONE_DESCRIPTION)
  if (matches.length !== 1) throw new NativeWireProjectionError('Canonical outcome schema lacks the exact verification-limited DONE description rule')
}

function descriptionForOutput(output, descriptions) {
  const limited = output?.code === DONE && output?.payload !== null && typeof output?.payload === 'object' && !Array.isArray(output.payload) &&
    output.payload.providerTerminal !== null && typeof output.payload.providerTerminal === 'object' && !Array.isArray(output.payload.providerTerminal) &&
    output.payload.providerTerminal.status === LIMITED_DONE_STATUS
  return limited ? LIMITED_DONE_DESCRIPTION : descriptions.get(output?.code)
}

function withoutRequiredDescription(required) {
  if (!Array.isArray(required) || !required.includes('description')) {
    throw new NativeWireProjectionError('Canonical outcome schema must require its controller-owned description')
  }
  return required.filter(name => name !== 'description')
}

function nativeOutcomeDescriptionProjection(record, schema) {
  if (!isCheckerOutcome(record, schema)) return null
  const descriptions = requireOutcomeDescriptionBranches(schema)
  limitedDoneDescriptionRule(schema)
  const wireSchema = structuredClone(schema)
  wireSchema.required = withoutRequiredDescription(wireSchema.required)
  const wireClauses = wireSchema.allOf.filter(clause => Array.isArray(clause?.oneOf))
  for (const branch of wireClauses[0].oneOf) branch.required = withoutRequiredDescription(branch.required)
  // Surface the existing evidence identity contract at the native correction
  // boundary. Presence and independence remain the final controller's decision.
  wireSchema.allOf.push({ properties: { payload: { properties: {
    evidenceIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
  } } } })
  const schemaSha256 = sha256(JSON.stringify(schema))
  const metadata = Object.freeze({ version: PROJECTION_VERSION, schemaId: schema.$id, schemaSha256 })
  const descriptionByCode = Object.freeze(Object.fromEntries(descriptions))

  function toCanonical(rawOutput) {
    const wireValidation = validateJsonSchema(wireSchema, rawOutput)
    if (!wireValidation.valid) {
      throw new NativeWireProjectionError('Native result does not match the bounded outcome wire schema', { errors: wireValidation.errors })
    }
    // `wireSchema` retains every per-code description const. Only the absent
    // top-level value can reach this branch, after all other fields validated.
    const output = structuredClone(rawOutput)
    if (!Object.hasOwn(output, 'description')) output.description = descriptionForOutput(output, descriptions)
    const canonicalValidation = validateJsonSchema(schema, output)
    if (!canonicalValidation.valid) {
      throw new NativeWireProjectionError('Controller-owned outcome description does not match the canonical schema', { errors: canonicalValidation.errors })
    }
    return output
  }

  return Object.freeze({
    wireSchema,
    metadata,
    descriptionByCode,
    toCanonical,
  })
}

module.exports = {
  OUTCOME_SCHEMA_ID,
  CHECKER_ROLES,
  PROJECTION_VERSION,
  NativeWireProjectionError,
  nativeOutcomeDescriptionProjection,
}
