import type { AccessInfo, OrganizationInfo } from "./client.js";
import { ALL_ORGANIZATIONS, SearchLightConfigError, reachableAccounts } from "./client.js";

export interface Scope {
  organization: string;
  accounts: string[] | undefined;
  subset: string | undefined;
  notes: string[];
}

/**
 * Check an organization, subset and account selection against `GET /api`
 * before a request is sent. Since 2026-09-21 SearchLight returns 404 for an
 * account key in the path when the account is reached through an
 * organization, and for any `account`/`accounts` value outside the path's
 * organization. An unknown subset, or an account outside the subset, is a 404
 * too. All of these still count against the hourly limit, so they are
 * rerouted or refused here instead.
 *
 * `-` as the organization means every account the key reaches. The API
 * accepts it on events, benchmarks and insights, and silently ignores
 * `subset` with it (checked live 2026-11-11), so a subset is refused there.
 */
export function checkScope(
  access: AccessInfo,
  organization: string,
  accounts: string[] | undefined,
  subset?: string | undefined,
): Scope {
  const orgs = access.organizations ?? [];

  if (organization === ALL_ORGANIZATIONS) {
    if (subset !== undefined) throw new SearchLightConfigError(allWithSubsetMessage(subset));
    const known = reachableAccounts(orgs);
    if (accounts && known.length > 0) {
      const outside = accounts.filter((a) => !known.includes(a));
      if (outside.length > 0) {
        throw new SearchLightConfigError(
          `${quoteList(outside)} ${outside.length === 1 ? "is" : "are"} not an account this key can reach. Accounts it reaches: ${known.join(", ")}.`,
        );
      }
    }
    return { organization, accounts, subset: undefined, notes: [] };
  }

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
    if (subset !== undefined) checkSubset(org, subset, accounts);
    return { organization, accounts, subset, notes: [] };
  }

  const parents = orgs.filter((o) => (o.accounts ?? []).includes(organization));
  if (parents.length === 1 && parents[0]) {
    const parent = parents[0];
    if (accounts && accounts.some((a) => a !== organization)) {
      throw new SearchLightConfigError(
        `"${organization}" is an account under "${parent.organization}", not an organization. Pass organization="${parent.organization}" with the accounts you want (${quoteList(accounts)}), or drop the account filter.`,
      );
    }
    if (subset !== undefined) checkSubset(parent, subset, [organization]);
    return {
      organization: parent.organization,
      accounts: [organization],
      subset,
      notes: [
        `"${organization}" is an account, so the request went through its organization "${parent.organization}" with account=${organization}. SearchLight stopped accepting account keys in the path on 2026-09-21.`,
      ],
    };
  }

  if (parents.length > 1) {
    throw new SearchLightConfigError(
      `"${organization}" is an account under several organizations (${parents.map((p) => p.organization).join(", ")}). Pass one of them as organization and "${organization}" as account.`,
    );
  }

  // Organizations that used to sit inside another became subsets on 2026-10-12; their old key 404s in the path.
  const holders = orgs.filter((o) => (o.subsets ?? []).some((s) => s.subset === organization));
  if (holders.length === 1 && holders[0]) {
    const holder = holders[0];
    if (subset !== undefined && subset !== organization) {
      throw new SearchLightConfigError(
        `"${organization}" is a subset of "${holder.organization}", not an organization, and subset="${subset}" was also given. Pass organization="${holder.organization}" with one subset.`,
      );
    }
    const scope = checkScope(access, holder.organization, accounts, organization);
    return {
      ...scope,
      notes: [
        `"${organization}" is a subset of organization "${holder.organization}", so the request went through "${holder.organization}" with subset=${organization}. SearchLight turned nested organizations into subsets on 2026-10-12.`,
        ...scope.notes,
      ],
    };
  }
  if (holders.length > 1) {
    throw new SearchLightConfigError(
      `"${organization}" is a subset under several organizations (${holders.map((h) => h.organization).join(", ")}). Pass one of them as organization and subset="${organization}".`,
    );
  }

  const options = orgs.map((o) => o.organization);
  throw new SearchLightConfigError(
    `"${organization}" is not an organization, account or subset this key can reach.${options.length ? ` Organizations: ${options.join(", ")}.` : ""} Call searchlight_list_access to see the account keys and subsets under each, or pass "${ALL_ORGANIZATIONS}" for every account the key reaches.`,
  );
}

function checkSubset(org: OrganizationInfo, subset: string, accounts: string[] | undefined): void {
  const subsets = org.subsets ?? [];
  const found = subsets.find((s) => s.subset === subset);
  if (!found) {
    throw new SearchLightConfigError(
      subsets.length > 0
        ? `"${subset}" is not a subset of organization "${org.organization}". Subsets it lists: ${subsets.map((s) => s.subset).join(", ")}.`
        : `"${subset}" is not a subset of organization "${org.organization}"; it lists no subsets. Drop subset, or call searchlight_list_access to see the organizations that have subsets.`,
    );
  }
  const members = found.accounts ?? [];
  if (accounts && members.length > 0) {
    const outside = accounts.filter((a) => !members.includes(a));
    if (outside.length > 0) {
      throw new SearchLightConfigError(
        `${quoteList(outside)} ${outside.length === 1 ? "is" : "are"} not in subset "${subset}" of "${org.organization}". Accounts in it: ${members.join(", ")}.`,
      );
    }
  }
}

function allWithSubsetMessage(subset: string): string {
  return `subset="${subset}" cannot be combined with organization "${ALL_ORGANIZATIONS}": SearchLight ignores subset there and returns every account. Pass the subset's organization instead.`;
}

/**
 * Refuse `-` with a subset before `/api` is loaded; the answer does not
 * depend on it.
 */
export function assertSubsetAllowed(organization: string, subset: string | undefined): void {
  if (organization === ALL_ORGANIZATIONS && subset !== undefined) {
    throw new SearchLightConfigError(allWithSubsetMessage(subset));
  }
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
  const rawSubset = params.subset === undefined || params.subset === null ? "" : String(params.subset).trim();
  const subset = rawSubset || undefined;
  try {
    const scope = checkScope(access, segment, accounts.length ? accounts : undefined, subset);
    if (scope.organization !== segment) {
      const parent = (access.organizations ?? []).find((o) => o.organization === scope.organization);
      if (!(parent?.accounts ?? []).includes(segment)) {
        return `"${segment}" is a subset of "${scope.organization}", not an organization, and SearchLight returns 404 for it in the path. Use /api/${scope.organization}/... with subset=${segment}.`;
      }
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
