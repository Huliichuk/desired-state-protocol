/**
 * Must be imported *before* `node:sqlite`.
 *
 * Node emits the "SQLite is an experimental feature" warning while the module is
 * being loaded, not on first use, so the filter has to be installed by an
 * earlier import. ESM evaluates imports in source order, which is what makes
 * this file work.
 *
 * Only that one warning is dropped; everything else is still printed.
 */
const SUPPRESSED = 'SQLite is an experimental feature'

const listeners = process.listeners('warning')
process.removeAllListeners('warning')

process.on('warning', (warning: Error) => {
  if (warning.message.includes(SUPPRESSED)) return
  for (const listener of listeners) listener(warning)
})

export {}
