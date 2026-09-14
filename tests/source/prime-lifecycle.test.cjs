'use strict'
const { registerProviderLifecycle } = require('../helpers/provider-lifecycle-contract.cjs')

registerProviderLifecycle("prime", {
  "settings.json": "{ // preserve packages and native depth\n \"packages\": [\"custom-package\"],\n \"rlmMaxDepth\": 1,\n}\r\n"
})
