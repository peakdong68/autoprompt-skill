'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const toml = require('@iarna/toml')

const MINIMUM_VERSION = '1.30.0'
const FORBIDDEN_TOOLS = Object.freeze([
  'task', 'fleet', 'run_skill', 'load_skill', 'activate_skill', 'create_skill',
  'skill_create', 'skill_edit', 'skill_delete', 'remember', 'forget',
  'use_capability', 'ask', 'update_goal', 'complete_step', 'todo_write', 'wait',
])
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

class ReasonixError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ReasonixError'
    this.code = code
    this.details = details
  }
}

function readBound(file) {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new ReasonixError('PAYLOAD_INVALID', `Expected one regular file: ${file}`)
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(fd)
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new ReasonixError('PAYLOAD_INVALID', 'File changed while opening')
    const bytes = fs.readFileSync(fd)
    const after = fs.lstatSync(file)
    if (opened.ino !== after.ino || opened.dev !== after.dev || after.size !== bytes.length || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new ReasonixError('PAYLOAD_INVALID', 'File changed while reading')
    }
    return bytes
  } finally { fs.closeSync(fd) }
}

function privateDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReasonixError('PAYLOAD_INVALID', `Private directory is linked or invalid: ${directory}`)
    if (path.dirname(directory) !== directory) privateDirectory(path.dirname(directory))
    return
  }
  privateDirectory(path.dirname(directory))
  fs.mkdirSync(directory, { mode: 0o700 })
}

function writePrivate(file, data) {
  privateDirectory(path.dirname(file))
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 })
}

function locateExecutable(env = process.env, requested) {
  const names = requested ? [requested] : (env.PATH || '').split(path.delimiter)
    .filter(Boolean).flatMap(directory => process.platform === 'win32'
      ? [path.join(directory, 'reasonix.exe')] : [path.join(directory, 'reasonix')])
  for (const name of names) {
    try {
      const resolved = fs.realpathSync.native(name)
      const bytes = readBound(resolved)
      fs.accessSync(resolved, fs.constants.X_OK)
      return { path: resolved, sha256: sha256(bytes) }
    } catch (error) { if (requested) throw error }
  }
  throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix CLI is not installed or is not executable')
}

function probeExecutable(options = {}) {
  const executable = locateExecutable(options.env, options.executable)
  const spawn = options.spawnSync || childProcess.spawnSync
  const version = spawn(executable.path, ['--version'], {
    env: options.env || process.env, encoding: 'utf8', shell: false, timeout: 15000, maxBuffer: 1024 * 1024,
  })
  const match = /\breasonix\s+v?(\d+)\.(\d+)\.(\d+)\b/i.exec(String(version.stdout || ''))
  const tuple = match && match.slice(1).map(Number)
  if (version.error || version.status !== 0 || !tuple || tuple[0] < 1 || (tuple[0] === 1 && tuple[1] < 30)) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', `Reasonix ${MINIMUM_VERSION} or later is required`)
  }
  const help = spawn(executable.path, ['run', '--help'], {
    env: options.env || process.env, encoding: 'utf8', shell: false, timeout: 15000, maxBuffer: 1024 * 1024,
  })
  const text = `${help.stdout || ''}\n${help.stderr || ''}`
  if (help.error || help.status !== 0 || !['--output-format', '--resume', '--dir', '--max-steps'].every(flag => text.includes(flag))) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix lacks the required streamed run and resume interface')
  }
  if (sha256(readBound(executable.path)) !== executable.sha256) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix executable changed during its probe')
  return Object.freeze({
    ...executable, version: tuple.join('.'), provider: 'reasonix',
    evidenceHashes: [sha256(String(version.stdout)), sha256(text)],
  })
}

// Copy model connection settings, never user hooks, plugins, agent prompts,
// permission overrides, or project config. Native Reasonix parses the emitted
// TOML itself; its model/provider semantics are preserved verbatim.
function connectionConfig(file) {
  const source = toml.parse(readBound(file).toString('utf8'))
  if (!Array.isArray(source.providers) || !source.providers.length) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Configure a Reasonix model provider before activation')
  }
  const providers = source.providers.map(provider => {
    const selected = {}
    for (const key of [
      'name', 'kind', 'base_url', 'chat_url', 'request_url', 'model', 'models', 'default',
      'api_key_env', 'headers', 'extra_body', 'context_window', 'max_tokens',
      'responses_mode', 'reasoning_effort',
    ]) if (Object.hasOwn(provider, key)) selected[key] = provider[key]
    if (typeof selected.name !== 'string' || !selected.name) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'A Reasonix provider has no name')
    return selected
  })
  return { ...(source.default_model ? { default_model: source.default_model } : {}), providers }
}

function renderConfig(options) {
  const { connection, systemPrompt, targetPath, scratchPath, readOnly } = options
  if (!connection || !Array.isArray(connection.providers) || !path.isAbsolute(targetPath) || !path.isAbsolute(scratchPath)) {
    throw new ReasonixError('PROFILE_INVALID', 'Native profile requires absolute target and scratch paths and a provider configuration')
  }
  return toml.stringify({
    ...connection,
    agent: { system_prompt: systemPrompt, max_subagent_depth: 1, max_subagent_concurrency: 1, max_parallel_writers: 1 },
    skills: { disable_implicit_invocation: true, paths: [] },
    permissions: {
      mode: 'allow',
      deny: [...FORBIDDEN_TOOLS, ...(readOnly && !options.checkerScratch ? ['write_file', 'edit_file', 'apply_patch'] : [])],
      allow_dynamic_bash: false,
    },
    sandbox: { workspace_root: readOnly ? scratchPath : targetPath, allow_write: [...(readOnly ? [] : [scratchPath]), ...(options.writableRoots || [])], bash: 'enforce', network: false },
    telemetry: { enabled: false },
  })
}

function parseTerminal(text) {
  try {
    const result = JSON.parse(text)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('not an object')
    return result
  } catch { throw new ReasonixError('CHILD_RESULT_INVALID', 'Reasonix must return one JSON object matching the assigned result schema') }
}

function nativeUsage(usage) {
  const input = usage.promptTokens
  const cached = usage.cacheHitTokens
  const output = usage.completionTokens
  const reasoning = usage.reasoningTokens || 0
  if (usage.estimated === true || ![input, cached, output, reasoning].every(value => Number.isSafeInteger(value) && value >= 0) || cached > input || reasoning > output) {
    throw new ReasonixError('PROVIDER_USAGE_UNKNOWN', 'Reasonix returned missing, estimated, or inconsistent token accounting')
  }
  return { noncachedInput: input - cached, cachedInput: cached, output, reasoning }
}

module.exports = { FORBIDDEN_TOOLS, MINIMUM_VERSION, ReasonixError, connectionConfig, inside, locateExecutable, nativeUsage, parseTerminal, privateDirectory, probeExecutable, readBound, renderConfig, sha256, writePrivate }
