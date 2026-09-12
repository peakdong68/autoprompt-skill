'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { canonicalAssignmentResources } = require('../../agents/codex/workflow/phase-budget.js')
const { createWindowsFilesystemCapture } = require('../../agents/codex/workflow/windows-filesystem.js')

test('native Windows assignment resources capture files and directory preimages through HANDLE authority', {
  skip: process.platform !== 'win32',
}, t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-native-resources-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'input'))
  const filename = path.join(directory, 'input', 'source.txt')
  fs.writeFileSync(filename, 'captured source\n')
  const capture = createWindowsFilesystemCapture()
  const assignment = ownership => canonicalAssignmentResources({
    request: { workItemId: 'check-1', ownership, manifests: [] },
    targetPath: directory, logicalRole: 'independent-checker', readOnly: true,
    enforcePreimages: false, additionalResources: [],
  })
  const resources = assignment(['input/source.txt', 'input'])
  assert.equal(resources.find(item => item.identity === 'input/source.txt').expectedPreimageHash,
    crypto.createHash('sha256').update('captured source\n').digest('hex'))
  assert.equal(resources.find(item => item.identity === 'input').expectedPreimageHash,
    capture.captureTree(path.join(directory, 'input')).hash)
  fs.linkSync(filename, path.join(directory, 'input', 'alias.txt'))
  assert.throws(() => assignment(['input']), error => error.code === 'PREIMAGE_UNSAFE')
})
