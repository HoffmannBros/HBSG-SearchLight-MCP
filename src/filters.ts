/**
 * SearchLight filter encoding.
 *
 * The API accepts `field=value` for simple equality and `field=<JSON>` for
 * expressions such as ["or","Organic","Advertising"], ["not",x],
 * ["regex","gmb|gbp","ui"], ["gte",100], ["empty"], ["notEmpty"], and
 * ["and",[...],[...]]. Cross-field logic goes in a separate `filter`
 * parameter holding a JSON expression like ["or",{...},{...}].
 */

export type FilterValue = string | number | boolean | null | unknown[] | Record<string, unknown>;
export type Filters = Record<string, FilterValue>;

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Query parameters the endpoints reserve; they cannot be used as filter keys. */
export const RESERVED_PARAMS = new Set([
  "fields",
  "start",
  "end",
  "account",
  "accounts",
  "interval",
  "month",
  "filter",
  "subset",
]);

export class FilterError extends Error {
  override name = "FilterError";
}

/** Operators a per-field filter expression may start with (docs, Filtering page). */
export const FILTER_OPERATORS = ["or", "and", "not", "empty", "notEmpty", "regex", "gt", "gte", "lt", "lte"] as const;
const OPERATOR_SET = new Set<string>(FILTER_OPERATORS);

/** Spellings people reach for (Mongo-style, SQL-style) mapped to the operator SearchLight means. */
const OPERATOR_ALIASES: Record<string, string> = {
  in: "or",
  $in: "or",
  any: "or",
  $or: "or",
  $and: "and",
  $not: "not",
  ne: "not",
  $ne: "not",
  neq: "not",
  $nin: "not",
  nin: "not",
  $gt: "gt",
  $gte: "gte",
  $lt: "lt",
  $lte: "lte",
  $regex: "regex",
  $exists: "notEmpty",
};

function canonicalOperator(name: string): string | undefined {
  if (OPERATOR_SET.has(name)) return name;
  const lower = name.toLowerCase();
  const exact = FILTER_OPERATORS.find((op) => op.toLowerCase() === lower);
  return exact ?? OPERATOR_ALIASES[name] ?? OPERATOR_ALIASES[lower];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Arguments to an operator, flattened when they were given as one list (`{"in": [...]}`). */
function argsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(suggestFilter) : [suggestFilter(value)];
}

/**
 * Best guess at the operator form the caller meant, or undefined when there is
 * no sensible guess. Plain lists become `or`; `{"$gt": 0}` becomes
 * `["gt", 0]`; valid expressions are rebuilt with their arguments corrected.
 */
function suggestFilter(value: unknown): unknown {
  if (Array.isArray(value)) {
    const [head, ...rest] = value;
    // Only treat the head as a misspelt operator when it plainly is one
    // (other casing, or a $-prefixed or `in`/`nin` alias); otherwise it is a value.
    if (typeof head === "string" && (head.startsWith("$") || /^n?in$/i.test(head) || FILTER_OPERATORS.some((op) => op.toLowerCase() === head.toLowerCase()))) {
      const op = canonicalOperator(head);
      if (op === "not" && rest.length > 1) return ["not", ["or", ...rest.map(suggestFilter)]];
      if (op) return [op, ...rest.map(suggestFilter)];
    }
    return ["or", ...value.map(suggestFilter)];
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [key, arg] = entries[0]!;
      const op = canonicalOperator(key);
      if (op === "notEmpty") return arg === false ? ["empty"] : ["notEmpty"];
      if (op === "empty") return ["empty"];
      if (op === "not") {
        const args = argsOf(arg);
        return ["not", args.length === 1 ? args[0] : ["or", ...args]];
      }
      if (op) return [op, ...argsOf(arg)];
    }
    if (entries.length > 1 && entries.every(([k]) => canonicalOperator(k))) {
      return ["and", ...entries.map(([k, v]) => suggestFilter({ [k]: v }))];
    }
    return undefined;
  }
  return value;
}

/**
 * Why a per-field filter value would silently match nothing, or null when it
 * is fine. SearchLight reads every array as `[operator, ...arguments]` and
 * answers a plain list or an object with 200 and no rows, so both are refused
 * here instead. Operators nest, so arguments are checked recursively.
 */
export function filterValueProblem(value: unknown): string | null {
  if (isPlainObject(value)) {
    return `${JSON.stringify(value)} is an object; SearchLight has no object filter syntax`;
  }
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return "[] is an empty list";
  const head = value[0];
  if (typeof head !== "string" || !OPERATOR_SET.has(head)) {
    return `${JSON.stringify(value)} does not start with an operator; SearchLight reads every list as [operator, ...arguments]`;
  }
  for (const arg of value.slice(1)) {
    const inner = filterValueProblem(arg);
    if (inner) return inner;
  }
  return null;
}

/** Throw a FilterError naming the field, the problem, and the corrected operator form. */
export function assertFilterValue(name: string, value: unknown): void {
  const problem = filterValueProblem(value);
  if (!problem) return;
  const suggestion = suggestFilter(value);
  const fix =
    suggestion !== undefined && filterValueProblem(suggestion) === null
      ? `Use ${name}=${JSON.stringify(suggestion)} instead.`
      : `Use the operator form, for example ${name}=["or", "A", "B"] to match any of several values or ${name}=["gte", 100] for a comparison.`;
  throw new FilterError(
    `Filter on ${name}: ${problem}, and the API answers that form with an empty result instead of an error. ${fix} Operators: ${FILTER_OPERATORS.join(", ")}. Not sent, so it cost no API call.`,
  );
}

/**
 * The value SearchLight will see for a query parameter: it parses values as
 * JSON where it can, so a string holding a JSON list or object is read as one.
 */
function parsedParamValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * Check the per-field filters in an events query string (as the raw tool
 * sends them). Reserved parameters and the cross-field `filter` are skipped;
 * the latter's branches are objects by design.
 */
export function filterParamsViolation(params: Record<string, unknown>): FilterError | null {
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || RESERVED_PARAMS.has(name) || name === "subset") continue;
    try {
      assertFilterValue(name, parsedParamValue(value));
    } catch (err) {
      if (err instanceof FilterError) return err;
      throw err;
    }
  }
  return null;
}

/** Strings pass through unchanged; everything else is JSON-encoded. */
export function encodeFilterValue(value: FilterValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function assertFieldName(name: string): void {
  if (!FIELD_NAME.test(name)) {
    throw new FilterError(
      `"${name}" is not a valid field name. Use the camelCase names from searchlight_list_fields (for example attributionCategory).`,
    );
  }
  if (RESERVED_PARAMS.has(name)) {
    throw new FilterError(
      `"${name}" is a request parameter, not a filterable field. Pass it as its own argument instead of inside filters.`,
    );
  }
}

/**
 * Convert the tool-level filter inputs into query parameters.
 * Returns a plain object so callers can merge it into URLSearchParams.
 */
export function filtersToParams(filters?: Filters, crossField?: unknown[]): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters) {
    for (const [name, value] of Object.entries(filters)) {
      assertFieldName(name);
      if (value === undefined) continue;
      assertFilterValue(name, parsedParamValue(value));
      params[name] = encodeFilterValue(value);
    }
  }
  if (crossField !== undefined) {
    if (!Array.isArray(crossField) || crossField.length === 0 || typeof crossField[0] !== "string") {
      throw new FilterError(
        'filter must be a JSON expression array whose first element is an operator, for example ["or", {"attributionCategory": "Advertising"}, {"total": ["gte", 50000]}].',
      );
    }
    params.filter = JSON.stringify(crossField);
  }
  return params;
}
