export const CHANNEL_ID = "agentclub";
export const DEFAULT_ACCOUNT_ID = "default";
export const SESSION_KEY_SEPARATOR = ":";
export const LOG_PREFIX = `[${CHANNEL_ID}.openclaw]`;
export const INITIAL_RETRY_DELAY_MS = 1000;
export const MAX_RETRY_DELAY_MS = 30000;
export const SOCKETIO_INFINITE_RECONNECT_ATTEMPTS = Infinity;
export const SERVER_RESPONSE_TIMEOUT_MS = 10000;
export const LOG_MESSAGE_PREVIEW_CHARS = 80;
export const LOG_BODY_PREVIEW_CHARS = 200;

// Matches the upload limit of the Agent Club IM server (see backend
// `config.py` MAX_CONTENT_LENGTH). `saveMediaBuffer` defaults to 5MB which
// would truncate large attachments; we raise it to the IM server's own cap.
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
