// Loaded only by the official PrimeIntellect-ai/prime-agent executable.
import { Type } from 'typebox'
import controller from './controller.cjs'
export default function (pi) {
  controller.install(pi, 'prime', Type)
}
