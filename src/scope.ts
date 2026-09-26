import type { AccessInfo } from "./client.js";
import { SearchLightConfigError } from "./client.js";

export interface Scope {
  organization: string;
  accounts: string[] | undefined;
  notes: string[];
}

/**
 * Check an organization and account selection against `GET /api` before a
 * request is sent. Since 2026-09-21 SearchLight returns 404 for an account key
 * in the path when the account is reached through an organization, and for any
 * `account`/`accounts` value outside the path's organization. Both still count
 * against the hourly limit, so they are rerouted or refused here instead.
 */
export function checkScope(access: AccessInfo, organization: string, accounts: string[] | undefined): Scope {
  const orgs = access.organizations ?? [];
  const org = orgs.find((o) => o.organization === organization);

  if (org) {
    const known = org.accounts ?? [];
    // An account that is its own organization may list no accounts; nothing to check against.
    if (accounts && known.length > 0) {
      const outside = accounts.filter((a) => a !== organization && !known.includes(a));
      if (outside.length > 0) {
        throw new SearchLightConfigError(
          `${quoteList(outside)} ${outside.length === 1 ? "is" : "are"} not under organization "${organization}". Accounts under it: ${known.join(", ")}.`,
        );
      }
    }
    return { organization, accounts, notes: [] };
  }

  const parents = orgs.filter((o) => (o.accounts ?? []).includes(organization));
  if (parents.length === 1 && parents[0]) {
    const parent = parents[0].organization;
    if (accounts && accounts.some((a) => a !== organization)) {
      throw new SearchLightConfigError(
        `"${organization}" is an account under "${parent}", not an organization. Pass organization="${parent}" with the accounts you want (${quoteList(accounts)}), or drop the account filter.`,
      );
    }
    return {
      organization: parent,
      accounts: [organization],
      notes: [
        `"${organization}" is an account, so the request went through its organization "${parent}" with account=${organization}. SearchLight stopped accepting account keys in the path on 2026-09-21.`,
      ],
    };
  }

  const options = orgs.map((o) => o.organization);
  if (parents.length > 1) {
    throw new SearchLightConfigError(
      `"${organization}" is an account under several organizations (${parents.map((p) => p.organization).join(", ")}). Pass one of them as organization and "${organization}" as account.`,
    );
  }
  throw new SearchLightConfigError(
    `"${organization}" is not an organization or account this key can reach.${options.length ? ` Organizations: ${options.join(", ")}.` : ""} Call searchlight_list_access to see the account keys under each.`,
  );
}

/**
 * For a raw `/api/<segment>/...` path, return why the API will refuse it, or
 * undefined when it looks fine. The raw tool refuses rather than rewrites.
 */
export function rawPathProblem(access: AccessInfo, path: string, params: Record<string, unknown>): string | undefined {
  const m = /^\/api\/([^/?#]+)/.exec(path);
  if (!m || !m[1]) return undefined;
  const segment = decodeURIComponent(m[1]);
  const accounts = [params.account, ...String(params.accounts ?? "").split(",")]
    .map((a) => (a === undefined || a === null ? "" : String(a).trim()))
    .filter(Boolean);
  try {
    const scope = checkScope(access, segment, accounts.length ? accounts : undefined);
    if (scope.organization !== segment) {
      return `"${segment}" is an account under "${scope.organization}", and SearchLight returns 404 for account keys in the path since 2026-09-21. Use /api/${scope.organization}/... with account=${segment}.`;
    }
    return undefined;
  } catch (err) {
    if (err instanceof SearchLightConfigError) return err.message;
    throw err;
  }
}

function quoteList(items: string[]): string {
  return items.map((i) => `"${i}"`).join(", ");
}
