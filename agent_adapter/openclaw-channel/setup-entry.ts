/**
 * Lightweight setup entry point.
 *
 * OpenClaw loads this instead of the full entry when the channel is disabled
 * or unconfigured, avoiding heavy runtime dependencies (Socket.IO etc.).
 * It only exposes config resolution so that the setup wizard can validate
 * the user's configuration.
 */
export { resolveAccount, inspectAccount } from "./src/channel.js";
