'use strict'

const fs = require('node:fs')
const path = require('node:path')

class GrokSandboxError extends Error { constructor(code, message) { super(message); this.name = 'GrokSandboxError'; this.code = code } }
const fail = (code, message) => { throw new GrokSandboxError(code, message) }
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
const contained = (root, value) => value === root || (value.startsWith(`${root}${path.sep}`))
function roots(value, label) {
  if (!Array.isArray(value) || !value.length || value.some(item => !absolute(item) || !fs.existsSync(item) || !fs.statSync(item).isDirectory())) fail('GROK_SANDBOX_CONFIG_INVALID', `Invalid ${label}`)
  return [...new Set(value)].sort((left, right) => left.length - right.length || left.localeCompare(right))
}
function destinationParents(file) {
  const result = []; let cursor = path.dirname(file)
  while (cursor !== '/') { result.push(cursor); cursor = path.dirname(cursor) }
  return result.reverse()
}
function createSandboxLaunch(options = {}) {
  const required = ['root', 'sessionHome', 'grokExecutable', 'nodeExecutable', 'model', 'proxyToken', 'relayToken', 'cwd', 'toolRuntimeRoot', 'toolPolicyPath', 'toolPolicySha256']
  const textRequired = new Set(['model', 'proxyToken', 'relayToken', 'toolPolicySha256'])
  for (const name of required) if ((!textRequired.has(name) && !absolute(options[name])) || (textRequired.has(name) && (typeof options[name] !== 'string' || !options[name]))) fail('GROK_SANDBOX_CONFIG_INVALID', `Invalid ${name}`)
  if (!/^[a-f0-9]{64}$/u.test(options.toolPolicySha256) || !options.relayStdin || typeof options.relayStdin.on !== 'function' || !fs.existsSync('/usr/bin/bwrap') || !fs.statSync(options.root).isDirectory() || !fs.statSync(options.sessionHome).isDirectory() || !fs.statSync(options.grokExecutable).isFile() || !fs.statSync(options.nodeExecutable).isFile() || !fs.statSync(options.toolRuntimeRoot).isDirectory() || !fs.statSync(options.toolPolicyPath).isFile()) fail('GROK_SANDBOX_CONFIG_INVALID', 'Sandbox mount sources are unavailable')
  // The native CLI never needs a direct task mount: all task access travels
  // through the host-owned MCP relay.  Callers may supply a private native
  // projection so project instruction files cannot be auto-discovered.
  const readOnlyRoots = roots(options.nativeReadOnlyRoots || options.readOnlyRoots, 'readOnlyRoots'), writableRoots = roots(options.nativeWritableRoots || options.writableRoots, 'writableRoots')
  const issuedCalls = options.issuedCalls === undefined ? [] : options.issuedCalls
  if (!Array.isArray(issuedCalls) || Buffer.byteLength(JSON.stringify(issuedCalls)) > 4 * 1024 * 1024) fail('GROK_SANDBOX_CONFIG_INVALID', 'Issued call history is invalid')
  if (!absolute(options.cwd) || ![...readOnlyRoots, ...writableRoots].some(root => contained(root, options.cwd)) || writableRoots.some(write => !readOnlyRoots.some(read => contained(read, write))) || writableRoots.some((left, index) => writableRoots.slice(index + 1).some(right => contained(left, right) || contained(right, left)))) fail('GROK_SANDBOX_CONFIG_INVALID', 'Assigned sandbox paths are invalid')
  const bridge = path.resolve(__dirname), insideBridge = '/opt/autoprompt-grok', insideRoot = '/run/autoprompt', insideSessionHome = '/autoprompt/session', insideGrok = '/opt/grok/grok', insideRuntime = '/opt/autoprompt-runtime', insidePolicy = `${insideRoot}/tool-policy.json`
  const env = {
    HOME: insideSessionHome, GROK_HOME: insideSessionHome, XDG_CONFIG_HOME: `${insideSessionHome}/config`, XDG_DATA_HOME: `${insideSessionHome}/data`, XDG_STATE_HOME: `${insideSessionHome}/state`, XDG_CACHE_HOME: `${insideSessionHome}/cache`,
    AUTOPROMPT_GROK_EXECUTABLE: insideGrok, AUTOPROMPT_GROK_CWD: options.cwd, AUTOPROMPT_GROK_MODEL: options.model,
    AUTOPROMPT_GROK_PROXY_TOKEN: options.proxyToken, AUTOPROMPT_GROK_RELAY_TOKEN: options.relayToken, AUTOPROMPT_GROK_RELAY_FD: '0', AUTOPROMPT_GROK_TOOL_BOUNDARY: `${insideRuntime}/scripts/harness-v2-tool-boundary.cjs`,
    AUTOPROMPT_GROK_PROXY_PORT: String(options.proxyPort || 19777), AUTOPROMPT_GROK_MCP_PORT: String(options.mcpPort || 19778), AUTOPROMPT_GROK_ALLOWED_MCP_TOOLS: JSON.stringify(options.allowedMcpTools || {}), AUTOPROMPT_GROK_ISSUED_CALLS: JSON.stringify(issuedCalls), PATH: '/usr/local/bin:/usr/bin:/bin',
    AUTOPROMPT_GROK_AUDIT_PATH: `${insideRoot}/proxy-audit.jsonl`,
  }
  // Do not ask bwrap to create a new session: the owned POSIX process group
  // created by ProcessOwner must continue to contain the worker and Grok so
  // an individual run can be cancelled without leaving a native descendant.
  const argv = ['--die-with-parent', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--clearenv']
  for (const mount of ['/usr', '/bin', '/lib', '/lib64']) {
    if (!fs.existsSync(mount)) continue
    const stat = fs.lstatSync(mount)
    if (stat.isSymbolicLink()) argv.push('--symlink', fs.readlinkSync(mount), mount)
    else argv.push('--ro-bind', mount, mount)
  }
  const dirs = new Set(['/run', '/opt', '/opt/grok', '/autoprompt', ...readOnlyRoots.flatMap(destinationParents), ...writableRoots.flatMap(destinationParents)])
  for (const directory of [...dirs].sort((left, right) => left.length - right.length || left.localeCompare(right))) argv.push('--dir', directory)
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', options.root, insideRoot, '--bind', options.sessionHome, insideSessionHome, '--ro-bind', options.toolPolicyPath, insidePolicy, '--ro-bind', options.toolRuntimeRoot, insideRuntime, '--ro-bind', bridge, insideBridge, '--ro-bind', options.grokExecutable, insideGrok, '--ro-bind', options.nodeExecutable, options.nodeExecutable)
  for (const directory of readOnlyRoots) argv.push('--ro-bind', directory, directory)
  for (const directory of writableRoots) argv.push('--bind', directory, directory)
  for (const [name, value] of Object.entries(env)) argv.push('--setenv', name, value)
  argv.push('--chdir', options.cwd, '--', options.nodeExecutable, `${insideBridge}/sandbox-worker.cjs`, '--', ...(options.grokArgv || []))
  return Object.freeze({ executable: '/usr/bin/bwrap', argv, env: {}, cwd: '/', shell: false, stdin: options.relayStdin, insideRoot, insideSessionHome, insideBridge, insideRuntime, insidePolicy })
}
module.exports = { GrokSandboxError, createSandboxLaunch }
