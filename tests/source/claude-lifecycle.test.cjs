'use strict'
const { registerProviderLifecycle } = require('../helpers/provider-lifecycle-contract.cjs')

registerProviderLifecycle("claude", {
  "settings.json": "{\n // user settings\n \"permissions\":{\"deny\":[\"Bash(rm *)\"]},\n \"custom\":true,\n}\n"
})
