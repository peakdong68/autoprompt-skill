'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { parseArgs } = require('../../bin/autoprompt.cjs')

test('public Hermes Linux closure parser requires a complete explicit portable runtime', () => {
  const venv = '/private/hermes-venv', source = '/private/hermes-source', python = '/usr/bin/python3', output = '/private/hermes-import'
  assert.deepEqual(parseArgs(['runtime', 'closure', 'prepare', 'hermes', '--venv', venv, '--source', source,
    '--python', python, '--output', output, '--arch', 'x86_64']), {
    command: 'runtime-closure', action: 'prepare', provider: 'hermes', venv, source, python, output, arch: 'x86_64',
  })
  assert.throws(() => parseArgs(['runtime', 'closure', 'prepare', 'hermes', '--venv', venv, '--source', source,
    '--output', output, '--arch', 'x86_64']), /requires --python/)
})
