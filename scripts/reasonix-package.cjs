#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RootGuard, acquire, release } = require('./install/operation-lock.cjs')
const { ReasonixError, readBound, privateDirectory, sha256, writePrivate } = require('../agents/reasonix/workflow/native.js')
const ROOT = path.resolve(__dirname, '..')
const RECEIPT = '.autoprompt-reasonix-v2.json'
const SHIM = '---\nname: autoprompt\ndescription: "Start explicitly requested Autoprompt v2 work in Reasonix."\ninvocation: manual\n---\n\nRun `autoprompt activate reasonix --target <absolute-project-path> -- <mission>` in a terminal. The launcher starts the private v2 controller. Loading this skill alone never starts or resumes work.\n'
const TREES = ['agents/reasonix', 'agents/codex', 'agents/contracts', 'node_modules/@iarna/toml']
const BUNDLE_PACKAGE = '{"name":"@autoprompt-skill/reasonix-runtime","version":"2.0.0","private":true,"type":"commonjs"}\n'
const FILES = ['scripts/local-only-safety.cjs', 'scripts/reasonix-package.cjs', 'scripts/reasonix-configure.cjs', 'scripts/install/operation-lock.cjs']

function walk(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new ReasonixError('PAYLOAD_INVALID', `Linked runtime entry: ${relative}`)
    if (entry.isDirectory()) return walk(file, relative)
    if (!entry.isFile()) throw new ReasonixError('PAYLOAD_INVALID', `Non-file runtime entry: ${relative}`)
    return [relative]
  })
}

function sourcePath(root, file) {
  const prefix = 'node_modules/@iarna/toml'
  return file.startsWith(prefix) ? path.join(path.dirname(require.resolve('@iarna/toml/package.json', { paths: [root] })), file.slice(prefix.length)) : path.join(root, file)
}

function sourceInventory(root = ROOT) {
  const files = [...FILES, ...TREES.flatMap(tree => walk(sourcePath(root, tree)).map(file => `${tree}/${file}`))].sort()
  const hashes = Object.fromEntries(files.map(file => [file, sha256(readBound(sourcePath(root, file)))]))
  const digest = sha256(JSON.stringify(hashes))
  return { schemaVersion: 2, provider: 'reasonix', contractVersion: '2.0.0', payloadGeneration: `reasonix-v2.0.0-${digest.slice(0, 16)}`, payloadDigest: digest, files: hashes }
}

function resolveRoot(env = process.env) {
  return path.resolve(env.AUTOPROMPT_INSTALL_ROOT || env.REASONIX_HOME ||
    (process.platform === 'win32' ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'reasonix') : path.join(env.HOME || os.homedir(), '.reasonix')))
}

function readReceipt(root) {
  const receipt = JSON.parse(readBound(path.join(root, RECEIPT)).toString('utf8'))
  if (receipt.schemaVersion !== 2 || receipt.provider !== 'reasonix' ||
      !/^reasonix-v2\.0\.0-[a-f0-9]{16}$/.test(receipt.payloadGeneration || '') ||
      !receipt.files || sha256(JSON.stringify(receipt.files)) !== receipt.payloadDigest ||
      receipt.payloadGeneration !== `reasonix-v2.0.0-${receipt.payloadDigest.slice(0, 16)}`) {
    throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix installation receipt is invalid')
  }
  for (const file of Object.keys(receipt.files)) {
    if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix receipt path escapes the bundle')
    }
  }
  return receipt
}

function bundlePath(root, receipt) { return path.join(root, '.autoprompt-private', 'bundles', receipt.payloadGeneration) }

function verify(root) {
  const guard = new RootGuard(root)
  const receipt = readReceipt(root)
  const bundle = bundlePath(root, receipt)
  guard.assertExisting(bundle, 'directory')
  if (readBound(path.join(bundle, 'package.json')).toString('utf8') !== BUNDLE_PACKAGE) throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix package metadata changed')
  const actual = walk(bundle).filter(file => file !== 'package.json')
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(receipt.files).sort())) throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix bundle inventory drifted')
  for (const [file, hash] of Object.entries(receipt.files)) {
    const target = guard.assertExisting(path.join(bundle, file))
    if (sha256(readBound(target)) !== hash) throw new ReasonixError('PAYLOAD_INVALID', `Reasonix payload changed: ${file}`)
  }
  const shim = guard.assertExisting(path.join(root, 'skills', 'autoprompt', 'SKILL.md'))
  if (readBound(shim).toString('utf8') !== SHIM) throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix entry skill changed')
  return { status: 'verified', root, bundle, ...receipt }
}

