/**
 * Builds the documentation site published to GitHub Pages.
 *
 * The repository's markdown is written for GitHub first: links point at real files
 * and directories. This script renders those same files into a static site and
 * rewrites each link so documents resolve inside the site while links to code
 * resolve back to GitHub. Nothing is duplicated — the markdown stays the single
 * source.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'site')
const repo = 'https://github.com/Huliichuk/desired-state-protocol'
const blob = `${repo}/blob/main`
const tree = `${repo}/tree/main`

/** Markdown that becomes a page, and where it lands in the site. */
const PAGES = [
  { source: 'README.md', target: 'index.html', title: 'DSP — Desired State Protocol' },
  { source: 'SPEC.md', target: 'spec.html', title: 'DSP 0.1 Specification' },
  { source: 'docs/architecture.md', target: 'docs/architecture.html', title: 'Architecture' },
  { source: 'docs/protocol.md', target: 'docs/protocol.html', title: 'The wire protocol' },
  { source: 'docs/security.md', target: 'docs/security.html', title: 'Security model' },
  {
    source: 'docs/provider-authoring.md',
    target: 'docs/provider-authoring.html',
    title: 'Writing a provider',
  },
  {
    source: 'docs/interoperability.md',
    target: 'docs/interoperability.html',
    title: 'Interoperability',
  },
  { source: 'docs/operations.md', target: 'docs/operations.html', title: 'Operations' },
  { source: 'SECURITY.md', target: 'security-policy.html', title: 'Security policy' },
  { source: 'CONTRIBUTING.md', target: 'contributing.html', title: 'Contributing' },
]

const NAV = [
  ['index.html', 'Overview'],
  ['spec.html', 'Specification'],
  ['docs/architecture.html', 'Architecture'],
  ['docs/protocol.html', 'Wire protocol'],
  ['docs/provider-authoring.html', 'Providers'],
  ['docs/security.html', 'Security'],
  ['docs/operations.html', 'Operations'],
  ['docs/interoperability.html', 'Interoperability'],
]

/** Source path -> site path, so a markdown link can be resolved to a page. */
const pageBySource = new Map(PAGES.map((page) => [page.source, page.target]))

/**
 * Rewrites one markdown href for the site. A link to another document becomes a
 * link to its page; a link to code or a directory becomes an absolute GitHub
 * link, which is more useful than a 404.
 */
