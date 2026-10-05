import { createPerfSpan } from '@shared/perf-timing'
import { createMainLogger } from './logger'

const log = createMainLogger('perf')
export const perfSpan = createPerfSpan(log)
