/**
 * OpenClaw channel plugin entry point for Agent Club IM.
 */
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agentClubPlugin } from "./src/channel.js";
import { setRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "agentclub",
  name: "Agent Club",
  description: "Connect OpenClaw to an Agent Club IM server via Socket.IO",
  plugin: agentClubPlugin,
  setRuntime,
});

export { agentClubPlugin, resolveAccount, inspectAccount } from "./src/channel.js";
export type { InboundMessage } from "./src/gateway.js";
export type { AgentClubClient } from "./src/client.js";
export type {
  AgentClubConfig,
  ResolvedAccount,
  NewMessagePayload,
  SendMessagePayload,
  AuthOkPayload,
  ChatType,
  ContentType,
} from "./src/types.js";
export { toSessionKey, parseSessionKey } from "./src/session.js";
