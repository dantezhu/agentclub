/**
 * OpenClaw channel plugin entry point for Agent Club IM.
 *
 * This module is loaded by OpenClaw at runtime. It registers the channel
 * plugin so that the AI agent can send and receive messages through the
 * Agent Club IM server over Socket.IO.
 */
export {
  createAgentClubChannelPlugin,
  resolveAccount,
  inspectAccount,
} from "./src/channel.js";

export type { AgentClubChannelPlugin, ActivateOptions } from "./src/channel.js";
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