function install(root, sourceRoot = ROOT) {
  if (root === path.parse(root).root) throw new ReasonixError('INSTALL_ROOT_INVALID', 'Cannot install at a filesystem root')
  privateDirectory(root)
  const guard = new RootGuard(root)
  const lease = acquire(root, 'install-reasonix-v2', { guard })
  try {
    const receipt = sourceInventory(sourceRoot)
    const existing = fs.existsSync(path.join(root, RECEIPT)) ? verify(root) : null
    if (existing?.payloadDigest === receipt.payloadDigest) return existing
    assertNoResumableActivation(root)
    const shim = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
    const legacy = require('../agents/reasonix/legacy-v1-hashes.json')
    const migrate = []
    for (const [relative, hash] of Object.entries(legacy)) {
      const file = path.join(root, relative)
      if (!fs.existsSync(file)) continue
      guard.assertExisting(file)
      const bytes = readBound(file).toString('utf8').replaceAll('\r\n', '\n')
      if (file === shim && bytes === SHIM) continue
      if (sha256(bytes) !== hash) throw new ReasonixError('INSTALL_CONFLICT', `Changed legacy file requires manual migration: ${file}`)
      const quarantined = path.join(root, '.autoprompt-private', 'legacy-v1', path.relative(root, file))
      if (fs.existsSync(quarantined)) throw new ReasonixError('INSTALL_CONFLICT', 'Legacy quarantine already exists')
      migrate.push(file)
    }
    const bundle = bundlePath(root, receipt)
    if (fs.existsSync(bundle)) throw new ReasonixError('INSTALL_CONFLICT', 'An unregistered Reasonix bundle already exists')
    const stage = `${bundle}.stage-${require('node:crypto').randomUUID()}`
    const temporary = path.join(root, `${RECEIPT}.tmp-${require('node:crypto').randomUUID()}`)
    const previousReceipt = existing ? readBound(path.join(root, RECEIPT)) : null
    const moved = []
    let published = false
    let shimCreated = false
    let receiptPublished = false
    let verified
    try {
      privateDirectory(stage)
      for (const [file, hash] of Object.entries(receipt.files)) {
        const bytes = readBound(sourcePath(sourceRoot, file))
        if (sha256(bytes) !== hash) throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix source changed during installation')
        writePrivate(path.join(stage, file), bytes)
      }
      writePrivate(path.join(stage, 'package.json'), BUNDLE_PACKAGE)
      guard.assertExisting(stage, 'directory')
      guard.assertParent(bundle)
      fs.renameSync(stage, bundle)
      published = true
      // Quarantine only byte-matched v1 files; preserve config and unrelated skills.
      const quarantine = path.join(root, '.autoprompt-private', 'legacy-v1')
      for (const file of migrate) {
        const destination = path.join(quarantine, path.relative(root, file))
        privateDirectory(path.dirname(destination))
        if (fs.existsSync(destination)) throw new ReasonixError('INSTALL_CONFLICT', 'Legacy quarantine already exists')
        guard.assertExisting(file)
        fs.renameSync(file, destination)
        moved.push({ file, destination })
      }
      if (!fs.existsSync(shim)) { writePrivate(shim, SHIM); shimCreated = true }
      writePrivate(temporary, `${JSON.stringify(receipt, null, 2)}\n`)
      fs.renameSync(temporary, path.join(root, RECEIPT))
      receiptPublished = true
      verified = verify(root)
    } catch (error) {
      try {
        if (receiptPublished) {
          if (previousReceipt) {
            writePrivate(temporary, previousReceipt)
            fs.renameSync(temporary, path.join(root, RECEIPT))
          } else fs.unlinkSync(guard.assertExisting(path.join(root, RECEIPT)))
        }
        if (fs.existsSync(temporary)) fs.unlinkSync(guard.assertExisting(temporary))
        if (shimCreated) fs.unlinkSync(guard.assertExisting(shim))
        for (const { file, destination } of moved.reverse()) {
          if (fs.existsSync(file)) throw new ReasonixError('INSTALL_CONFLICT', `Cannot restore legacy file over a new file: ${file}`)
          fs.renameSync(guard.assertExisting(destination), file)
        }
        const abandoned = published ? bundle : stage
        if (fs.existsSync(abandoned)) {
          guard.assertExisting(abandoned, 'directory')
          // Only remove our transaction's known files, never an unexpected entry.
          for (const file of walk(abandoned)) {
            if (file !== 'package.json' && !Object.hasOwn(receipt.files, file)) throw new ReasonixError('INSTALL_CONFLICT', `Unexpected staged file: ${file}`)
            guard.assertExisting(path.join(abandoned, file))
          }
          fs.rmSync(abandoned, { recursive: true })
        }
      } catch (rollbackError) {
        throw new ReasonixError('INSTALL_RECOVERY_REQUIRED', `Reasonix installation failed: ${error.message}; rollback needs attention: ${rollbackError.message}`)
      }
      throw error
    }
    if (existing) removeBundle(existing)
    return verified
  } finally { release(lease) }
}

