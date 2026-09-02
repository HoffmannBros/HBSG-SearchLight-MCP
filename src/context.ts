import { SearchLightClient } from "./client.js";
import { loadConfig, type Config } from "./config.js";

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
