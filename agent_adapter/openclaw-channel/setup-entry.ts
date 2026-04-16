/**
 * Lightweight setup entry point.
 *
 * OpenClaw loads this instead of the full entry when the channel is disabled
 * or unconfigured, avoiding heavy runtime dependencies (Socket.IO etc.).
 * It only exposes config resolution so that the setup wizard can validate
 * the user's configuration.
 */
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agentClubPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(agentClubPlugin);
