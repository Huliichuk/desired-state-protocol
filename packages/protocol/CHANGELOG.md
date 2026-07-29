# @dsp/protocol

## 0.2.0

### Minor Changes

- abeead5: Add the Desired State Contract: a document can now say what it is **for**, not only
  what it describes.

  A contract carries a goal in prose, constraints the client declares on itself, and
  success conditions checked after apply against the state the provider actually
  reports. Expressions are CEL, evaluated against exactly one binding — the resources —
  so a document can never appear to reason about trust. Evaluation is total: a predicate
  that cannot be evaluated is reported as an error and never as a plain `false`.

  This closes a real gap. A document asking for an inactive subscription matched the
  world perfectly and billed nobody, and DSP reported it as a complete success with
  satisfaction 1.0. With a success condition the same change is `goal_not_satisfied`,
  while structural verification still — correctly — reports `satisfied`: the two claims
  are now reported side by side and never collapsed.

  Constraints are a self-check, not an access control. A client picks its own and may
  pick weak ones; operator limits remain in the policy bundle, which no document can
  influence.

  Breaking for anyone constructing protocol objects directly: `DSPPlan.contract` and
  `VerificationResult.contract` are required (nullable) fields, `OperationStatus` gains
  `goal_not_satisfied`, and the published JSON Schemas changed with them.

## 0.1.2

### Patch Changes

- 6b01211: Publish the documentation site with full search, answer-engine and generative-engine
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

## 0.1.1
