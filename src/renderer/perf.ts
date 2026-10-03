import { createPerfSpan } from '@shared/perf-timing'
import { createRendererLogger } from './logger'

const log = createRendererLogger('perf')
export const perfSpan = createPerfSpan(log)
