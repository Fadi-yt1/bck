# Clearcut

A fast, private image background remover. Drop in a photo, get a clean cutout,
swap in any colour or backdrop, and download a PNG or JPG.

Built as a static front end plus two Netlify serverless functions. Background
removal is performed by the [Photoroom API](https://www.photoroom.com/api).

## How the API key is protected

The browser never receives, and never can receive, the API key.

| Layer | Protection |
| --- | --- |
| Storage | Keys live only in Netlify's encrypted environment variables. They are not in this repository, not in any build artifact, and not in any client asset. |
| Access | Only `netlify/functions/cutout.mts` reads them, via `Netlify.env.get()`, at request time. |
| Responses | The key is never placed in a response body, header, or error message. Upstream provider errors are logged server-side and replaced with generic user-facing messages. |
| Transport | The browser talks only to `/api/cutout` on this origin. The outbound call to Photoroom happens server-to-server over TLS. |
| Repository | `.env` is git-ignored; `.env.example` carries placeholders only. |

Abuse protections that keep the key's quota from being drained:

- **Same-origin enforcement** — requests carrying a foreign `Origin`/`Referer` are rejected, so another site can't point its front end at this endpoint.
- **Rate limiting** — a rolling hourly cap per visitor, stored in Netlify Blobs against a salted SHA-256 of the IP, so no raw address is retained.
- **Upload validation** — MIME allow-list and a 15 MB ceiling, checked before any upstream call is made.
- **Timeout** — outbound requests are aborted after 25 s.

## Environment variables

Set these in **Netlify → Site configuration → Environment variables** (mark the keys as secret):

| Variable | Purpose |
| --- | --- |
| `PHOTOROOM_API_KEY` | Live key. Consumes account credits. |
| `PHOTOROOM_SANDBOX_API_KEY` | Sandbox key. Free, returns a watermarked result. |
| `PHOTOROOM_MODE` | `live` or `sandbox`. Chooses which key is used. |
| `RATE_LIMIT_PER_HOUR` | Requests allowed per visitor per hour. Defaults to 40. |
| `RATE_LIMIT_SALT` | Salt for hashing IPs in the rate limiter. |

Switching between the live and sandbox key is a change to `PHOTOROOM_MODE` and a
redeploy — no code change.

## Project layout

```
public/                     Static front end (no build step)
  index.html                Landing page + editor
  privacy.html              Privacy notice
  assets/css/styles.css     Design tokens, layout, light + dark themes
  assets/js/app.js          Upload, queue, canvas compositing, export
netlify/functions/
  cutout.mts                Authenticated proxy to Photoroom
  status.mts                Reports readiness/mode — never any key material
netlify.toml                Publish dir, function config, security headers
```

> The function is named `cutout`, not `remove-background`: Netlify treats any
> function whose name ends in `-background` as a fire-and-forget background
> function, which returns `202` and discards the response body.

## How processing works

1. The browser downsizes anything over 2500 px on its longest edge, then POSTs it to `/api/cutout`.
2. The function validates, rate-limits, and forwards it to Photoroom's `/v1/segment` endpoint.
3. The transparent PNG comes back and is decoded into an `ImageBitmap`.
4. Backgrounds, format changes and exports are composited on a canvas **in the browser** — so trying ten backdrops costs one API call, not ten.

## Local development

```bash
npm install
cp .env.example .env      # add your keys
netlify dev               # http://localhost:8888
```

To exercise the functions alone: `netlify functions:serve --port 9999`.

## Security headers

`netlify.toml` sets HSTS, `X-Frame-Options: DENY`, `nosniff`, a restrictive
`Permissions-Policy`, and a CSP with no external origins — the site loads no
third-party scripts, fonts, styles or trackers, so every request stays
first-party.