function assertNoResumableActivation(root) {
  const activations = path.join(root, '.autoprompt-private', 'activations')
  if (!fs.existsSync(activations)) return
  const guard = new RootGuard(root)
  guard.assertExisting(activations, 'directory')
  for (const directory of fs.readdirSync(activations)) {
    const recordFile = path.join(activations, directory, 'activation.json')
    if (!fs.existsSync(recordFile)) continue
    guard.assertExisting(recordFile)
    const record = JSON.parse(readBound(recordFile))
    if (record.status === 'active' || record.outcome === 'WAITING_USER') throw new ReasonixError('ACTIVE_RUN', 'Finish or cancel the resumable Reasonix run before replacing its runtime')
  }
}

function removeBundle(installed) {
  const guard = new RootGuard(installed.root)
  for (const [file, hash] of Object.entries(installed.files)) {
    const target = guard.assertExisting(path.join(installed.bundle, file))
    if (sha256(readBound(target)) !== hash) throw new ReasonixError('PAYLOAD_INVALID', 'Old bundle changed before removal')
  }
  for (const file of Object.keys(installed.files)) fs.unlinkSync(guard.assertExisting(path.join(installed.bundle, file)))
  fs.unlinkSync(guard.assertExisting(path.join(installed.bundle, 'package.json')))
  const removeEmpty = directory => {
    guard.assertExisting(directory, 'directory')
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) removeEmpty(path.join(directory, entry.name))
    if (!fs.readdirSync(directory).length) fs.rmdirSync(directory)
  }
  removeEmpty(installed.bundle)
}

function uninstall(root) {
  if (!fs.existsSync(path.join(root, RECEIPT))) return { status: 'not-installed', root }
  const lease = acquire(root, 'uninstall-reasonix-v2')
  try {
    const installed = verify(root)
    assertNoResumableActivation(root)
    removeBundle(installed)
    fs.unlinkSync(path.join(root, 'skills', 'autoprompt', 'SKILL.md'))
    fs.unlinkSync(path.join(root, RECEIPT))
    return { status: 'uninstalled', root, runHistoryRetained: true }
  } finally { release(lease) }
}

function run(argv = process.argv.slice(2), options = {}) {
  const [action, flag, value] = argv
  if (!['install', 'verify', 'doctor', 'uninstall', 'plan'].includes(action) ||
      (flag !== undefined && (flag !== '--root' || !path.isAbsolute(value || '') || argv.length !== 3))) {
    throw new ReasonixError('INVALID_INPUT', 'Use reasonix-package.cjs <install|verify|doctor|uninstall|plan> [--root <absolute-path>]')
  }
  const root = value || resolveRoot(options.env)
  if (action === 'plan') return sourceInventory(options.sourceRoot)
  if (action === 'install') return install(root, options.sourceRoot)
  if (action === 'uninstall') return uninstall(root)
  return verify(root)
}

if (require.main === module) {
  try { const result = run(); process.stdout.write(`${JSON.stringify({ status: result.status, root: result.root, payloadGeneration: result.payloadGeneration })}\n`) }
  catch (error) { process.stderr.write(`${error.code || 'RUNTIME_FAILURE'}: ${error.message}\n`); process.exitCode = 1 }
}
module.exports = { RECEIPT, ROOT, SHIM, bundlePath, install, readReceipt, resolveRoot, run, sourceInventory, uninstall, verify, walk }
