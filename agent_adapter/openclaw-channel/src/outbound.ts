import type { AgentClubClient } from "./client.js";
import type { ContentType } from "./types.js";
import { parseSessionKey } from "./session.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface SendTextParams {
  to: string; // session key
  text: string;
}

export interface SendMediaParams {
  to: string; // session key
  filePath: string;
  caption?: string;
}

export interface OutboundResult {
  messageId?: string;
}

/**
 * Create the outbound send functions that OpenClaw's channel plugin interface
 * calls when the AI agent wants to send a message back to the IM.
 */
export function createOutboundHandlers(client: AgentClubClient) {
  return {
    /**
     * Send a text/markdown message to a chat.
     */
    async sendText(params: SendTextParams): Promise<OutboundResult> {
      const parsed = parseSessionKey(params.to);
      if (!parsed) throw new Error(`Invalid session key: ${params.to}`);

      client.sendMessage({
        chat_type: parsed.chatType,
        chat_id: parsed.chatId,
        content: params.text,
        content_type: "text",
      });

      return {};
    },

    /**
     * Upload a file and send it as a media message.
     */
    async sendMedia(params: SendMediaParams): Promise<void> {
      const parsed = parseSessionKey(params.to);
      if (!parsed) throw new Error(`Invalid session key: ${params.to}`);

      const fileBuffer = await readFile(params.filePath);
      const fileName = basename(params.filePath);

      const upload = await client.uploadFile(fileBuffer, fileName);

      const contentType = inferContentType(upload.content_type);

      client.sendMessage({
        chat_type: parsed.chatType,
        chat_id: parsed.chatId,
        content: params.caption || "",
        content_type: contentType,
        file_url: upload.url,
        file_name: upload.filename,
      });
    },
  };
}

function inferContentType(mimeOrCategory: string): ContentType {
  const lower = mimeOrCategory.toLowerCase();
  if (lower === "image" || lower.startsWith("image/")) return "image";
  if (lower === "audio" || lower.startsWith("audio/")) return "audio";
  if (lower === "video" || lower.startsWith("video/")) return "video";
  return "file";
}
