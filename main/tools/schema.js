// A small JSON Schema subset validator for MCP tool arguments. It fails
// closed: a keyword it does not implement makes the schema (and so the tool)
// unusable, never silently skipped. Supported: type, enum, const, properties,
// required, additionalProperties (boolean or schema), items, minItems,
// maxItems, minLength, maxLength, minimum, maximum, plus annotations that
// cannot change validity (title, description, default, examples, $schema, $comment).

const crypto = require("node:crypto");

const MAX_ARGS_BYTES = 64 * 1024;
const MAX_DEPTH = 16;
const ANNOTATIONS = new Set(["title", "description", "default", "examples", "$schema", "$comment", "format", "deprecated"]);
const SUPPORTED = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties", "items",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Returns null when the schema only uses what we implement, else why not.
function unsupportedReason(schema, depth = 0, where = "schema") {
  if (depth > MAX_DEPTH) return `${where} is nested too deeply`;
  if (schema === true || schema === undefined) return null;
  if (!isPlain(schema)) return `${where} must be an object`;
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!SUPPORTED.has(key)) return `${where} uses unsupported keyword "${key}"`;
  }
  if (own(schema, "type")) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || !types.every((t) => TYPES.has(t))) return `${where} has an unsupported type`;
  }
  if (own(schema, "enum") && !Array.isArray(schema.enum)) return `${where}.enum must be an array`;
  if (own(schema, "required") && !(Array.isArray(schema.required) && schema.required.every((r) => typeof r === "string"))) {
    return `${where}.required must be an array of strings`;
  }
  if (own(schema, "properties")) {
    if (!isPlain(schema.properties)) return `${where}.properties must be an object`;
    for (const [k, sub] of Object.entries(schema.properties)) {
      const why = unsupportedReason(sub, depth + 1, `${where}.properties.${k}`);
      if (why) return why;
    }
  }
  if (own(schema, "items")) {
    if (Array.isArray(schema.items)) return `${where}.items tuples are unsupported`;
    const why = unsupportedReason(schema.items, depth + 1, `${where}.items`);
    if (why) return why;
  }
  if (own(schema, "additionalProperties") && typeof schema.additionalProperties !== "boolean") {
    const why = unsupportedReason(schema.additionalProperties, depth + 1, `${where}.additionalProperties`);
    if (why) return why;
  }
  for (const k of ["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"]) {
    if (own(schema, k) && !Number.isFinite(schema[k])) return `${where}.${k} must be a number`;
  }
  return null;
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v; // string, boolean, object
}

function typeMatches(declared, v) {
  const actual = typeOf(v);
  return (Array.isArray(declared) ? declared : [declared]).some(
    (t) => t === actual || (t === "number" && actual === "integer")
  );
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(schema, value, at, depth, errors) {
  if (errors.length >= 8) return;
  if (schema === true || schema === undefined) return;
  if (depth > MAX_DEPTH) { errors.push(`${at}: nested too deeply`); return; }
  if (own(schema, "type") && !typeMatches(schema.type, value)) {
    errors.push(`${at}: expected ${[].concat(schema.type).join("|")}, got ${typeOf(value)}`);
    return;
  }
  if (own(schema, "enum") && !schema.enum.some((e) => deepEqual(e, value))) errors.push(`${at}: not one of the allowed values`);
  if (own(schema, "const") && !deepEqual(schema.const, value)) errors.push(`${at}: must equal the constant value`);
  if (typeof value === "string") {
    if (own(schema, "minLength") && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (own(schema, "maxLength") && value.length > schema.maxLength) errors.push(`${at}: too long`);
  }
  if (typeof value === "number") {
    if (own(schema, "minimum") && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (own(schema, "maximum") && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (own(schema, "minItems") && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (own(schema, "maxItems") && value.length > schema.maxItems) errors.push(`${at}: too many items`);
    if (own(schema, "items")) value.forEach((v, i) => check(schema.items, v, `${at}[${i}]`, depth + 1, errors));
  }
  if (isPlain(value)) {
    const props = isPlain(schema.properties) ? schema.properties : {};
    for (const r of schema.required ?? []) if (!own(value, r)) errors.push(`${at}.${r}: required`);
    for (const k of Object.keys(value)) {
      if (own(props, k)) check(props[k], value[k], `${at}.${k}`, depth + 1, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}.${k}: not allowed`);
      else if (isPlain(schema.additionalProperties)) check(schema.additionalProperties, value[k], `${at}.${k}`, depth + 1, errors);
    }
  }
}

// Reject the dangerous key names outright (prototype pollution when a server
// or logger later merges the object) and enforce size/depth before any schema
// logic. JSON.parse makes "__proto__" an own key, which is what we look for.
function checkShape(value, depth = 0) {
  if (depth > MAX_DEPTH) return "arguments are nested too deeply";
  if (Array.isArray(value)) {
    for (const v of value) { const why = checkShape(v, depth + 1); if (why) return why; }
  } else if (isPlain(value)) {
    for (const k of Object.keys(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") return `argument key "${k}" is not allowed`;
      const why = checkShape(value[k], depth + 1);
      if (why) return why;
    }
  } else if (typeof value === "number" && !Number.isFinite(value)) return "arguments contain a non-finite number";
  else if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || value === undefined) return "arguments are not JSON";
  return null;
}

// Validate `args` against a tool's inputSchema. Returns { ok, errors }.
function validateArgs(schema, args) {
  const effective = schema ?? { type: "object" };
  const why = unsupportedReason(effective);
  if (why) return { ok: false, errors: [why] };
  if (!isPlain(args)) return { ok: false, errors: ["arguments must be a JSON object"] };
  let size;
  try { size = Buffer.byteLength(JSON.stringify(args)); } catch { return { ok: false, errors: ["arguments are not JSON"] }; }
  if (size > MAX_ARGS_BYTES) return { ok: false, errors: [`arguments exceed ${MAX_ARGS_BYTES} bytes`] };
  const shape = checkShape(args);
  if (shape) return { ok: false, errors: [shape] };
  const errors = [];
  check(effective, args, "args", 0, errors);
  return { ok: errors.length === 0, errors };
}

// Canonical JSON (sorted keys) so equal values hash equally.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const hashSchema = (schema) => sha256(canonical(schema ?? null));
const hashArgs = (args) => sha256(canonical(args ?? null));

module.exports = { validateArgs, unsupportedReason, hashSchema, hashArgs, canonical, MAX_ARGS_BYTES };
