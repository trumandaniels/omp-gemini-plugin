import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("stageBridgeImages writes a private workspace file and removes it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agy-media-test-"));
  try {
    const staged = await stageBridgeImages(context(), cwd, {
      maxImageCount: 5,
      maxImageBytes: 1_000_000,
    });
    assert.equal(staged.attachments.length, 1);
    assert.equal(staged.attachments[0].messageIndex, 0);
    assert.equal(staged.attachments[0].contentIndex, 1);
    assert.match(staged.attachments[0].promptPath, /^\.\/\.omp-agy-media-/);
    assert.deepEqual(await readFile(staged.attachments[0].absolutePath), onePixelPng);
    assert.match(formatBridgeImageSection(staged.attachments), /@\.\/\.omp-agy-media-/);
    const path = staged.attachments[0].absolutePath;
    await staged.cleanup();
    await assert.rejects(access(path));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stageBridgeImages accepts matching data URLs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agy-media-test-"));
  try {
    const dataUrl = `data:image/png;base64,${onePixelPng.toString("base64")}`;
    const staged = await stageBridgeImages(context(dataUrl), cwd, {
      maxImageCount: 5,
      maxImageBytes: 1_000_000,
    });
    assert.equal(staged.attachments[0].sizeBytes, onePixelPng.length);
    await staged.cleanup();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stageBridgeImages rejects aggregate byte overflow", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agy-media-test-"));
  try {
    await assert.rejects(
      stageBridgeImages(context(), cwd, { maxImageCount: 5, maxImageBytes: 1 }),
      /above maxImageBytes/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stageBridgeImages rejects unsupported media", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agy-media-test-"));
  try {
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
        cwd,
        { maxImageCount: 5, maxImageBytes: 1_000_000 },
      ),
      /unsupported media type image\/heic/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
