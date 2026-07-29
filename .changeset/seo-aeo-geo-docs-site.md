---
'@dsp/protocol': patch
---

Publish the documentation site with full search, answer-engine and generative-engine
metadata.

Each page now carries its own title, description, canonical URL, Open Graph and
Twitter card, plus structured data — `WebSite` and `SoftwareSourceCode` on the home
page, `TechArticle` or `HowTo` on each document, `BreadcrumbList` everywhere, and
`FAQPage` generated from the FAQ's own markdown so the two cannot drift apart.

The site also emits `sitemap.xml`, a `robots.txt` that names the generative-engine
crawlers explicitly rather than merely not blocking them, and `llms.txt` with
`llms-full.txt` — a curated map and the whole corpus as markdown, for a protocol
whose audience is AI agents.

Sections get stable anchors so a specific claim has a citable URL, and Mermaid is
only loaded on the pages that actually draw a diagram.
