import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  VAULT_PATH: z.string().min(1).default("./sample-vault"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  BIND_HOST: z.string().min(1).default("127.0.0.1"),
  AGENT_PROVIDER: z.enum(["mock", "hermes"]).default("mock"),
  HERMES_BIN: z.string().min(1).optional(),
  HERMES_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  DASHBOARD_TOKEN: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["debug", "info"]).default("info"),
});

export type Config = {
  vaultPath: string;
  port: number;
  bindHost: string;
  agentProvider: "mock" | "hermes";
  hermesBin: string | undefined;
  hermesTimeoutMs: number;
  dashboardToken: string | undefined;
  isLanExposed: boolean;
};

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  const vaultPath = resolve(env.VAULT_PATH);
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new Error(
      `VAULT_PATH does not exist or is not a directory: ${vaultPath}\n` +
        `Set VAULT_PATH in .env (or rely on the default ./sample-vault).`,
    );
  }

  const isLanExposed = env.BIND_HOST !== "127.0.0.1" && env.BIND_HOST !== "localhost";
  if (isLanExposed && !env.DASHBOARD_TOKEN) {
    throw new Error(
      `Refusing to bind on ${env.BIND_HOST} without DASHBOARD_TOKEN set.\n` +
        `LAN exposure without an auth token would let anyone on the network mutate the vault.\n` +
        `Either set DASHBOARD_TOKEN in .env or leave BIND_HOST=127.0.0.1.`,
    );
  }

  return {
    vaultPath,
    port: env.PORT,
    bindHost: env.BIND_HOST,
    agentProvider: env.AGENT_PROVIDER,
    hermesBin: env.HERMES_BIN,
    hermesTimeoutMs: env.HERMES_TIMEOUT_MS,
    dashboardToken: env.DASHBOARD_TOKEN,
    isLanExposed,
  };
}
