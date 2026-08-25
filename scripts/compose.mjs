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

// 5. Inject example request/response payloads showing x-lf populated,
//    alongside mEd-api's existing generic named examples. The x-lf portion
//    of each is pulled from the fragment's own `examples[0]` (not
//    hand-duplicated), so these can never drift out of sync with the
//    schema-level examples.
function requireExamplesMap(pathKey, method, part, statusCode) {
  const operation = spec.paths?.[pathKey]?.[method];
  if (!operation) {
    throw new Error(
      `Expected operation ${method.toUpperCase()} ${pathKey} not found — has mEd-api's spec shape changed?`,
    );
  }
  const content =
    part === "requestBody"
      ? operation.requestBody?.content?.["application/json"]
      : operation.responses?.[statusCode]?.content?.["application/json"];
  if (!content) {
    throw new Error(
      `Expected ${part} application/json content not found on ${method.toUpperCase()} ${pathKey} — has mEd-api's spec shape changed?`,
    );
  }
  content.examples = content.examples || {};
  return content.examples;
}

function addExample(examplesMap, key, example) {
  if (examplesMap[key]) {
    throw new Error(
      `Example name collision: "${key}" already exists in mEd-api's spec. Rename the new example.`,
    );
  }
  examplesMap[key] = example;
}

// Chat request: context + user x-lf populated.
addExample(
  requireExamplesMap("/chat", "post", "requestBody"),
  "chatWithLfExtensions",
  {
    summary: "Chat request with Lambda Feedback (x-lf) vendor extensions",
    value: {
      messages: [
        {
          role: "USER",
          content:
            "Can you give me a hint for converting 11010 from binary to decimal?",
        },
      ],
      user: {
        type: "LEARNER",
        vendorExtensions: { "x-lf": fragments.ChatUserXLf.examples[0] },
      },
      context: {
        vendorExtensions: { "x-lf": fragments.ChatContextXLf.examples[0] },
      },
    },
  },
);

// Chat response: metadata carrying LF's flat response-side fields.
addExample(
  requireExamplesMap("/chat", "post", "responses", "200"),
  "chatWithLfExtensionsResponse",
  {
    summary: "Chat response with Lambda Feedback (x-lf) metadata",
    value: {
      output: {
        role: "ASSISTANT",
        content:
          "Think about what each binary digit represents as a power of 2, starting from the right. Try adding up the values of the digits that are 1.",
      },
      metadata: fragments.ChatMetadataXLf.examples[0],
    },
  },
);

// Evaluate request: configuration.vendorExtensions.x-lf populated.
addExample(
  requireExamplesMap("/evaluate", "post", "requestBody"),
  "withLfExtensions",
  {
    summary:
      "Evaluate request with Lambda Feedback (x-lf) grading configuration",
    value: {
      submission: {
        submissionId: "sub-lf-001",
        taskId: "task-algebra-201",
        type: "MATH",
        format: "sympy",
        content: { expression: "x**2 + 2*x + 1" },
        submittedAt: "2025-12-16T09:30:00Z",
        version: 1,
      },
      configuration: {
        vendorExtensions: {
          "x-lf": fragments.EvaluateConfigurationXLf.examples[0],
        },
      },
    },
  },
);

// Evaluate response: one Feedback item's vendorExtensions.x-lf populated.
addExample(
  requireExamplesMap("/evaluate", "post", "responses", "200"),
  "exampleResponseWithLfExtensions",
  {
    summary: "Feedback response with Lambda Feedback (x-lf) grading details",
    value: [
      {
        feedbackId: "fb-lf-1",
        title: "Correct, fully expanded",
        message: "Your answer matches the fully expanded reference form.",
        awardedPoints: 1.0,
        vendorExtensions: { "x-lf": fragments.FeedbackXLf.examples[0] },
      },
    ],
  },
);

// 6. Write the composed spec.
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