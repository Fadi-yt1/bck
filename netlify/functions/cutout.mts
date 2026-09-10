import type { Config, Context } from "@netlify/functions";
import { createHash } from "node:crypto";

/**
 * Server-side proxy for the Photoroom background-removal API.
 *
 * The API key is read from Netlify's encrypted environment variables at
 * request time and is used only for the outbound call. It is never included in
 * any response body, response header, or error message, so it can never reach
 * the browser.
 */

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
const UPSTREAM_TIMEOUT_MS = 25_000;
const DEFAULT_RATE_LIMIT = 40; // requests per IP per rolling hour

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

type Json = Record<string, unknown>;

function jsonResponse(body: Json, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fail(code: string, message: string, status: number, extra: Json = {}): Response {
  return jsonResponse({ error: { code, message, ...extra } }, status);
}

/**
 * Hash the caller's IP with a per-site salt so rate-limit records can never be
 * traced back to a visitor's address.
 */
function identify(ip: string): string {
  const salt = Netlify.env.get("RATE_LIMIT_SALT") ?? Netlify.env.get("SITE_ID") ?? "clearcut";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/**
 * Rolling-hour rate limit backed by Netlify Blobs. If the blob store is
 * unavailable the request is allowed through rather than failing the user.
 */
async function checkRateLimit(ip: string): Promise<{ ok: boolean; remaining: number; resetSeconds: number }> {
  const limit = Number(Netlify.env.get("RATE_LIMIT_PER_HOUR") ?? DEFAULT_RATE_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: true, remaining: DEFAULT_RATE_LIMIT, resetSeconds: 3600 };
  }

  const windowMs = 60 * 60 * 1000;
  const now = Date.now();

  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "rate-limits", consistency: "strong" });
    const key = identify(ip);

    const record = (await store.get(key, { type: "json" })) as
      | { count: number; windowStart: number }
      | null;

    let count = 1;
    let windowStart = now;

    if (record && now - record.windowStart < windowMs) {
      count = record.count + 1;
      windowStart = record.windowStart;
    }

    const resetSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));

    if (count > limit) {
      return { ok: false, remaining: 0, resetSeconds };
    }

    await store.setJSON(key, { count, windowStart });
    return { ok: true, remaining: Math.max(0, limit - count), resetSeconds };
  } catch {
    // Blob storage not configured (e.g. plain `netlify dev`) — fail open.
    return { ok: true, remaining: limit, resetSeconds: 3600 };
  }
}

/**
 * Only allow calls that originate from this site. Blocks other websites from
 * pointing their own front end at this endpoint and spending the credits.
 */
function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host");
  if (!host) return true;

  const source = origin ?? referer;
  if (!source) return true; // Non-browser client; the rate limit still applies.

  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return fail("method_not_allowed", "Use POST to submit an image.", 405);
  }

  if (!isSameOrigin(req)) {
    return fail("forbidden_origin", "This endpoint only serves requests from Clearcut.", 403);
  }

  const mode = (Netlify.env.get("PHOTOROOM_MODE") ?? "live").toLowerCase();
  const apiKey =
    mode === "sandbox"
      ? Netlify.env.get("PHOTOROOM_SANDBOX_API_KEY") ?? Netlify.env.get("PHOTOROOM_API_KEY")
      : Netlify.env.get("PHOTOROOM_API_KEY");

  if (!apiKey) {
    console.error("Photoroom credentials are not configured for mode:", mode);
    return fail(
      "not_configured",
      "The background removal service is not configured yet. Please try again later.",
      503,
    );
  }

  const ip = context.ip ?? req.headers.get("x-nf-client-connection-ip") ?? "unknown";
  const limit = await checkRateLimit(ip);
  if (!limit.ok) {
    return new Response(
      JSON.stringify({
        error: {
          code: "rate_limited",
          message: `You've reached the hourly limit. Please try again in about ${Math.ceil(
            limit.resetSeconds / 60,
          )} minutes.`,
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": String(limit.resetSeconds),
        },
      },
    );
  }

  // ---------------------------------------------------------------------
  // Read and validate the upload
  // ---------------------------------------------------------------------
  let file: File;
  try {
    const form = await req.formData();
    const candidate = form.get("image");
    if (!(candidate instanceof File)) {
      return fail("no_image", "No image was included in the request.", 400);
    }
    file = candidate;
  } catch {
    return fail("bad_request", "The upload could not be read. Please try again.", 400);
  }

  if (file.size === 0) {
    return fail("empty_file", "That file appears to be empty.", 400);
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(
      "file_too_large",
      `Images must be smaller than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      413,
    );
  }

  const mime = (file.type || "").toLowerCase();
  if (mime && !ALLOWED_MIME.has(mime)) {
    return fail("unsupported_type", "Please upload a PNG, JPG, WebP or HEIC image.", 415);
  }

  // ---------------------------------------------------------------------
  // Call Photoroom
  // ---------------------------------------------------------------------
  const upstreamForm = new FormData();
  upstreamForm.append("image_file", file, file.name || "upload.png");
  upstreamForm.append("format", "png");

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch("https://sdk.photoroom.com/v1/segment", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        accept: "image/png, application/json",
      },
      body: upstreamForm,
      signal: abort.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    console.error("Photoroom request failed:", aborted ? "timeout" : error);
    return fail(
      aborted ? "timeout" : "upstream_unreachable",
      aborted
        ? "That image took too long to process. Try a smaller image."
        : "We couldn't reach the background removal service. Please try again.",
      504,
    );
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    // Log the upstream detail server-side only; never return it to the client,
    // because provider errors can echo request details.
    const detail = await upstream.text().catch(() => "");
    console.error(`Photoroom responded ${upstream.status}:`, detail.slice(0, 500));

    switch (upstream.status) {
      case 400:
        return fail("invalid_image", "That image couldn't be processed. Try a different file.", 400);
      case 401:
      case 403:
        return fail(
          "auth_failed",
          "The background removal service rejected our credentials. Please try again later.",
          503,
        );
      case 402:
        return fail(
          "out_of_credits",
          "The image processing quota has run out. Please try again later.",
          503,
        );
      case 429:
        return fail("upstream_busy", "The service is busy right now. Please try again shortly.", 503);
      default:
        return fail("upstream_error", "Background removal failed. Please try again.", 502);
    }
  }

  const image = await upstream.arrayBuffer();

  return new Response(image, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": String(image.byteLength),
      "cache-control": "no-store, max-age=0",
      "x-remaining-requests": String(limit.remaining),
      "x-processing-mode": mode === "sandbox" ? "sandbox" : "live",
    },
  });
};

export const config: Config = {
  path: "/api/cutout",
};
