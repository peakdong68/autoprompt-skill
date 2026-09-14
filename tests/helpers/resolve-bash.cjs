'use strict'

const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

function resolveBash(options = {}) {
  const platform = options.platform || process.platform, env = options.env || process.env
  const exists = options.exists || fs.existsSync, spawn = options.spawnSync || cp.spawnSync
  const candidates = env.AUTOPROMPT_TEST_BASH ? [env.AUTOPROMPT_TEST_BASH] : []
  if (platform === 'win32') {
    const bases = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'],
      'C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\Program Files', 'D:\\Program Files (x86)'].filter(Boolean)
    if (env.LOCALAPPDATA) bases.push(path.win32.join(env.LOCALAPPDATA, 'Programs'))
    for (const base of bases) for (const sub of ['bin', 'usr\\bin']) candidates.push(path.win32.join(base, 'Git', sub, 'bash.exe'))
    for (const directory of (env.PATH || '').split(';')) {
      if (/[\\/]Git[\\/](?:usr[\\/])?bin[\\/]?$/i.test(directory)) candidates.push(path.win32.join(directory, 'bash.exe'))
    }
  } else {
    if (platform === 'darwin') candidates.push('/opt/homebrew/bin/bash', '/usr/local/bin/bash')
    for (const directory of (env.PATH || '').split(':').filter(Boolean)) candidates.push(path.join(directory, 'bash'))
    candidates.push('/bin/bash', '/usr/bin/bash')
  }
  for (const candidate of [...new Set(candidates)]) {
    if (!exists(candidate) || platform === 'win32' && /[\\/]Windows[\\/](?:System32|Sysnative)[\\/]bash\.exe$/i.test(candidate)) continue
    const result = spawn(candidate, ['--version'], { encoding: 'utf8', timeout: 5000, shell: false })
    const version = /GNU bash, version (\d+)\.(\d+)/.exec(result.stdout || '')
    if (!result.error && result.status === 0 && version && (+version[1] > 4 || +version[1] === 4 && +version[2] >= 3)) return candidate
  }
  return null
}

module.exports = { resolveBash }
