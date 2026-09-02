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
]);

export class FilterError extends Error {
  override name = "FilterError";
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
