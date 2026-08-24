# lf-mued-extensions

Lambda Feedback's own vendor-extension schema fragments for the
`x-lf` namespace, as used with [µEd-api](https://github.com/mued-api/spec)'s
`vendorExtensions` mechanism.

## What this is

µEd-api defines a generic, open-ended extension point —
`vendorExtensions` — attached to `ChatRequest.context`,
`ChatRequest.configuration`, `EvaluateRequest.configuration`, and `User`.
Vendors namespace their own fields under a single top-level key,
`x-<platform-slug>`, inside `vendorExtensions` (OpenAPI Specification
Extensions style). µEd-api does not define, host, or validate any
vendor's fields under that key — each vendor owns and documents its own
schema fragment in its own repository. See µEd-api's
[`VENDOR_EXTENSIONS.md`](https://github.com/mued-api/spec/blob/main/VENDOR_EXTENSIONS.md)
for the namespace registry and the full rules.

This repository is Lambda Feedback's own answer to "what does `x-lf`
actually contain": a concrete, current, as-implemented schema for every
field Lambda Feedback's `client-backend` adapters
(`mued.adaptor.ts`, `mued-chat.adapter.ts`) send or expect under the
`x-lf` namespace today.

This repo does not modify or fork µEd-api's spec. It is a standalone
companion describing one vendor's namespace contents.

## Schemas

All fragments live in [`schemas/`](schemas/), one file per logical
concept, in the same style as µEd-api's own `paths/**/schemas/*.yml`
(standalone YAML files, relative `$ref` between siblings, no
`components:`/internal refs).

| Fragment | Attaches to | Side |
|---|---|---|
| `EvaluateConfigurationXLf.yml` (+ `EvaluateCase.yml`, `EvaluateSymbol.yml`) | `EvaluateRequest.configuration.vendorExtensions.x-lf` | request |
| `FeedbackXLf.yml` | a `Feedback` item's `vendorExtensions.x-lf` (by convention — see note below) | response |
| `ChatContextXLf.yml` (+ `ChatQuestion.yml`, `ChatQuestionPart.yml`, `ChatResponseArea.yml`) | `ChatRequest.context.vendorExtensions.x-lf` | request |
| `ChatUserXLf.yml` (+ `ChatTaskProgress.yml`, `ChatTaskProgressPart.yml`) | `ChatRequest.user.vendorExtensions.x-lf` | request |
| `ChatMetadataXLf.yml` | `ChatResponse.metadata` directly (not under `vendorExtensions` — see note below) | response |

### Note on `Feedback.vendorExtensions`

µEd-api's `Feedback.yml` does not currently declare a `vendorExtensions`
$ref of its own. `FeedbackXLf.yml` is written to attach under
`vendorExtensions.x-lf` for consistency with every other fragment in
this repo, but until (if ever) µEd-api adds that $ref, LF's fields are
only guaranteed a home via `Feedback`'s existing open
(`additionalProperties`) shape.

### Note on `ChatResponse.metadata`

µEd-api's `ChatResponse.yml` declares `metadata` as an already-open
(`additionalProperties: true`) object with no `vendorExtensions` $ref.
LF's response-side fields (`summary`, `conversationalStyle`,
`processingTimeMs`) are documented in `ChatMetadataXLf.yml` as living
directly under `metadata`, not nested under an `x-lf` key.

## Current limitations

This repo documents Lambda Feedback's *current* wire shape as
implemented in `client-backend` today — not an aspirational or "fixed"
version of it. Known gaps, left as-is:

1. **Multiple historical protocol generations.** LF's ecosystem has
   accumulated three overlapping generations of field names for
   conceptually the same data (e.g. `matched_case` vs. `matchedCase`,
   `is_correct` vs. `awardedPoints`). This repo models only the current
   generation used by the `mEd-api` adapters
   (`mued.adaptor.ts` / `mued-chat.adapter.ts`); older generations are
   out of scope here.
2. **`Task.title` gap.** µEd-api's `Task` schema requires `title`, but
   LF's own adapter does not currently set it regardless. This is a gap
   in LF's `client-backend`, not something this schema repo defines or
   fixes.
3. **No stable cross-wire IDs.** Modules, sets, and questions are
   identified only by positional array index/number today — there is
   no stable ID that survives reordering or edits. This repo documents
   that as a known limitation of the current shape, not something to
   design around here.

## Versioning

This repo has no formal versioning scheme yet; it tracks LF's
`client-backend` adapter code as of the date of each commit. If/when
this repo is published, consider tagging releases that correspond to
adapter versions.

## Composed spec: µEd-api + x-lf, all in one document

[`composed/openapi.yml`](composed/openapi.yml) is a generated,
single-file OpenAPI document: µEd-api's full bundled spec with these
fragments spliced into every `vendorExtensions` attachment point (plus
`Feedback.vendorExtensions` and `ChatResponse.metadata`, per the two
conventions noted above). It's a demo/preview artifact, not part of
µEd-api's canonical spec — µEd-api itself can never bake in one vendor's
shape, since `vendorExtensions` has to stay generic for every vendor.
Open it in Swagger UI, Redocly, or Stoplight to see the full
"µEd-api + Lambda Feedback" contract in one place.

It's produced by [`scripts/compose.mjs`](scripts/compose.mjs), which:

1. reads a bundled `mued-api/spec` `openapi.yml` (produce one with
   `npm run bundle` in a checkout of that repo, or point `MUED_SPEC_PATH`
   at an existing one),
2. loads every fragment in `schemas/`,
3. adds them to the spec's `components.schemas`, and
4. splices an `x-lf` reference into each known `vendorExtensions` site
   (erroring out if the upstream shape it expects has moved, rather than
   silently producing something wrong).

### Regenerating locally

```bash
npm install
MUED_SPEC_PATH=../mEd-api/dist/openapi.yml npm run compose   # or omit the env var if mEd-api is checked out as a ../mEd-api sibling
npm run lint:composed
```

### Keeping it current in CI

[`.github/workflows/compose.yml`](.github/workflows/compose.yml)
regenerates and lints `composed/openapi.yml` and commits it back to the
repo when it changes. It runs on pushes that touch `schemas/`,
`scripts/compose.mjs`, or the compose tooling's own config, plus a daily
schedule (and manual `workflow_dispatch`) to pick up upstream
`mued-api/spec` changes, since a push to that separate repo doesn't
otherwise trigger this workflow.