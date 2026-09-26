import { SearchLightClient, SearchLightConfigError } from "./client.js";
import { loadConfig, type Config } from "./config.js";
import { checkScope, type Scope } from "./scope.js";

export interface AppContext {
  config: Config;
  client: SearchLightClient;
}

export function createContext(env: NodeJS.ProcessEnv = process.env): AppContext {
  const config = loadConfig(env);
  const client = new SearchLightClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
  });
  return { config, client };
}

export function resolveOrganization(ctx: AppContext, explicit?: string): Promise<string> {
  return ctx.client.resolveOrganization(explicit, ctx.config.defaultOrganization);
}

/**
 * Resolve the organization, then check it and the account selection against
 * the cached `GET /api` (see `checkScope`). If `/api` itself fails for any
 * reason other than configuration, the request proceeds unchecked rather than
 * being blocked by an outage of the discovery endpoint.
 */
export async function resolveScope(
  ctx: AppContext,
  explicit: string | undefined,
  accounts: string[] | undefined,
): Promise<Scope> {
  const organization = await resolveOrganization(ctx, explicit);
  let access;
  try {
    access = await ctx.client.getAccess();
  } catch (err) {
    if (err instanceof SearchLightConfigError) throw err;
    return { organization, accounts, notes: [] };
  }
  return checkScope(access, organization, accounts);
}
