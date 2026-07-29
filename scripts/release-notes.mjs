/**
 * Builds the release notes for one version.
 *
 * Changesets writes a CHANGELOG.md per package. Because every @dsp/* package is
 * version-locked, the same release shows up in eleven files, and reading eleven
 * changelogs is nobody's idea of release notes. This collapses them into one
 * document: each distinct entry once, with the packages it touched.
 *
 * Usage: node scripts/release-notes.mjs 0.2.0
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const version = process.argv[2]

if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
  process.stderr.write('usage: node scripts/release-notes.mjs <version>\n')
  process.exit(2)
}

/** Every workspace package directory that may carry a changelog. */
async function packageDirs() {
  const dirs = []
  for (const group of ['packages', 'apps']) {
    for (const name of await readdir(join(root, group))) {
      dirs.push({ name, path: join(root, group, name) })
    }
  }
  return dirs
}

/**
 * Pulls the section for `version` out of a changelog. Changesets writes
 * `## <version>` headings, so the section runs to the next `## ` or the end.
 */
function sectionFor(changelog, target) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${target}`)
  if (start === -1) return null

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

/**
 * Splits a section into individual entries. Changesets emits `### Minor Changes`
 * style headings followed by bullet lists; the bullets are what a reader wants.
 */
function entries(section) {
  const found = []
  let kind = 'Changes'

  for (const rawLine of section.split('\n')) {
    const line = rawLine.trimEnd()
    const heading = /^###\s+(.*)$/.exec(line)
    if (heading?.[1] !== undefined) {
      kind = heading[1].trim()
      continue
    }
    if (/^\s*-\s/.test(line)) {
      found.push({ kind, text: line.replace(/^\s*-\s+/, '').trim() })
      continue
    }
    // A continuation line belongs to the entry above it.
    if (line.trim() !== '' && found.length > 0) {
      const last = found[found.length - 1]
      if (last !== undefined) last.text = `${last.text} ${line.trim()}`
    }
  }
  return found
}

/**
 * Changesets prefixes dependency-only bumps with the package name and a version,
 * which carries no information in a version-locked repository.
 */
function isDependencyBumpNoise(text) {
  return /^Updated dependencies/i.test(text) || /^@dsp\/[a-z-]+@\d/.test(text)
}

async function build() {
  const byKind = new Map()

  for (const { name, path } of await packageDirs()) {
    let changelog
    try {
      changelog = await readFile(join(path, 'CHANGELOG.md'), 'utf8')
    } catch {
      continue
    }

    const section = sectionFor(changelog, version)
    if (section === null) continue

    for (const entry of entries(section)) {
      if (isDependencyBumpNoise(entry.text)) continue
      const bucket = byKind.get(entry.kind) ?? new Map()
      // The same changeset lands in every affected package: keep it once and
      // record which packages it touched.
      const packages = bucket.get(entry.text) ?? new Set()
      packages.add(name)
      bucket.set(entry.text, packages)
      byKind.set(entry.kind, bucket)
    }
  }

  const out = []

  if (byKind.size === 0) {
    // The first release predates any per-package changelog, and a hand-written
    // entry in the root CHANGELOG is a better release note than an apology.
    const rootSection = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
      .then((text) => sectionFor(text, version))
      .catch(() => null)

    out.push(rootSection ?? `No changelog entries were recorded for ${version}.`, '')
  }

  for (const kind of ['Major Changes', 'Minor Changes', 'Patch Changes']) {
    const bucket = byKind.get(kind)
    if (bucket === undefined || bucket.size === 0) continue
    out.push(`### ${kind}`, '')
    for (const [text, packages] of bucket) {
      const scope = [...packages].sort().join(', ')
      out.push(`- ${text}`, `  <sub>${scope}</sub>`)
    }
    out.push('')
  }

  // Anything the loop above did not name, so a custom heading is never dropped.
  for (const [kind, bucket] of byKind) {
    if (['Major Changes', 'Minor Changes', 'Patch Changes'].includes(kind)) continue
    out.push(`### ${kind}`, '')
    for (const [text] of bucket) out.push(`- ${text}`)
    out.push('')
  }

  out.push(
    '---',
    '',
    `Protocol version: see [SPEC.md](https://github.com/Huliichuk/desired-state-protocol/blob/v${version}/SPEC.md).`,
    'The protocol version and the package version move independently: the protocol',
    'version changes only when the wire format changes.',
    '',
    `Documentation: https://huliichuk.github.io/desired-state-protocol/`,
  )

  process.stdout.write(`${out.join('\n')}\n`)
}

await build()
