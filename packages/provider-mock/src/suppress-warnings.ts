/**
 * Must be imported *before* `node:sqlite`. See the identical file in
 * `@dsp/core` for why: Node emits the experimental-SQLite warning during module
 * load, so the filter has to be installed by an earlier import.
 */
const SUPPRESSED = 'SQLite is an experimental feature'

const listeners = process.listeners('warning')
process.removeAllListeners('warning')

process.on('warning', (warning: Error) => {
  if (warning.message.includes(SUPPRESSED)) return
  for (const listener of listeners) listener(warning)
})

export {}
