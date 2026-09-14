'use strict'
const { registerProviderLifecycle } = require('../helpers/provider-lifecycle-contract.cjs')

registerProviderLifecycle("opencode", {
  "opencode.json": "{ \"$schema\": \"custom\", \"permission\": {\"task\":\"ask\"} }\r\n",
  "opencode.jsonc": "{ // preserve\n \"model\":\"custom/model\",\n}\n"
})
