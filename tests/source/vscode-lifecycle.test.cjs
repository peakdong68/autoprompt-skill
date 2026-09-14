'use strict'
const { registerProviderLifecycle } = require('../helpers/provider-lifecycle-contract.cjs')

registerProviderLifecycle("vscode", {
  "settings.json": "{ // user setting\n \"chat.customAgentInSubagent.enabled\": false,\n \"editor.fontSize\": 16,\n}\r\n",
  "settings.jsonc": "{intentionally unfinished editor settings"
})
