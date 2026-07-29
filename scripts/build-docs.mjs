/**
 * Builds the documentation site published to GitHub Pages.
 *
 * The repository's markdown is written for GitHub first: links point at real files
 * and directories. This script renders those same files into a static site and
 * rewrites each link so documents resolve inside the site while links to code
 * resolve back to GitHub. Nothing is duplicated — the markdown stays the single
 * source.
 *
 * It also emits everything a search engine, an answer engine and a generative
 * engine need to understand and cite the site: per-page metadata, structured data,
 * a sitemap, a robots policy that welcomes AI crawlers, and an llms.txt corpus.
 */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { marked } from 'marked'

const run = promisify(execFile)

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'site')

const SITE = {
  origin: 'https://huliichuk.github.io',
  base: '/desired-state-protocol/',
  name: 'DSP — Desired State Protocol',
  shortName: 'DSP',
  repo: 'https://github.com/Huliichuk/desired-state-protocol',
  author: 'Taras Huliichuk',
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  protocolVersion: '0.1.0',
  locale: 'en_US',
}
SITE.url = `${SITE.origin}${SITE.base}`
const blob = `${SITE.repo}/blob/main`
const tree = `${SITE.repo}/tree/main`

/**
 * Every page, with the metadata search and answer engines actually consume.
 *
 * `description` is per-page on purpose: one shared description across ten pages is
 * a duplicate-content signal and gives an answer engine nothing to distinguish
 * them by. Each is a self-contained sentence about that page, 110-160 characters.
 */
const PAGES = [
  {
    source: 'README.md',
    target: 'index.html',
    title: 'DSP — Desired State Protocol for AI agents',
    description:
      'An open protocol that lets an AI agent change external systems by describing the intended end state, with a reviewable plan and verified result.',
    schema: 'home',
  },
  {
    source: 'SPEC.md',
    target: 'spec.html',
    title: 'DSP 0.1 Specification — Desired State Protocol',
    description:
      'The normative specification of DSP 0.1: resource model, canonical JSON, diff rules, deterministic risk scoring, plan hashing, apply preconditions and the error model.',
    schema: 'article',
  },
  {
    source: 'docs/faq.md',
    target: 'faq.html',
    title: 'DSP FAQ — how the Desired State Protocol works',
    description:
      'What DSP is, how it differs from MCP, how it keeps API keys away from an agent, how it verifies a change, and whether it is production ready.',
    schema: 'faq',
  },
  {
    source: 'docs/architecture.md',
    target: 'docs/architecture.html',
    title: 'DSP architecture — how the runtime is built',
    description:
      'How the DSP reference runtime is put together: the package graph, why the runtime owns the diff instead of providers, the plan and apply paths, and persistence.',
    schema: 'article',
  },
  {
    source: 'docs/protocol.md',
    target: 'docs/protocol.html',
    title: 'DSP wire protocol — HTTP endpoints and examples',
    description:
      'A practical walkthrough of the DSP HTTP API with real request and response bodies: discover, validate, inspect, plan, approve, apply, verify and audit.',
    schema: 'article',
  },
  {
    source: 'docs/security.md',
    target: 'docs/security.html',
    title: 'DSP security model — threat model and known gaps',
    description:
      'What DSP enforces and where: prompt-injection resistance, credential isolation, redaction boundaries, drift detection, tamper evidence, and the gaps in 0.1.',
    schema: 'article',
  },
  {
    source: 'docs/provider-authoring.md',
    target: 'docs/provider-authoring.html',
    title: 'Writing a DSP provider — a step-by-step guide',
    description:
      'How to adapt an external system to DSP: declaring resource types, projecting a document into resources with stable keys, scoped secrets and idempotent apply.',
    schema: 'howto',
  },
  {
    source: 'docs/interoperability.md',
    target: 'docs/interoperability.html',
    title: 'DSP interoperability — APIs, MCP bridges and CI/CD',
    description:
      'How DSP sits beside existing systems: adapters today and native servers later, an optional MCP bridge, the honest token-cost argument, and CI/CD usage.',
    schema: 'article',
  },
  {
    source: 'docs/operations.md',
    target: 'docs/operations.html',
    title: 'Operating a DSP runtime — configuration and runbook',
    description:
      'Running DSP for real: every environment variable, secret stores, policy bundles, the audit chain, CLI exit codes, and a runbook for the failures you will hit.',
    schema: 'article',
  },
  {
    source: 'SECURITY.md',
    target: 'security-policy.html',
    title: 'DSP security policy — reporting a vulnerability',
    description:
      'How to report a DSP vulnerability privately, what is in scope, the coordinated disclosure window, and how to harden a deployment before exposing it.',
    schema: 'article',
  },
  {
    source: 'CONTRIBUTING.md',
    target: 'contributing.html',
    title: 'Contributing to DSP — setup, style and releases',
    description:
      'Prerequisites, commands, code style, the conformance requirement for new providers, how to change the protocol, and how versions and releases work.',
    schema: 'article',
  },
  {
    source: 'CHANGELOG.md',
    target: 'changelog.html',
    title: 'DSP changelog — releases and versioning',
    description:
      'Every DSP release, and why the package version and the protocol version move independently of each other.',
    schema: 'article',
  },
]

