'use strict'

// Retire only a byte-recognized v1 package registration. JSONC edits preserve
// unrelated packages, comments, encoding, and settings; the original document
// is retained privately and participates in the installer's rename transaction.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const settings = require('./install/prime-settings.cjs')
const { RootGuard } = require('./install/operation-lock.cjs')
const { ReasonixError, readBound, privateDirectory, sha256 } = require('../agents/reasonix/workflow/native.js')
const LEGACY_PACKAGE = 'autoprompt/packages/prime'

function conflict(message) { throw new ReasonixError('INSTALL_CONFLICT', message) }
function exists(file) {
  try { fs.lstatSync(file); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function plan(provider, root, migration, legacy) {
  if (provider !== 'prime') return null
  const guard = new RootGuard(root)
  const packageRoot = path.join(root, LEGACY_PACKAGE)
  let recognized = migration.some(item => path.relative(packageRoot, item.file) === '' ||
    item.file.startsWith(`${packageRoot}${path.sep}`))
  // An earlier private-v2 install may have already quarantined the package but
  // left its registration. Upgrade may repair that exact recognized state too.
  if (!recognized) {
    const relative = `${LEGACY_PACKAGE}/package.json`
    const quarantined = path.join(root, '.autoprompt-private', 'legacy-v1', 'prime', relative)
    if (exists(quarantined)) {
      const bytes = readBound(guard.assertExisting(quarantined))
      recognized = Array.isArray(legacy?.[relative]) && legacy[relative].includes(sha256(bytes))
    }
  }
  const file = path.join(root, 'settings.json')
  if (!recognized || !exists(file)) return null
  const before = readBound(guard.assertExisting(file))
  let inspected
  try { inspected = settings.inspect(before, packageRoot, root) }
  catch (error) { conflict(`Cannot safely retire the recognized legacy Prime package registration: ${error.message}`) }
  if (!inspected.packageMatches.length) return null
  let after = before
  for (const { index } of [...inspected.packageMatches].reverse()) after = settings.removeArrayItem(after, 'packages', index)
  if (settings.inspect(after, packageRoot, root).packageMatches.length) conflict('Legacy Prime registration removal did not converge')
  return { root, file, beforeSha256: sha256(before), after, mode: fs.lstatSync(file).mode & 0o777 }
}

function apply(planned, tx) {
  if (!planned) return undefined
  const { root, file, beforeSha256, after, mode } = planned
  const guard = new RootGuard(root)
  if (sha256(readBound(guard.assertExisting(file))) !== beforeSha256 || (fs.lstatSync(file).mode & 0o777) !== mode) {
    conflict('Prime settings changed after migration was planned')
  }
  const parent = path.join(root, '.autoprompt-private', 'legacy-v1', 'prime')
  privateDirectory(parent); guard.assertExisting(parent, 'directory')
  // A unique, newly created 0700 directory protects even a broadly readable
  // original settings file without changing its mode needed by rollback.
  const backupRoot = path.join(parent, `settings-${crypto.randomUUID()}`)
  fs.mkdirSync(backupRoot, { mode: 0o700 }); guard.assertExisting(backupRoot, 'directory')
  const backup = path.join(backupRoot, 'settings.json')
  const staged = tx.put('prime-settings.json', after)
  fs.chmodSync(staged, mode)
  tx.move(file, backup)
  if (sha256(readBound(guard.assertExisting(backup))) !== beforeSha256) conflict('Prime settings changed while retiring the registration')
  tx.move(staged, file)
  return backup
}

module.exports = { LEGACY_PACKAGE, plan, apply }
