#!/usr/bin/env node
// Composes a demo OpenAPI document showing µEd-api's spec with Lambda
// Feedback's x-lf vendor-extension fields spliced into every
// vendorExtensions attachment point (plus the two conventions documented
// in the README that don't use a formal vendorExtensions $ref).
//
// Input: a bundled mEd-api openapi.yml (single file, no external $refs —
// produce one with `npm run bundle` in a checkout of mued-api/spec).
// Output: composed/openapi.yml in this repo.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const inputPath = process.env.MUED_SPEC_PATH
  ? path.resolve(process.cwd(), process.env.MUED_SPEC_PATH)
  : path.resolve(repoRoot, "../mEd-api/dist/openapi.yml");
const outputPath = path.resolve(repoRoot, "composed/openapi.yml");
const schemasDir = path.resolve(repoRoot, "schemas");

function loadYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, "utf8"));
}

if (!fs.existsSync(inputPath)) {
  console.error(`mEd-api bundled spec not found at ${inputPath}`);
  console.error(
    "Bundle it first (npm run bundle in a mued-api/spec checkout), or set MUED_SPEC_PATH.",
  );
  process.exit(1);
}

const spec = loadYaml(inputPath);

// 1. Load every LF schema fragment, keyed by filename (without .yml).
const fragmentFiles = fs
  .readdirSync(schemasDir)
  .filter((f) => f.endsWith(".yml"));
const fragments = {};
for (const file of fragmentFiles) {
  const name = file.replace(/\.yml$/, "");
  fragments[name] = loadYaml(path.join(schemasDir, file));
}

// 2. Rewrite this repo's relative "./Other.yml" refs to component refs.
function rewriteRefs(node) {
  if (Array.isArray(node)) {
    node.forEach(rewriteRefs);
    return;
  }
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string" && node.$ref.startsWith("./")) {
      const name = node.$ref.replace(/^\.\//, "").replace(/\.yml$/, "");
      node.$ref = `#/components/schemas/${name}`;
    }
    for (const key of Object.keys(node)) {
      rewriteRefs(node[key]);
    }
  }
}
for (const name of Object.keys(fragments)) {
  rewriteRefs(fragments[name]);
}

// 3. Merge fragments into the spec's components.schemas — except
//    ChatMetadataXLf, whose properties get flattened directly into
//    ChatResponse.metadata below rather than $ref'd, so registering it as
//    a component would just trip Redocly's no-unused-components rule.
const flattenedOnly = new Set(["ChatMetadataXLf"]);
spec.components = spec.components || {};
spec.components.schemas = spec.components.schemas || {};
for (const [name, schema] of Object.entries(fragments)) {
  if (flattenedOnly.has(name)) continue;
  if (spec.components.schemas[name]) {
    throw new Error(
      `Component name collision: "${name}" already exists in the mEd-api spec. ` +
        "Rename the fragment file or investigate the upstream change.",
    );
  }
  spec.components.schemas[name] = schema;
}

function requireSchema(name) {
  const schema = spec.components.schemas[name];
  if (!schema) {
    throw new Error(
      `Expected component "${name}" not found in the mEd-api spec — has its shape changed?`,
    );
  }
  return schema;
}

function requireProp(obj, key, contextLabel) {
  if (!obj || !obj.properties || !obj.properties[key]) {
    throw new Error(
      `Expected property "${key}" not found at ${contextLabel} — has mEd-api's schema shape changed?`,
    );
  }
  return obj.properties[key];
}

// 4. Splice x-lf into each known vendorExtensions attachment point.

// User.vendorExtensions -> x-lf: ChatUserXLf
{
  const user = requireSchema("User");
  const vendorExtensions = requireProp(
    user,
    "vendorExtensions",
    "components.schemas.User",
  );
  vendorExtensions.properties = {
    "x-lf": { $ref: "#/components/schemas/ChatUserXLf" },
  };
}

// ChatRequest.context.vendorExtensions -> x-lf: ChatContextXLf
{
  const chatRequest = requireSchema("ChatRequest");
  const context = requireProp(
    chatRequest,
    "context",
    "components.schemas.ChatRequest",
  );
  const vendorExtensions = requireProp(
    context,
    "vendorExtensions",
    "components.schemas.ChatRequest.properties.context",
  );
  vendorExtensions.properties = {
    "x-lf": { $ref: "#/components/schemas/ChatContextXLf" },
  };
}

// EvaluateRequest.configuration.vendorExtensions -> x-lf: EvaluateConfigurationXLf
{
  const evaluateRequest = requireSchema("EvaluateRequest");
  const configuration = requireProp(
    evaluateRequest,
    "configuration",
    "components.schemas.EvaluateRequest",
  );
  const vendorExtensions = requireProp(
    configuration,
    "vendorExtensions",
    "components.schemas.EvaluateRequest.properties.configuration",
  );
  vendorExtensions.properties = {
    "x-lf": { $ref: "#/components/schemas/EvaluateConfigurationXLf" },
  };
}

// Feedback has no vendorExtensions slot of its own in mEd-api core — add one
// by convention, matching FeedbackXLf.yml's own documented attachment point.
{
  const feedback = requireSchema("Feedback");
  feedback.properties = feedback.properties || {};
  feedback.properties.vendorExtensions = {
    type: ["object", "null"],
    description:
      "Optional vendor/platform-specific data. Not part of the core µEd-api " +
      "Feedback schema — attached here by convention. See lf-mued-extensions' README.",
    additionalProperties: true,
    properties: {
      "x-lf": { $ref: "#/components/schemas/FeedbackXLf" },
    },
  };
}

// ChatResponse.metadata -> merge LF's fields directly (not nested under
// x-lf), per ChatMetadataXLf.yml's own documented convention.
{
  const chatResponse = requireSchema("ChatResponse");
  const metadata = requireProp(
    chatResponse,
    "metadata",
    "components.schemas.ChatResponse",
  );
  metadata.properties = metadata.properties || {};
  Object.assign(metadata.properties, fragments.ChatMetadataXLf.properties);
}

// 5. Write the composed spec.
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const header = `# GENERATED FILE — do not edit by hand.
# Composed by scripts/compose.mjs from:
#   - mEd-api's bundled openapi.yml (core paths/schemas)
#   - this repo's schemas/*.yml (x-lf vendor extension fragments)
# Regenerate with: npm run compose
`;
fs.writeFileSync(
  outputPath,
  header + yaml.dump(spec, { lineWidth: -1, noRefs: true }),
);
console.log(`Wrote composed spec to ${outputPath}`);