'use strict'

// Hermes owns model calls, history, and tool-loop scheduling. This module only
// creates its private projection and hands a sealed launch specification to the
// owned wrapper. It deliberately does not translate a model API into a second
// agent loop.
const fs = require('node:fs')
const path = require('node:path')
const { privateDirectory, readBound, writePrivate } = require('../agents/reasonix/workflow/native.js')
const boundary = require('./harness-v2-tool-boundary.cjs')

const TOOLSET = 'autoprompt_owned'
const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const safe = (value, name) => {
  if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n]/.test(value)) throw new Error(`Invalid Hermes ${name}`)
  return value
}
const url = (value, name) => {
  safe(value, name)
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`Invalid Hermes ${name}`)
  return value
}
function sanitizeConnection(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Hermes connection must be an object')
  if (Object.keys(source).some(key => !['model', 'modelProvider', 'maxTokens', 'environment'].includes(key))) throw new Error('Hermes connection contains an unsupported capability')
  const result = {}
  for (const key of ['model', 'modelProvider']) if (source[key] !== undefined) result[key] = safe(source[key], key)
  if (source.maxTokens !== undefined) {
    if (!Number.isSafeInteger(source.maxTokens) || source.maxTokens <= 0) throw new Error('Invalid Hermes maxTokens')
    result.maxTokens = source.maxTokens
  }
  if (source.environment !== undefined) {
    if (!source.environment || typeof source.environment !== 'object' || Array.isArray(source.environment)) throw new Error('Hermes environment must be an object')
    if (Object.keys(source.environment).some(key => key !== 'HERMES_BASE_URL')) throw new Error('Hermes environment contains an unsupported capability')
    result.environment = {}
    if (source.environment.HERMES_BASE_URL !== undefined) result.environment.HERMES_BASE_URL = url(source.environment.HERMES_BASE_URL, 'base URL')
  }
  return result
}
function selectApiKey(baseUrl, credentials = {}) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Hermes credentials must be an object')
  let preferred = ['HERMES_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) preferred = ['OPENROUTER_API_KEY', 'HERMES_API_KEY', 'OPENAI_API_KEY']
    else if (host === 'api.openai.com' || host.endsWith('.openai.com')) preferred = ['OPENAI_API_KEY', 'HERMES_API_KEY', 'OPENROUTER_API_KEY']
  } catch {}
  for (const name of preferred) if (typeof credentials[name] === 'string' && credentials[name]) return credentials[name]
  return null
}
function requiredReasoning(baseUrl, effort) {
  if (effort === undefined) return undefined
  if (!EFFORTS.includes(effort)) throw Object.assign(new Error('Invalid Hermes reasoning effort'), { code: 'PROFILE_INVALID' })
  let host
  try { host = new URL(baseUrl).hostname.toLowerCase() } catch { throw Object.assign(new Error('Hermes reasoning requires an OpenRouter upstream URL'), { code: 'PROVIDER_UNSUPPORTED' }) }
  // Hermes 0.21.1 correctly withholds its OpenRouter-only reasoning body for
  // the reservation-private loopback relay.  The relay may restore this exact
  // controller binding only when the original upstream is OpenRouter.
  if (!(host === 'openrouter.ai' || host.endsWith('.openrouter.ai'))) return undefined
  // Hermes itself clamps its internal-only `ultra` level to the OpenAI
  // compatible wire maximum before it calls OpenRouter. The relay must bind
  // that same wire value rather than leak the internal spelling upstream.
  const wireEffort = effort === 'ultra' ? 'max' : effort
  return Object.freeze({ enabled: wireEffort !== 'none', effort: wireEffort })
}
function pluginFiles() {
  const root = path.join(__dirname, 'harness-v2-bridge', 'hermes')
  return { manifest: fs.readFileSync(path.join(root, 'plugin.yaml'), 'utf8'), source: fs.readFileSync(path.join(root, 'plugin.py'), 'utf8') }
}
function prepare(options) {
  const { home, sessionRoot, stateHome, toolBoundary, model, effort, continuationId, promptFile, hermesExecutable, pythonExecutable, apiKey, maxTokens } = options || {}
  for (const [name, value] of Object.entries({ home, sessionRoot, promptFile, hermesExecutable, pythonExecutable })) if (!path.isAbsolute(value || '')) throw new Error(`Hermes ${name} must be absolute`)
  if (stateHome !== undefined && !path.isAbsolute(stateHome || '')) throw new Error('Hermes stateHome must be absolute')
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error('Invalid Hermes reasoning effort')
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new Error('Invalid Hermes maxTokens')
  if (continuationId !== undefined && !/^[A-Za-z0-9_.:-]{1,256}$/.test(continuationId)) throw new Error('Invalid bound Hermes session identity')
  const current = boundary.loadBoundary(toolBoundary.policyPath, toolBoundary.policySha256)
  if (current.policy.provider !== 'hermes') throw new Error('Hermes tool policy provider mismatch')
  privateDirectory(home); privateDirectory(sessionRoot)
  // This file lives beside the receipt ledger, outside Hermes' writable
  // state.  The controller tool server appends exact args/result projections
  // only after committing each execution receipt.
  const toolProjectionPath = path.join(current.root, 'hermes-projections.jsonl')
  if (fs.existsSync(toolProjectionPath)) {
    if (readBound(toolProjectionPath).length !== 0) throw new Error('Hermes tool projection journal is not fresh')
  } else writePrivate(toolProjectionPath, '')
  const persistentHome = stateHome || home
  privateDirectory(persistentHome)
  const bundled = path.join(home, 'empty-bundled')
  const persistentPlugins = path.join(persistentHome, 'plugins', TOOLSET)
  privateDirectory(bundled); privateDirectory(persistentPlugins)
  const files = pluginFiles()
  const stablePrivate = (file, content) => {
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.nlink !== 1 || fs.readFileSync(file, 'utf8') !== content) throw new Error(`Hermes persistent file changed: ${path.basename(file)}`)
      return
    }
    writePrivate(file, content)
  }
  stablePrivate(path.join(persistentPlugins, 'plugin.yaml'), files.manifest)
  stablePrivate(path.join(persistentPlugins, '__init__.py'), files.source)
  // JSON is valid YAML and avoids a YAML serializer injecting host-controlled
  // tags. The narrow toolset is direct: tool_search would reintroduce Hermes'
  // bridge tools and cannot be allowed here.
  const providerName = 'autoprompt-owned'
  // Hermes 0.21.1 deliberately ignores legacy global output-cap settings. Its
  // documented named custom-provider projection applies `extra_body` to every
  // OpenAI-compatible request, which is the narrow native route for a sealed
  // controller cap. No other request override is projected.
  const config = { plugins: { enabled: [TOOLSET] }, model: { default: safe(model, 'model'), provider: providerName, base_url: url(options.baseUrl, 'base URL'), api_key: safe(apiKey, 'API key') }, providers: { [providerName]: { base_url: url(options.baseUrl, 'base URL'), api_key: safe(apiKey, 'API key'), model: safe(model, 'model'), ...(maxTokens === undefined ? {} : { extra_body: { max_tokens: maxTokens } }) } }, toolsets: [], tools: { tool_search: { enabled: false } }, auxiliary: { title_generation: { enabled: false } }, compression: { enabled: false }, telemetry: { shared_metrics: { enabled: false, send: false } }, agent: { max_turns: Number.isSafeInteger(options.maxTurns) ? options.maxTurns : 32, disabled_toolsets: [] } }
  stablePrivate(path.join(persistentHome, 'config.yaml'), JSON.stringify(config))
  const spec = { hermesExecutable, pythonExecutable, home: persistentHome, sessionRoot, promptFile, model, effort, continuationId: continuationId || null, receiptPath: current.receiptPath, toolProjectionPath,
    argv: ['chat', '--query-file', promptFile, '--oneshot', '--model', model, '--provider', providerName, '--toolsets', TOOLSET, '--ignore-rules', ...(effort ? ['--reasoning', effort] : []), ...(continuationId ? ['--resume', continuationId] : [])] }
  const specFile = path.join(home, 'autoprompt-hermes-launch.json')
  writePrivate(specFile, JSON.stringify(spec))
  return { specFile, env: { HERMES_HOME: persistentHome, HERMES_BUNDLED_PLUGINS: bundled, HERMES_ENABLE_PROJECT_PLUGINS: '0', HERMES_IGNORE_RULES: '1', AUTOPROMPT_TOOL_POLICY: current.policyPath, AUTOPROMPT_TOOL_POLICY_SHA256: current.policySha256, AUTOPROMPT_HERMES_TOOL_PROJECTIONS: toolProjectionPath, AUTOPROMPT_NODE: process.execPath, AUTOPROMPT_TOOL_SERVER: require.resolve('./harness-v2-tool-server.cjs') }, argv: [require.resolve('./harness-v2-bridge/hermes/owned-wrapper.cjs'), '--spec', specFile] }
}
module.exports = { TOOLSET, EFFORTS, sanitizeConnection, selectApiKey, requiredReasoning, prepare }
