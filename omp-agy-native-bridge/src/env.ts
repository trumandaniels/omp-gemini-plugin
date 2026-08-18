const ACCOUNT_MODE_ENV_VARS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "VERTEX_AI_PROJECT",
  "VERTEX_AI_LOCATION",
]);

const SECRETISH_NAME = /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|REFRESH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIALS|COOKIE)(?:$|_)/i;

function passthroughNames(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    String(env.AGY_BRIDGE_PASSTHROUGH_ENV ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function buildAgyEnvironment(
  sanitize: boolean,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const passthrough = passthroughNames(baseEnv);
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (
      sanitize &&
      !passthrough.has(name) &&
      (ACCOUNT_MODE_ENV_VARS.has(name) || SECRETISH_NAME.test(name))
    ) {
      continue;
    }
    env[name] = value;
  }
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

export function removedEnvironmentNames(baseEnv: NodeJS.ProcessEnv = process.env): string[] {
  const passthrough = passthroughNames(baseEnv);
  return Object.keys(baseEnv).filter(
    (name) => !passthrough.has(name) && (ACCOUNT_MODE_ENV_VARS.has(name) || SECRETISH_NAME.test(name)),
  );
}
