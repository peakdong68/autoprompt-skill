'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const yaml = require('yaml')

for (const file of ['agent-preset/agent.cordis.yml', 'headless.patch.yml']) {
  test(`DeepSeek ${file}: every registered role excludes native delegation through an explicit allowlist`, () => {
    const document = yaml.parse(fs.readFileSync(path.resolve(__dirname, '../../agents/deepseek', file), 'utf8'))
    const entries = file === 'headless.patch.yml' ? document.flatMap(row => row.insert || []) : document
    const roles = entries.filter(row => row.name === '@deepseek-ai/dsh-tool-subagent')
    assert.ok(roles.length > 0)
    const nativeRoleNames = new Set(roles.map(row => row.config.toolName))
    for (const role of roles) {
      const filter = role.config.toolFilter
      assert.ok(Array.isArray(filter.allow), role.id)
      assert.equal(Object.hasOwn(filter, 'deny'), false, role.id)
      assert.ok(filter.allow.length > 0, role.id)
      for (const tool of filter.allow) {
        assert.ok(!nativeRoleNames.has(tool), `${role.id} must not start ${tool}`)
        assert.doesNotMatch(tool, /subagent|spawn|fork|delegate/i)
      }
      assert.equal(role.config.maxDepth, 1)
    }
  })
}