const NAV = [
  ['index.html', 'Overview'],
  ['spec.html', 'Specification'],
  ['docs/architecture.html', 'Architecture'],
  ['docs/protocol.html', 'Wire protocol'],
  ['docs/provider-authoring.html', 'Providers'],
  ['docs/security.html', 'Security'],
  ['docs/operations.html', 'Operations'],
  ['faq.html', 'FAQ'],
]

/** Source path -> site path, so a markdown link can be resolved to a page. */
const pageBySource = new Map(PAGES.map((page) => [page.source, page.target]))

const absolute = (target) => `${SITE.url}${target === 'index.html' ? '' : target}`

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

/** GitHub-compatible heading slugs, so anchors match the markdown on GitHub. */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`|\*|_|\[|\]|\(|\)|<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function render(markdown, source) {
  const renderer = new marked.Renderer()
  const seen = new Map()
  const headings = []

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

  // Every section gets a stable id and a self link. A citable URL for a specific
  // claim is what lets an answer engine point at the sentence rather than the page.
  const baseHeading = renderer.heading.bind(renderer)
  renderer.heading = (token) => {
    const html = baseHeading(token)
    if (token.depth === 1) return html

    const base = slugify(token.text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const id = count === 0 ? base : `${base}-${count}`
    if (id === '') return html

    headings.push({ depth: token.depth, id, text: token.text })
    return html.replace(
      `<h${token.depth}>`,
      `<h${token.depth} id="${id}">` +
        `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`,
    )
  }

  return { html: marked.parse(markdown, { renderer, gfm: true }), headings }
}

/** Keeps a wide table from forcing the whole page to scroll sideways. */
function wrapTables(html) {
  return html.replaceAll(
    /<table>[\s\S]*?<\/table>/g,
    (table) => `<div class="table-scroll">${table}</div>`,
  )
}

const ld = (value) =>
  `<script type="application/ld+json">\n${JSON.stringify(value, null, 2)}\n</script>`

const PUBLISHER = {
  '@type': 'Person',
  name: SITE.author,
  url: 'https://github.com/Huliichuk',
}

/**
 * One script block per schema type, never combined, and every URL absolute — both
 * are hard requirements for Google rich result eligibility.
 */
function structuredData(page, dates, faq) {
  const pageUrl = absolute(page.target)
  const blocks = []

  const breadcrumb = [{ name: 'DSP', url: SITE.url }]
  if (page.target !== 'index.html') {
    if (page.target.startsWith('docs/')) breadcrumb.push({ name: 'Documentation', url: SITE.url })
    breadcrumb.push({ name: page.title, url: pageUrl })
  }

  blocks.push(
    ld({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumb.map((crumb, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: crumb.name,
        item: crumb.url,
      })),
    }),
  )

  if (page.schema === 'home') {
    blocks.push(
      ld({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        '@id': `${SITE.url}#website`,
        name: SITE.name,
        alternateName: ['DSP', 'Desired State Protocol'],
        url: SITE.url,
        description: page.description,
        inLanguage: 'en',
        license: SITE.license,
        author: PUBLISHER,
        publisher: PUBLISHER,
      }),
      ld({
        '@context': 'https://schema.org',
        '@type': 'SoftwareSourceCode',
        '@id': `${SITE.url}#software`,
        name: 'DSP — Desired State Protocol',
        alternateName: 'Desired State Protocol',
        description:
          'An open protocol and reference runtime for declarative, verifiable execution by AI agents. An agent describes what should be true; the runtime plans, validates, applies and verifies the change.',
        url: SITE.url,
        codeRepository: SITE.repo,
        programmingLanguage: [
          { '@type': 'ComputerLanguage', name: 'TypeScript' },
          { '@type': 'ComputerLanguage', name: 'JavaScript' },
        ],
        runtimePlatform: 'Node.js 22',
        license: SITE.license,
        version: SITE.protocolVersion,
        codeSampleType: 'full solution',
        author: PUBLISHER,
        maintainer: PUBLISHER,
        dateModified: dates.modified,
        keywords: [
          'Desired State Protocol',
          'DSP',
          'AI agent safety',
          'declarative protocol',
          'Model Context Protocol alternative',
          'agent tool calling',
          'infrastructure as code for SaaS',
        ].join(', '),
      }),
    )
  }

  if (page.schema === 'faq' && faq.length > 0) {
    blocks.push(
      ld({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        '@id': `${pageUrl}#faq`,
        mainEntity: faq.map((entry) => ({
          '@type': 'Question',
          name: entry.question,
          acceptedAnswer: { '@type': 'Answer', text: entry.answer },
        })),
      }),
    )
  }

  if (page.schema !== 'home') {
    blocks.push(
      ld({
        '@context': 'https://schema.org',
        '@type': page.schema === 'howto' ? 'HowTo' : 'TechArticle',
        '@id': `${pageUrl}#article`,
        headline: page.title,
        name: page.title,
        description: page.description,
        url: pageUrl,
        mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl },
        inLanguage: 'en',
        license: SITE.license,
        author: PUBLISHER,
        publisher: PUBLISHER,
        datePublished: dates.published,
        dateModified: dates.modified,
        isPartOf: { '@type': 'WebSite', '@id': `${SITE.url}#website` },
        about: { '@type': 'SoftwareSourceCode', '@id': `${SITE.url}#software` },
      }),
    )
  }

  return blocks.join('\n')
}

