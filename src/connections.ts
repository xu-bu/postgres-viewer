export type ConnectionConfig = { host: string; port: string; username?: string; password?: string } | null;

const STORAGE_KEY = "postgresui.connections.v1";

export function loadConnections(storage: Storage): ConnectionConfig[] | null {
  const stored = storage.getItem(STORAGE_KEY);
  if (stored === null) return null;
  const configs: unknown = JSON.parse(stored);
  if (!Array.isArray(configs) || !configs.every((config) => config === null || (
    typeof config === "object" && typeof config.host === "string" && config.host.trim() !== "" &&
    typeof config.port === "string" && /^\d+$/.test(config.port) &&
    Number(config.port) >= 1 && Number(config.port) <= 65535 &&
    (config.username === undefined || (typeof config.username === "string" && config.username.trim() !== ""))
  ))) {
    throw new Error("Saved connections are invalid");
  }
  return configs.map(connectionProfile);
}

function connectionProfile(config: ConnectionConfig): ConnectionConfig {
  if (config === null) return null;
  return {
    host: config.host,
    port: config.port,
    ...(config.username === undefined ? {} : { username: config.username }),
  };
}

export function saveConnections(storage: Storage, configs: ConnectionConfig[]): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(configs.map(connectionProfile)));
}

export function sameConnection(left: ConnectionConfig, right: ConnectionConfig): boolean {
  return left === null || right === null ? left === right :
    left.host === right.host && left.port === right.port && left.username === right.username;
}
