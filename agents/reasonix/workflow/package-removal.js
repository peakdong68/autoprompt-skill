'use strict'

// Retire complete receipt-owned paths before deleting bytes. The single journal
// rename is the commit point: interrupted publication rolls back, interrupted
// post-commit cleanup resumes without corrupting a live package.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { RootGuard } = require('../../../scripts/install/operation-lock.cjs')
const { ReasonixError, privateDirectory, readBound, sha256, writePrivate } = require('./native.js')
const RECEIPT = '.autoprompt-reasonix-v2.json'
const ENTRY = 'skills/autoprompt/SKILL.md'
const HASH = /^[a-f0-9]{64}$/
const GENERATION = /^reasonix-v2\.0\.0-[a-f0-9]{16}$/
const NAME = /^reasonix-remove-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exists = file => { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
function fail(message) { throw new ReasonixError('INSTALL_RECOVERY_REQUIRED', message) }
function relative(file) {
  return typeof file === 'string' && file && !/[\\:\0\r\n]/.test(file) && !path.isAbsolute(file) &&
    file.split('/').every(part => part && part !== '.' && part !== '..')
}
function allowedDirectories(files) {
  const result = new Set([''])
  for (const file of Object.keys(files)) {
    const parts = file.split('/'); parts.pop()
    while (parts.length) { result.add(parts.join('/')); parts.pop() }
  }
  return result
}
function checkTree(guard, root, files, partial = false) {
  const directories = allowedDirectories(files), seen = new Set()
  function visit(directory, prefix = '') {
    guard.assertExisting(directory, 'directory')
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const file = path.join(directory, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!directories.has(name)) fail(`Unowned removal directory retained: ${file}`)
        visit(file, name)
      } else {
        if (!Object.hasOwn(files, name) || sha256(readBound(guard.assertExisting(file))) !== files[name]) fail(`Changed or unowned removal file retained: ${file}`)
        seen.add(name)
      }
    }
  }
  visit(root)
  if (!partial && seen.size !== Object.keys(files).length) fail(`Removal inventory is incomplete: ${root}`)
}
function checkItem(guard, file, move, partial = false) {
  if (move.kind === 'directory') checkTree(guard, file, move.files, partial)
  else if (sha256(readBound(guard.assertExisting(file))) !== move.sha256) fail(`Changed removal file retained: ${file}`)
}
function emptyDirectories(guard, root) {
  guard.assertExisting(root, 'directory')
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`Unexpected removal entry retained: ${path.join(root, entry.name)}`)
    emptyDirectories(guard, path.join(root, entry.name))
  }
  fs.rmdirSync(root)
}
function validate(guard, journal) {
  if (!object(journal) || journal.schemaVersion !== 1 || journal.provider !== 'reasonix' || journal.root !== guard.rootReal ||
      !GENERATION.test(journal.generation || '') || !Array.isArray(journal.moves) || ![1, 3].includes(journal.moves.length)) fail('Invalid Reasonix removal journal')
  const expected = [[`.autoprompt-private/bundles/${journal.generation}`, 'bundle', 'directory'], [ENTRY, 'entry', 'file'], [RECEIPT, 'receipt', 'file']]
  journal.moves.forEach((move, index) => {
    if (!object(move) || move.from !== expected[index][0] || move.to !== expected[index][1] || move.kind !== expected[index][2]) fail('Removal journal targets an unowned path')
    if (move.kind === 'file') { if (!HASH.test(move.sha256 || '')) fail('Invalid removal file hash') }
    else if (!object(move.files) || !Object.keys(move.files).length || !Object.hasOwn(move.files, 'package.json') ||
      Object.entries(move.files).some(([file, hash]) => !relative(file) || !HASH.test(hash))) fail('Invalid removal inventory')
  })
  return journal
}
function inspectTransaction(guard, directory, journal) {
  const allowed = new Set(['prepared.json', 'committed.json', ...journal.moves.map(move => move.to)])
  for (const entry of fs.readdirSync(guard.assertExisting(directory, 'directory'))) {
    if (!allowed.has(entry)) fail(`Unowned transaction entry retained: ${path.join(directory, entry)}`)
  }
}
function rollback(guard, directory, journal) {
  inspectTransaction(guard, directory, journal)
  for (const move of [...journal.moves].reverse()) {
    const from = path.join(guard.root, move.from), retained = path.join(directory, move.to)
    if (exists(retained)) {
      checkItem(guard, retained, move)
      if (exists(from)) fail(`Cannot restore over a new file: ${from}`)
      privateDirectory(path.dirname(from)); guard.assertParent(from)
      fs.renameSync(retained, from)
    } else {
      if (!exists(from)) fail(`Removal recovery lost both copies: ${from}`)
      checkItem(guard, from, move)
    }
  }
  fs.unlinkSync(guard.assertExisting(path.join(directory, 'prepared.json')))
  fs.rmdirSync(directory)
}
function cleanup(guard, directory, journal) {
  inspectTransaction(guard, directory, journal)
  // Validate every remaining byte before deleting any; missing bytes are allowed
  // only after the durable commit because cleanup may already have progressed.
  for (const move of journal.moves) {
    const file = path.join(directory, move.to)
    if (exists(file)) checkItem(guard, file, move, true)
  }
  for (const move of journal.moves) {
    const retained = path.join(directory, move.to)
    if (!exists(retained)) continue
    if (move.kind === 'directory') {
      for (const [name, hash] of Object.entries(move.files)) {
        const file = path.join(retained, name)
        if (!exists(file)) continue
        if (sha256(readBound(guard.assertExisting(file))) !== hash) fail(`Removal file changed during cleanup: ${file}`)
        fs.unlinkSync(file)
      }
      emptyDirectories(guard, retained)
    } else fs.unlinkSync(guard.assertExisting(retained))
  }
  fs.unlinkSync(guard.assertExisting(path.join(directory, 'committed.json')))
  fs.rmdirSync(directory)
}
function recover(root) {
  const guard = new RootGuard(root), parent = path.join(root, '.autoprompt-private', 'transactions')
  if (!exists(parent)) return 0
  guard.assertExisting(parent, 'directory')
  let recovered = 0
  for (const name of fs.readdirSync(parent).filter(name => name.startsWith('reasonix-remove-'))) {
    if (!NAME.test(name)) fail(`Unknown Reasonix removal transaction retained: ${name}`)
    const directory = path.join(parent, name)
    guard.assertExisting(directory, 'directory')
    if (!fs.readdirSync(directory).length) { fs.rmdirSync(directory); recovered++; continue }
    const prepared = path.join(directory, 'prepared.json'), committed = path.join(directory, 'committed.json')
    if (exists(prepared) === exists(committed)) fail(`Removal journal needs manual recovery: ${directory}`)
    const journal = validate(guard, JSON.parse(readBound(guard.assertExisting(exists(committed) ? committed : prepared))))
    if (exists(committed)) cleanup(guard, directory, journal)
    else rollback(guard, directory, journal)
    recovered++
  }
  return recovered
}
function retire(installed, { includePublic = false } = {}) {
  const guard = new RootGuard(installed.root)
  const moves = [{ from: `.autoprompt-private/bundles/${installed.payloadGeneration}`, to: 'bundle', kind: 'directory',
    files: { ...installed.files, 'package.json': sha256(readBound(guard.assertExisting(path.join(installed.bundle, 'package.json')))) } }]
  if (includePublic) for (const [from, to] of [[ENTRY, 'entry'], [RECEIPT, 'receipt']]) {
    moves.push({ from, to, kind: 'file', sha256: sha256(readBound(guard.assertExisting(path.join(installed.root, from)))) })
  }
  const journal = validate(guard, { schemaVersion: 1, provider: 'reasonix', root: guard.rootReal, generation: installed.payloadGeneration, moves })
  for (const move of moves) checkItem(guard, path.join(installed.root, move.from), move)
  const directory = path.join(installed.root, '.autoprompt-private', 'transactions', `reasonix-remove-${crypto.randomUUID()}`)
  privateDirectory(directory)
  writePrivate(path.join(directory, 'prepared.json'), `${JSON.stringify(journal)}\n`)
  try {
    for (const move of moves) {
      const from = path.join(installed.root, move.from), to = path.join(directory, move.to)
      checkItem(guard, from, move); guard.assertParent(to)
      if (exists(to)) fail(`Removal destination already exists: ${to}`)
      fs.renameSync(from, to)
    }
    fs.renameSync(path.join(directory, 'prepared.json'), path.join(directory, 'committed.json'))
  } catch (error) {
    try { rollback(guard, directory, journal) }
    catch (rollbackError) { throw new ReasonixError('INSTALL_RECOVERY_REQUIRED', `${error.message}; removal rollback requires recovery: ${rollbackError.message}`, { recoveryPath: directory }) }
    throw error
  }
  try { cleanup(guard, directory, journal) }
  catch (error) {
    throw new ReasonixError('INSTALL_CLEANUP_REQUIRED', `Removal committed; retry the lifecycle command to finish private cleanup: ${error.message}`, { operationCommitted: true, recoveryPath: directory })
  }
}
module.exports = { recover, retire }
