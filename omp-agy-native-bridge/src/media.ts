import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

const IMAGE_MEDIA_TYPES = new Map<string, { normalized: string; extension: string }>([
  ["image/png", { normalized: "image/png", extension: "png" }],
  ["image/jpeg", { normalized: "image/jpeg", extension: "jpg" }],
  ["image/jpg", { normalized: "image/jpeg", extension: "jpg" }],
  ["image/gif", { normalized: "image/gif", extension: "gif" }],
  ["image/webp", { normalized: "image/webp", extension: "webp" }],
  ["image/bmp", { normalized: "image/bmp", extension: "bmp" }],
  ["image/tiff", { normalized: "image/tiff", extension: "tiff" }],
  ["image/tif", { normalized: "image/tiff", extension: "tiff" }],
  ["image/svg+xml", { normalized: "image/svg+xml", extension: "svg" }],
]);

interface BridgeImageInput {
  attachmentIndex: number;
  messageIndex: number;
  contentIndex: number;
  mediaType: string;
  extension: string;
  bytes: Buffer;
}

export interface StagedBridgeImage {
  attachmentIndex: number;
  messageIndex: number;
  contentIndex: number;
  mediaType: string;
  sizeBytes: number;
  absolutePath: string;
  promptPath: string;
}

export interface StagedBridgeImages {
  attachments: StagedBridgeImage[];
  workspaceDirectory?: string;
  cleanup(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageBlocks(context: { messages?: readonly unknown[] }): Array<{
  messageIndex: number;
  contentIndex: number;
  block: Record<string, unknown>;
}> {
  const out: Array<{ messageIndex: number; contentIndex: number; block: Record<string, unknown> }> = [];
  for (const [messageIndex, message] of (context.messages ?? []).entries()) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const [contentIndex, block] of message.content.entries()) {
      if (isRecord(block) && block.type === "image") out.push({ messageIndex, contentIndex, block });
    }
  }
  return out;
}

export function hasBridgeImages(context: { messages?: readonly unknown[] }): boolean {
  return imageBlocks(context).length > 0;
}

function normalizedMediaType(value: string): string | undefined {
  return IMAGE_MEDIA_TYPES.get(value.toLowerCase())?.normalized;
}

function decodeImageData(data: unknown, expectedMediaType: string, label: string): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (typeof data !== "string") throw new Error(`${label}.data must be base64 text or binary bytes`);

  const trimmed = data.trim();
  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(trimmed);
  if (dataUrl) {
    const actual = normalizedMediaType(dataUrl[1]) ?? dataUrl[1].toLowerCase();
    if (actual !== expectedMediaType) {
      throw new Error(`${label} data URL media type ${dataUrl[1]} does not match ${expectedMediaType}`);
    }
  }
  const encoded = (dataUrl?.[2] ?? trimmed).replace(/\s+/g, "");
  if (encoded === "" || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error(`${label}.data is not valid base64`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw new Error(`${label}.data decoded to an empty image`);
  return bytes;
}

function collectBridgeImages(
  context: { messages?: readonly unknown[] },
  limits: { maxImageCount: number; maxImageBytes: number },
): BridgeImageInput[] {
  const blocks = imageBlocks(context);
  if (blocks.length > limits.maxImageCount) {
    throw new Error(`OMP supplied ${blocks.length} images, above maxImageCount=${limits.maxImageCount}`);
  }

  let totalBytes = 0;
  return blocks.map(({ messageIndex, contentIndex, block }, index) => {
    const attachmentIndex = index + 1;
    const rawMediaType = String(block.mimeType ?? block.mediaType ?? "").toLowerCase();
    const media = IMAGE_MEDIA_TYPES.get(rawMediaType);
    const label = `OMP image attachment ${attachmentIndex}`;
    if (!media) {
      throw new Error(
        `${label} has unsupported media type ${rawMediaType || "unknown"}; supported: ${[...IMAGE_MEDIA_TYPES.keys()].join(", ")}`,
      );
    }
    const bytes = decodeImageData(block.data, media.normalized, label);
    totalBytes += bytes.length;
    if (totalBytes > limits.maxImageBytes) {
      throw new Error(
        `OMP image attachments total ${totalBytes.toLocaleString()} bytes, above maxImageBytes=${limits.maxImageBytes.toLocaleString()}`,
      );
    }
    return {
      attachmentIndex,
      messageIndex,
      contentIndex,
      mediaType: media.normalized,
      extension: media.extension,
      bytes,
    };
  });
}

function toPromptPath(absolutePath: string): string {
  return absolutePath.split(sep).join("/");
}

export async function stageBridgeImages(
  context: { messages?: readonly unknown[] },
  limits: { maxImageCount: number; maxImageBytes: number },
): Promise<StagedBridgeImages> {
  const images = collectBridgeImages(context, limits);
  if (images.length === 0) return { attachments: [], cleanup: async () => {} };

  const directory = await mkdtemp(resolve(tmpdir(), "omp-agy-media-"));
  await chmod(directory, 0o700);
  try {
    const attachments: StagedBridgeImage[] = [];
    for (const image of images) {
      const absolutePath = resolve(directory, `image-${image.attachmentIndex}.${image.extension}`);
      await writeFile(absolutePath, image.bytes, { mode: 0o600 });
      attachments.push({
        attachmentIndex: image.attachmentIndex,
        messageIndex: image.messageIndex,
        contentIndex: image.contentIndex,
        mediaType: image.mediaType,
        sizeBytes: image.bytes.length,
        absolutePath,
        promptPath: toPromptPath(absolutePath),
      });
    }
    return {
      attachments,
      workspaceDirectory: directory,
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function formatBridgeImageSection(attachments: readonly StagedBridgeImage[]): string {
  if (attachments.length === 0) return "";
  const lines = [
    "# OMP image attachments",
    "The @file mentions below are temporary media attachments supplied by OMP. They correspond to the image_attachment placeholders in the conversation. Inspect them as prompt media; do not invoke Antigravity file tools or treat them as permission to inspect any other workspace file.",
  ];
  for (const attachment of attachments) {
    lines.push(
      `- Attachment ${attachment.attachmentIndex}: conversation message ${attachment.messageIndex + 1}, content block ${attachment.contentIndex + 1}, ${attachment.mediaType}, ${attachment.sizeBytes} bytes`,
      `  @${attachment.promptPath}`,
    );
  }
  return lines.join("\n");
}
