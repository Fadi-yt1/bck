import type { Config } from "@netlify/functions";

/**
 * Public, non-sensitive configuration for the front end.
 *
 * This deliberately reports only whether a key is present and which mode is
 * active — never the key itself, not even a partial or masked version.
 */
export default async (): Promise<Response> => {
  const mode = (Netlify.env.get("PHOTOROOM_MODE") ?? "live").toLowerCase();
  const configured = Boolean(
    mode === "sandbox"
      ? Netlify.env.get("PHOTOROOM_SANDBOX_API_KEY") ?? Netlify.env.get("PHOTOROOM_API_KEY")
      : Netlify.env.get("PHOTOROOM_API_KEY"),
  );

  return new Response(
    JSON.stringify({
      ready: configured,
      mode: mode === "sandbox" ? "sandbox" : "live",
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
