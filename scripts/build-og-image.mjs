/**
 * Renders the 1200x630 social preview image to assets/og.png.
 *
 * The result is committed rather than generated during the site build: the build
 * runs on a Linux CI runner with no browser, and a social card that only appears
 * when the author happens to have Chrome installed is worse than no card at all.
 *
 * Run this when the card's wording changes:
 *   node scripts/build-og-image.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const CARD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px;
    height: 630px;
    background: #0d1117;
    color: #e6edf3;
    font: 400 22px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 68px 72px;
    position: relative;
    overflow: hidden;
  }
  /* A faint grid, because the protocol is about structure. */
  body::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(to right, rgba(108, 182, 255, 0.06) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(108, 182, 255, 0.06) 1px, transparent 1px);
    background-size: 48px 48px;
  }
  .top, .mid, .bottom { position: relative; }
  .eyebrow {
    font: 600 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #6cb6ff;
  }
  h1 {
    font-size: 78px;
    line-height: 1.02;
    letter-spacing: -0.03em;
    font-weight: 700;
    margin-top: 26px;
  }
  h1 span { color: #9198a1; font-weight: 400; }
  .lines {
    font: 400 27px/1.62 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #e6edf3;
  }
  .lines b { color: #6cb6ff; font-weight: 400; }
  .lines i { color: #9198a1; font-style: normal; }
  .bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid #3d444d;
    padding-top: 26px;
    font-size: 21px;
    color: #9198a1;
  }
  .pills { display: flex; gap: 12px; }
  .pill {
    border: 1px solid #3d444d;
    border-radius: 999px;
    padding: 7px 17px;
    font-size: 19px;
    color: #e6edf3;
  }
</style>
</head>
<body>
  <div class="top">
    <p class="eyebrow">Open protocol &middot; Apache 2.0</p>
    <h1>DSP<br><span>Desired State Protocol</span></h1>
  </div>

  <div class="mid lines">
    <div><i>APIs expose operations.</i></div>
    <div><i>MCP exposes tools.</i></div>
    <div><b>DSP exposes desired state.</b></div>
  </div>

  <div class="bottom">
    <span>An agent describes what should be true.</span>
    <div class="pills">
      <span class="pill">plan</span>
      <span class="pill">approve</span>
      <span class="pill">verify</span>
    </div>
  </div>
</body>
</html>
`

async function findChrome() {
  const { access } = await import('node:fs/promises')
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

async function main() {
  const chrome = await findChrome()
  if (chrome === null) {
    process.stderr.write(
      'No Chrome or Chromium found. assets/og.png is committed, so this is only\n' +
        'needed when the card changes. Install Chrome and re-run.\n',
    )
    process.exit(1)
  }

  const work = join(tmpdir(), `dsp-og-${process.pid}`)
  await mkdir(work, { recursive: true })
  const html = join(work, 'card.html')
  await writeFile(html, CARD, 'utf8')

  await mkdir(join(root, 'assets'), { recursive: true })
  const target = join(root, 'assets/og.png')

  await run(chrome, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1200,630',
    `--screenshot=${target}`,
    `file://${html}`,
  ])

  await rm(work, { recursive: true, force: true })
  process.stdout.write(`wrote assets/og.png (1200x630) using ${chrome}\n`)
}

await main()