/**
 * Places the table of contents immediately before the first section rather than at
 * the top of the page. The H1 and the opening paragraph — the definition sentence
 * an answer engine quotes — stay together and stay first.
 */
function insertToc(body, tocHtml) {
  if (tocHtml === '') return body
  const firstSection = body.search(/<h2[ >]/)
  if (firstSection === -1) return `${tocHtml}${body}`
  return body.slice(0, firstSection) + tocHtml + body.slice(firstSection)
}

function layout({ page, body, dates, faq, hasMermaid, toc }) {
  const depth = page.target.split('/').length - 1
  const prefix = depth === 0 ? '' : '../'.repeat(depth)
  const pageUrl = absolute(page.target)
  const ogImage = `${SITE.url}assets/og.png`

  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${prefix}${href}"${href === page.target ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('\n      ')

  const tocHtml =
    toc.length < 4
      ? ''
      : `<nav class="toc" aria-label="On this page">\n  <p>On this page</p>\n  <ul>\n${toc
          .map((item) => `    <li><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`)
          .join('\n')}\n  </ul>\n</nav>\n`

  // Mermaid is a megabyte of JavaScript from a CDN. Only the pages that actually
  // draw a diagram pay for it, which keeps the rest fast to render.
  const mermaid = hasMermaid
    ? `<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'neutral' })
</script>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="canonical" href="${pageUrl}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="author" content="${escapeHtml(SITE.author)}">

<meta property="og:type" content="${page.target === 'index.html' ? 'website' : 'article'}">
<meta property="og:site_name" content="${escapeHtml(SITE.name)}">
<meta property="og:locale" content="${SITE.locale}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:title" content="${escapeHtml(page.title)}">
<meta property="og:description" content="${escapeHtml(page.description)}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="DSP — Desired State Protocol. An agent describes what should be true; the runtime plans, validates, applies and verifies the change.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(page.title)}">
<meta name="twitter:description" content="${escapeHtml(page.description)}">
<meta name="twitter:image" content="${ogImage}">

<link rel="stylesheet" href="${prefix}assets/style.css">
<link rel="alternate" type="text/markdown" href="${blob}/${page.source}" title="Markdown source">
${structuredData(page, dates, faq)}
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="site">
  <a class="brand" href="${prefix}index.html">DSP<span>Desired State Protocol</span></a>
  <nav aria-label="Documentation">
      ${nav}
  </nav>
  <a class="gh" href="${SITE.repo}">GitHub</a>
</header>
<main id="content">
${insertToc(body, tocHtml)}</main>
<footer>
  <p>DSP ${SITE.protocolVersion} &middot; Apache License 2.0 &middot; <a href="${blob}/NOTICE">NOTICE</a> &middot; <a href="${SITE.repo}">source</a> &middot; <a href="${prefix}faq.html">FAQ</a></p>
  <p>Last updated <time datetime="${dates.modified}">${dates.modified.slice(0, 10)}</time></p>
  <p class="warn">Pre-1.0 and not independently audited. Do not point a runtime at production credentials yet.</p>
</footer>
${mermaid}
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
.skip {
  position: absolute;
  left: -9999px;
  top: 0;
  background: var(--bg);
  color: var(--fg);
  padding: 0.6rem 1rem;
  z-index: 20;
}
.skip:focus { left: 0; }
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
.brand { grid-area: brand; font-weight: 700; font-size: 1.05rem; text-decoration: none; color: var(--fg); }
.brand span {
  display: block;
  font-weight: 400;
  font-size: 0.75rem;
  color: var(--muted);
  letter-spacing: 0.02em;
}
header.site nav { grid-area: nav; display: flex; gap: 1rem; flex-wrap: wrap; }
header.site nav a { color: var(--muted); text-decoration: none; font-size: 0.9rem; }
header.site nav a:hover { color: var(--accent); }
header.site nav a[aria-current="page"] { color: var(--fg); font-weight: 600; }
.gh {
  grid-area: gh;
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
h2, h3, h4 { scroll-margin-top: 6rem; position: relative; }
.anchor {
  position: absolute;
  left: -1.1rem;
  color: var(--line);
  text-decoration: none;
  opacity: 0;
  transition: opacity 0.1s;
}
h2:hover .anchor, h3:hover .anchor, h4:hover .anchor, .anchor:focus { opacity: 1; }
a { color: var(--accent); }
.toc {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin-bottom: 2.5rem;
  background: var(--code-bg);
}
.toc p {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.toc ul { margin: 0; padding-left: 1.1rem; columns: 2; column-gap: 2rem; }
.toc li { font-size: 0.9rem; margin: 0.15rem 0; break-inside: avoid; }
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
img { max-width: 100%; height: auto; }
footer {
  border-top: 1px solid var(--line);
  padding: 1.5rem;
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
}
footer p { margin: 0.3rem 0; }
footer .warn { color: var(--warn); }
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
  .toc ul { columns: 1; }
  .anchor { display: none; }
}
`

/**
 * Last-modified dates come from git so the freshness signal is true rather than
 * "whenever the site was last built". A shallow clone has no history to read, so
 * the build time is the fallback.
 */
async function gitDate(source, fallback) {
  try {
    const { stdout } = await run('git', ['log', '-1', '--format=%cI', '--', source], { cwd: root })
    const value = stdout.trim()
    return value === '' ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * Extracts the question and answer pairs from the FAQ markdown so the FAQPage
 * schema is generated from the page's real content and cannot drift from it.
 */
function parseFaq(markdown) {
  const entries = []
  let current = null

  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading?.[1] !== undefined) {
      if (current !== null) entries.push(current)
      current = { question: heading[1], answer: '' }
      continue
    }
    if (current === null || line.startsWith('#')) continue
    if (line.trim() === '') {
      // The first paragraph is the answer; anything after it is elaboration.
      if (current.answer !== '') current.done = true
      continue
    }
    if (current.done === true) continue
    // JSON-LD must not contain markup, so inline markdown is flattened to text.
    current.answer = `${current.answer} ${line.trim()}`.trim()
  }
  if (current !== null) entries.push(current)

  return entries
    .map(({ question, answer }) => ({
      question,
      answer: answer
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((entry) => entry.answer.length > 40)
}

function sitemap(entries) {
  const urls = entries
    .map(
      ({ page, dates }) => `  <url>
    <loc>${absolute(page.target)}</loc>
    <lastmod>${dates.modified.slice(0, 10)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${page.target === 'index.html' ? '1.0' : page.target === 'spec.html' || page.target === 'faq.html' ? '0.9' : '0.8'}</priority>
  </url>`,
    )
    .join('\n')

  // The namespace host is `sitemaps.org`, plural. A sitemap in any other namespace
  // is rejected wholesale rather than partially accepted.
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}

/**
 * DSP exists to be used by AI agents, so the crawlers that feed generative answers
 * are welcome by name rather than merely un-blocked. Being cited is the goal.
 */
const ROBOTS = `# DSP — Desired State Protocol
# Everything here is Apache-2.0 licensed documentation of an open protocol.
# Crawling, indexing and citation are all welcome; attribution is appreciated.

User-agent: *
Allow: /

# Named explicitly so there is no ambiguity for the crawlers behind generative
# answers. The protocol is meant to be found and quoted by exactly these.
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: cohere-ai
Allow: /

User-agent: Bytespider
Allow: /

User-agent: meta-externalagent
Allow: /

Sitemap: ${SITE.url}sitemap.xml
`

/**
 * llms.txt is the emerging convention for handing a language model a curated map
 * of a site instead of making it guess from HTML. For a protocol whose audience is
 * AI agents, publishing one is the point rather than a nicety.
 */
function llmsTxt(entries) {
  const lines = [
    `# ${SITE.name}`,
    '',
    '> DSP is an open protocol that lets an AI agent change the state of an external',
    '> system by describing the intended end state instead of calling write operations',
    '> one at a time. The runtime reads current state, computes the difference, scores',
    '> risk deterministically, checks policy, and produces an immutable hashed plan',
    '> that a human can review before anything executes. After executing it re-reads',
    '> the world and verifies the result.',
    '',
    'Key facts, stated so they can be quoted directly:',
    '',
    `- Protocol version ${SITE.protocolVersion}, API version \`dsp.dev/v1alpha1\`. Pre-1.0 and not independently audited.`,
    '- Licence: Apache-2.0. Commercial use, modification and redistribution are permitted with attribution.',
    '- DSP is independent from MCP. MCP exposes tools; DSP exposes desired state. Neither depends on the other.',
    '- No language model runs inside the runtime, including the risk score and the policy engine.',
    '- An agent never receives provider credentials; documents carry secret references only.',
    '- `apply` accepts a plan id and never a document, so reviewed intent is the only thing that can execute.',
    '- Deletions and replacements are refused by default and cannot be enabled per request.',
    '- The wire protocol is HTTP plus five published JSON Schemas; anyone may implement it.',
    `- Author: ${SITE.author}. Source: ${SITE.repo}`,
    '',
    '## Documentation',
    '',
  ]

  for (const { page } of entries) {
    lines.push(`- [${page.title}](${absolute(page.target)}): ${page.description}`)
  }

  lines.push(
    '',
    '## Machine-readable',
    '',
    `- [Full documentation as one markdown file](${SITE.url}llms-full.txt): every page concatenated.`,
    `- [Published JSON Schemas](${tree}/schemas): manifest, desired state, plan, result and policy.`,
    `- [OpenAPI 3.1 description](${blob}/apps/server/src/openapi.ts): generated by a running runtime at \`/openapi.json\`.`,
    '',
  )

  return `${lines.join('\n')}\n`
}

async function llmsFullTxt(entries) {
  const parts = [
    `# ${SITE.name} — complete documentation`,
    '',
    `Version ${SITE.protocolVersion}. Licence Apache-2.0. Source: ${SITE.repo}`,
    'This file concatenates every documentation page as markdown, in reading order,',
    'so a language model can ingest the whole corpus in one request.',
    '',
    '---',
    '',
  ]

  for (const { page } of entries) {
    const markdown = await readFile(join(root, page.source), 'utf8')
    parts.push(
      `<!-- source: ${page.source} | url: ${absolute(page.target)} -->`,
      '',
      markdown,
      '',
      '---',
      '',
    )
  }

  return parts.join('\n')
}

async function build() {
  const buildTime = new Date().toISOString()

  await mkdir(join(out, 'docs'), { recursive: true })
  await mkdir(join(out, 'assets'), { recursive: true })
  await writeFile(join(out, 'assets/style.css'), STYLE, 'utf8')

  // Tell GitHub Pages not to run Jekyll over generated output.
  await writeFile(join(out, '.nojekyll'), '', 'utf8')

  try {
    await copyFile(join(root, 'assets/og.png'), join(out, 'assets/og.png'))
  } catch {
    process.stderr.write('warning: assets/og.png is missing; social previews will have no image\n')
  }

  const faqSource = PAGES.find((page) => page.schema === 'faq')
  const faq =
    faqSource === undefined ? [] : parseFaq(await readFile(join(root, faqSource.source), 'utf8'))

  const entries = []
  for (const page of PAGES) {
    const markdown = await readFile(join(root, page.source), 'utf8')
    const modified = await gitDate(page.source, buildTime)
    const dates = { published: '2026-07-29T00:00:00.000Z', modified }

    const { html, headings } = render(markdown, page.source)
    const body = wrapTables(html)

    await writeFile(
      join(out, page.target),
      layout({
        page,
        body,
        dates,
        faq,
        hasMermaid: html.includes('class="mermaid"'),
        toc: headings.filter((heading) => heading.depth === 2),
      }),
      'utf8',
    )

    entries.push({ page, dates })
  }

  await writeFile(join(out, 'sitemap.xml'), sitemap(entries), 'utf8')
  await writeFile(join(out, 'robots.txt'), ROBOTS, 'utf8')
  await writeFile(join(out, 'llms.txt'), llmsTxt(entries), 'utf8')
  await writeFile(join(out, 'llms-full.txt'), await llmsFullTxt(entries), 'utf8')

  const written = await readdir(out, { recursive: true })
  process.stdout.write(
    `docs site built into site/ — ${PAGES.length} pages, ${faq.length} FAQ entries, ${written.length} files\n`,
  )
}

await build()
