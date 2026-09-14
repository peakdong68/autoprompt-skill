'use strict'

// Some native structured-output APIs implement a smaller JSON Schema dialect
// than the controller's canonical contracts. Keep their schema surface closed
// and portable: native validates one JSON string, then the host parses and
// validates the complete canonical value. This projection never fills fields,
// changes values, or accepts prose.
const crypto = require('node:crypto')

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

class CanonicalJsonWireError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CanonicalJsonWireError'
    this.code = 'NATIVE_WIRE_PROJECTION_INVALID'
  }
}

function canonicalJsonWireProjection(canonicalSchema, { provider, label = provider, version } = {}) {
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(provider) ||
      typeof version !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/u.test(version)) {
    throw new CanonicalJsonWireError('Canonical JSON wire projection identity is invalid')
  }
  if (typeof label !== 'string' || !label || label.length > 64) throw new CanonicalJsonWireError('Canonical JSON wire projection label is invalid')
  if (!object(canonicalSchema)) throw new CanonicalJsonWireError(`${label} canonical output schema must be an object`)
  let serialized
  try { serialized = JSON.stringify(canonicalSchema) } catch { throw new CanonicalJsonWireError(`${label} canonical output schema must be JSON`) }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
    throw new CanonicalJsonWireError(`${label} canonical output schema exceeds its private projection bound`)
  }
  const wireSchema = Object.freeze({
    type: 'object',
    properties: Object.freeze({ canonicalJson: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['canonicalJson']),
    additionalProperties: false,
  })
  const wireText = JSON.stringify(wireSchema)
  const invalid = message => { throw new CanonicalJsonWireError(message) }
  return Object.freeze({
    wireSchema,
    metadata: Object.freeze({
      version,
      canonicalSchemaSha256: crypto.createHash('sha256').update(serialized).digest('hex'),
      wireSchemaSha256: crypto.createHash('sha256').update(wireText).digest('hex'),
    }),
    toCanonical(rawOutput) {
      if (!object(rawOutput) || Object.keys(rawOutput).length !== 1 || typeof rawOutput.canonicalJson !== 'string' ||
          Buffer.byteLength(rawOutput.canonicalJson, 'utf8') > 1024 * 1024) {
        invalid(`${label} native output is not the exact canonicalJson wire envelope`)
      }
      let decoded
      try { decoded = JSON.parse(rawOutput.canonicalJson) } catch { invalid(`${label} canonicalJson wire value is not valid JSON`) }
      if (!object(decoded)) invalid(`${label} canonicalJson wire value must decode to one object`)
      return decoded
    },
  })
}

module.exports = { CanonicalJsonWireError, canonicalJsonWireProjection }
