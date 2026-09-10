import type { Config } from "@netlify/functions";

/**
 * Public, non-sensitive configuration for the front end.
 *
 * This reports only whether a key is present, which mode is active, and the
 * NAMES of any variables that are missing — never a key itself, not even a
 * partial or masked version. The names are already public (they're in the
 * README), and reporting them turns a misconfiguration into a one-line
 * diagnosis instead of a guess.
 */
export default async (): Promise<Response> => {
  const mode = (Netlify.env.get("PHOTOROOM_MODE") ?? "live").toLowerCase();
  const sandbox = mode === "sandbox";

  // Mirrors cutout.mts: sandbox mode requires the sandbox key, with no
  // fall-through to the live key.
  const activeKey = Netlify.env.get(sandbox ? "PHOTOROOM_SANDBOX_API_KEY" : "PHOTOROOM_API_KEY");

  const missing: string[] = [];
  if (!activeKey) {
    missing.push(sandbox ? "PHOTOROOM_SANDBOX_API_KEY" : "PHOTOROOM_API_KEY");
  }

  // Optional variables — the function has working defaults for each, so these
  // are reported as advisory rather than blocking.
  const usingDefaults: string[] = [];
  if (!Netlify.env.get("RATE_LIMIT_SALT")) usingDefaults.push("RATE_LIMIT_SALT");
  if (!Netlify.env.get("RATE_LIMIT_PER_HOUR")) usingDefaults.push("RATE_LIMIT_PER_HOUR");
  if (!Netlify.env.get("PHOTOROOM_MODE")) usingDefaults.push("PHOTOROOM_MODE");

  return new Response(
    JSON.stringify({
      ready: Boolean(activeKey),
      mode: sandbox ? "sandbox" : "live",
      missing,
      usingDefaults,
      maxUploadBytes: 15 * 1024 * 1024,
      rateLimitPerHour: Number(Netlify.env.get("RATE_LIMIT_PER_HOUR") ?? 40),
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
};

export const config: Config = {
  path: "/api/status",
};