function rewriteHref(href, fromSource) {
  if (typeof href !== 'string' || /^(https?:|mailto:|#)/.test(href)) return href

  const [pathPart, fragment = ''] = href.split('#')
  const hash = fragment === '' ? '' : `#${fragment}`
  if (pathPart === '') return hash

  const fromDir = dirname(fromSource)
  const resolved = pathPart.startsWith('/')
    ? pathPart.slice(1)
    : join(fromDir === '.' ? '' : fromDir, pathPart).replaceAll('\\', '/')

  const target = pageBySource.get(resolved)
  if (target !== undefined) {
    const fromTarget = pageBySource.get(fromSource) ?? 'index.html'
    const fromTargetDir = dirname(fromTarget)
    const relativeHref = relative(fromTargetDir === '.' ? '' : fromTargetDir, target).replaceAll(
      '\\',
      '/',
    )
    return `${relativeHref === '' ? target : relativeHref}${hash}`
  }

  const isFile = /\.[a-z0-9]+$/i.test(resolved)
  return `${isFile ? blob : tree}/${resolved}${hash}`
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function render(markdown, source) {
  const renderer = new marked.Renderer()

  const baseLink = renderer.link.bind(renderer)
  renderer.link = (token) => baseLink({ ...token, href: rewriteHref(token.href, source) })

  const baseImage = renderer.image.bind(renderer)
  renderer.image = (token) => baseImage({ ...token, href: rewriteHref(token.href, source) })

  // Mermaid blocks must reach the browser verbatim for the client-side renderer.
  const baseCode = renderer.code.bind(renderer)
  renderer.code = (token) =>
    token.lang === 'mermaid'
      ? `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`
      : baseCode(token)

  return marked.parse(markdown, { renderer, gfm: true })
}

/** Keeps a wide table from forcing the whole page to scroll sideways. */
function wrapTables(html) {
  return html.replaceAll(
    /<table>[\s\S]*?<\/table>/g,
    (table) => `<div class="table-scroll">${table}</div>`,
  )
}

function layout({ title, body, target }) {
  const depth = target.split('/').length - 1
  const prefix = depth === 0 ? '' : '../'.repeat(depth)
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${prefix}${href}"${href === target ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('\n      ')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="DSP is an open protocol for declarative, verifiable execution by AI agents. An agent describes what should be true; the runtime plans, validates, applies and verifies the change.">
<link rel="stylesheet" href="${prefix}assets/style.css">
</head>
<body>
<header class="site">
  <a class="brand" href="${prefix}index.html">DSP<span>Desired State Protocol</span></a>
  <nav>
      ${nav}
  </nav>
  <a class="gh" href="${repo}">GitHub</a>
</header>
<main>
${body}</main>
<footer>
  <p>DSP 0.1 &middot; Apache License 2.0 &middot; <a href="${blob}/NOTICE">NOTICE</a> &middot; <a href="${repo}">source</a></p>
  <p class="warn">Pre-1.0 and not independently audited. Do not point a runtime at production credentials yet.</p>
</footer>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'neutral' })
</script>
</body>
</html>
`
}

const STYLE = `:root {
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #59636e;
  --line: #d1d9e0;
  --accent: #0550ae;
  --code-bg: #f6f8fa;
  --warn: #9a6700;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #9198a1;
    --line: #3d444d;
    --accent: #6cb6ff;
    --code-bg: #151b23;
    --warn: #d29922;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-text-size-adjust: 100%;
}
/* A grid with named areas rather than flex-wrap: wrapping put the GitHub button
   between the brand and the navigation at mid widths. */
header.site {
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-areas: "brand nav gh";
  align-items: center;
  column-gap: 1.5rem;
  padding: 0.9rem 1.5rem;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 10;
}
.brand { grid-area: brand; }
header.site nav { grid-area: nav; }
.gh { grid-area: gh; }
.brand { font-weight: 700; font-size: 1.05rem; text-decoration: none; color: var(--fg); }
.brand span {
  display: block;
  font-weight: 400;
  font-size: 0.75rem;
  color: var(--muted);
  letter-spacing: 0.02em;
}
header.site nav { display: flex; gap: 1rem; flex-wrap: wrap; }
header.site nav a { color: var(--muted); text-decoration: none; font-size: 0.9rem; }
header.site nav a:hover { color: var(--accent); }
header.site nav a[aria-current="page"] { color: var(--fg); font-weight: 600; }
.gh {
  font-size: 0.85rem;
  text-decoration: none;
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.3rem 0.7rem;
}
main { max-width: 52rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
main > :first-child { margin-top: 0; }
h1 { font-size: 2rem; line-height: 1.25; letter-spacing: -0.02em; }
h2 {
  font-size: 1.4rem;
  margin-top: 2.5rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--line);
}
h3 { font-size: 1.1rem; margin-top: 1.8rem; }
h4 { font-size: 1rem; margin-top: 1.4rem; }
a { color: var(--accent); }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.875em;
  background: var(--code-bg);
  padding: 0.15em 0.35em;
  border-radius: 4px;
}
pre {
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 1rem;
  overflow-x: auto;
  line-height: 1.5;
}
pre code { background: none; padding: 0; font-size: 0.83rem; }
pre.mermaid { border: none; background: none; padding: 0; text-align: center; }
blockquote {
  margin: 1.5rem 0;
  padding: 0.6rem 1rem;
  border-left: 3px solid var(--warn);
  background: var(--code-bg);
  border-radius: 0 6px 6px 0;
}
blockquote p { margin: 0.3rem 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
.table-scroll { overflow-x: auto; margin: 1.5rem 0; }
th, td {
  border: 1px solid var(--line);
  padding: 0.5rem 0.7rem;
  text-align: left;
  vertical-align: top;
}
th { background: var(--code-bg); font-weight: 600; }
hr { border: none; border-top: 1px solid var(--line); margin: 2.5rem 0; }
img { max-width: 100%; }
footer {
  border-top: 1px solid var(--line);
  padding: 1.5rem;
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
}
footer p { margin: 0.3rem 0; }
footer .warn { color: var(--warn); }
/* Below this the eight navigation entries no longer fit on one line, so they get
   a row of their own instead of wrapping around the GitHub button. */
@media (max-width: 1000px) {
  header.site {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "brand gh"
      "nav nav";
    row-gap: 0.6rem;
  }
  header.site nav { gap: 0.85rem; }
}
@media (max-width: 640px) {
  header.site { padding: 0.75rem 1rem; column-gap: 1rem; }
  header.site nav { gap: 0.7rem; font-size: 0.85rem; }
  main { padding: 1.75rem 1rem 3rem; }
  h1 { font-size: 1.6rem; }
}
`

async function build() {
  await mkdir(join(out, 'docs'), { recursive: true })
  await mkdir(join(out, 'assets'), { recursive: true })
  await writeFile(join(out, 'assets/style.css'), STYLE, 'utf8')

  // Tell GitHub Pages not to run Jekyll over generated output.
  await writeFile(join(out, '.nojekyll'), '', 'utf8')

  for (const page of PAGES) {
    const markdown = await readFile(join(root, page.source), 'utf8')
    const body = wrapTables(render(markdown, page.source))
    await writeFile(join(out, page.target), layout({ ...page, body }), 'utf8')
  }

  const entries = await readdir(out, { recursive: true })
  process.stdout.write(`docs site built into site/ (${entries.length} entries)\n`)
}

await build()
