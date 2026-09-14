'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { normalizeVersion, compareVersions } = require('../../bin/autoprompt.cjs')

test('updater preserves prerelease identity and follows release precedence', () => {
  const releases = ['2.0.0-alpha', '2.0.0-alpha.1', '2.0.0-alpha.beta', '2.0.0-beta', '2.0.0-beta.2', '2.0.0-beta.11', '2.0.0-rc.1', '2.0.0']
  for (let index = 1; index < releases.length; index++) {
    assert.equal(compareVersions(releases[index], releases[index - 1]), 1)
    assert.equal(compareVersions(releases[index - 1], releases[index]), -1)
  }
  assert.equal(normalizeVersion('v2.0.0-beta.1+build.42'), '2.0.0-beta.1+build.42')
  assert.equal(compareVersions('2.0.0+one', '2.0.0+two'), 0)
  assert.equal(compareVersions('2.0.0-beta.1', '1.99.99'), 1)
  assert.equal(compareVersions('2.0.0-beta-2', '2.0.0-beta-1'), 1)
  for (const invalid of ['2.0.0-01', '02.0.0', '2.0', '2.0.0-', '2.0.0+']) assert.equal(normalizeVersion(invalid), '')
})
