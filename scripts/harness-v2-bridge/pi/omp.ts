// OMP supplies its own TypeBox-compatible schema builder; no user modules load.
import controller from './controller.cjs'
export default function (pi) {
  controller.install(pi, 'omp', pi.typebox.Type)
}
