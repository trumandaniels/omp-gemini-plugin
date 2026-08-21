import assert from "node:assert/strict";
import test from "node:test";

import { buildAgyEnvironment } from "../src/env.ts";

test("sanitized agy environment preserves keyring plumbing and removes unrelated secrets", () => {
  const output = buildAgyEnvironment(true, {
    PATH: "/bin",
    HOME: "/home/test",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    GEMINI_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    NORMAL_SETTING: "kept",
  });
  assert.equal(output.PATH, "/bin");
  assert.equal(output.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(output.NORMAL_SETTING, "kept");
  assert.equal(output.GEMINI_API_KEY, undefined);
  assert.equal(output.GITHUB_TOKEN, undefined);
});

test("explicit passthrough can retain a named secret", () => {
  const output = buildAgyEnvironment(true, {
    AGY_BRIDGE_PASSTHROUGH_ENV: "SPECIAL_API_KEY",
    SPECIAL_API_KEY: "allowed-by-user",
  });
  assert.equal(output.SPECIAL_API_KEY, "allowed-by-user");
});

test("provider boundary overrides cannot be disabled by the parent environment", () => {
  const output = buildAgyEnvironment(
    true,
    { OMP_AGY_PROVIDER_MODE: "0" },
    { OMP_AGY_PROVIDER_MODE: "1", OMP_AGY_PROVIDER_MEDIA_PATHS: "[]" },
  );
  assert.equal(output.OMP_AGY_PROVIDER_MODE, "1");
  assert.equal(output.OMP_AGY_PROVIDER_MEDIA_PATHS, "[]");
});
