'use strict'
const { registerProviderLifecycle } = require('../helpers/provider-lifecycle-contract.cjs')

registerProviderLifecycle("kilo", {
  "kilo.json": "{ \"permission\": {\"task\": \"ask\"}, \"model\": \"custom/model\" }\n",
  "config.json": "{invalid custom config preserved\n"
})
