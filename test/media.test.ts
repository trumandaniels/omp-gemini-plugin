import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import test from "node:test";

import { formatBridgeImageSection, hasBridgeImages, stageBridgeImages } from "../src/media.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function context(data: unknown = onePixelPng.toString("base64")) {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", data, mimeType: "image/png" },
        ],
      },
    ],
  };
}

test("hasBridgeImages detects image blocks", () => {
  assert.equal(hasBridgeImages(context()), true);
  assert.equal(hasBridgeImages({ messages: [{ role: "user", content: "text" }] }), false);
});

test("stageBridgeImages writes a private OS-temporary file and removes it", async () => {
  const staged = await stageBridgeImages(context(), {
    maxImageCount: 5,
    maxImageBytes: 1_000_000,
  });
  assert.equal(staged.attachments.length, 1);
  assert.equal(staged.attachments[0].messageIndex, 0);
  assert.equal(staged.attachments[0].contentIndex, 1);
  assert.equal(dirname(staged.workspaceDirectory ?? ""), tmpdir());
  assert.equal(isAbsolute(staged.attachments[0].promptPath), true);
  assert.deepEqual(await readFile(staged.attachments[0].absolutePath), onePixelPng);
  assert.match(formatBridgeImageSection(staged.attachments), /@\/.*omp-agy-media-/);
  const path = staged.attachments[0].absolutePath;
  await staged.cleanup();
  await assert.rejects(access(path));
});

test("stageBridgeImages accepts matching data URLs", async () => {
  const dataUrl = `data:image/png;base64,${onePixelPng.toString("base64")}`;
  const staged = await stageBridgeImages(context(dataUrl), {
    maxImageCount: 5,
    maxImageBytes: 1_000_000,
  });
  assert.equal(staged.attachments[0].sizeBytes, onePixelPng.length);
  await staged.cleanup();
});

test("stageBridgeImages rejects aggregate byte overflow", async () => {
  await assert.rejects(
    stageBridgeImages(context(), { maxImageCount: 5, maxImageBytes: 1 }),
    /above maxImageBytes/,
  );
});

test("stageBridgeImages rejects unsupported media", async () => {
  await assert.rejects(
    stageBridgeImages(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image", data: onePixelPng.toString("base64"), mimeType: "image/heic" }],
          },
        ],
      },
      { maxImageCount: 5, maxImageBytes: 1_000_000 },
    ),
    /unsupported media type image\/heic/,
  );
});
