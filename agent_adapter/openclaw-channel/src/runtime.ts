import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { AgentClubClient } from "./client.js";

// -- Plugin runtime store ---------------------------------------------------

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "agentclub",
  errorMessage: "agentclub runtime not initialized",
});

export const setRuntime = store.setRuntime;
export const getRuntime = store.getRuntime;
export const tryGetRuntime = store.tryGetRuntime;

// -- Active Socket.IO client ------------------------------------------------

let _activeClient: AgentClubClient | null = null;

export function setActiveClient(client: AgentClubClient | null): void {
  _activeClient = client;
}

export function getActiveClient(): AgentClubClient {
  if (!_activeClient) throw new Error("Agent Club client not connected");
  return _activeClient;
}

export function tryGetActiveClient(): AgentClubClient | null {
  return _activeClient;
}
