'use strict'

// Frozen migration inputs must survive new commits and shallow/archive builds.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '../fixtures/harness-v1')
const provenance = require('../fixtures/harness-v1/provenance.json')

function readLegacyFixture(relative) {
  if (!Object.hasOwn(provenance.files, relative)) throw new Error(`Unknown historic fixture: ${relative}`)
  const bytes = fs.readFileSync(path.join(root, relative))
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== provenance.files[relative]) {
    throw new Error(`Historic fixture bytes changed: ${relative}`)
  }
  return bytes
}

module.exports = { readLegacyFixture }
