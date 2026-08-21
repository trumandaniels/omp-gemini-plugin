import assert from "node:assert/strict";
import test from "node:test";

import { Semaphore } from "../src/semaphore.ts";

test("semaphore bounds concurrent agy processes", async () => {
  const semaphore = new Semaphore(1);
  const firstRelease = await semaphore.acquire();
  let secondAcquired = false;
  const second = semaphore.acquire().then((release) => {
    secondAcquired = true;
    release();
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondAcquired, false);
  firstRelease();
  await second;
  assert.equal(semaphore.active, 0);
});

test("queued semaphore acquisition observes cancellation", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const pending = semaphore.acquire(controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  release();
});
