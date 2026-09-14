#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
function discoverTests(root = ROOT) {
  return fs.readdirSync(path.join(root, 'tests', 'source'))
    .filter(file => /^(?:packed-)?harness-v2-.*\.test\.cjs$/.test(file))
    .sort()
    .map(file => path.join(root, 'tests', 'source', file))
}

function run(options = {}) {
  const root = options.root || ROOT
  const files = discoverTests(root)
  if (!files.length) throw new Error('No harness v2 source tests were discovered')
  const result = (options.spawnSync || childProcess.spawnSync)(process.execPath,
    ['--test', '--test-concurrency=1', ...files],
    { cwd: root, env: options.env || process.env, stdio: options.stdio || 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`Harness v2 source tests terminated by ${result.signal}`)
  return Number.isInteger(result.status) ? result.status : 1
}

if (require.main === module) {
  try { process.exitCode = run() }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
module.exports = { discoverTests, run }
