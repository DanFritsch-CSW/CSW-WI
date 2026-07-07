// netlify/edge-functions/pvi-password-gate.js
//
// Password-gates the Palermo's At Risk Inventory Manager standalone site
// (cswpvi.netlify.app). Dan ask (2026-07-07): simple shared password,
// not per-user auth. Password = palermos2026.
//
// SCOPING: this repo builds TWO Netlify sites off the same netlify.toml —
// the main CSW-WI app (csw-wi.netlify.app) and the Palermo's standalone
// build (cswpvi.netlify.app, VITE_APP_MODE=palermos). Since both sites
// share this config, the very first thing this function does is check the
// VITE_APP_MODE site environment variable and pass straight through
// (return undefined) if it's not 'palermos'. That keeps this gate from
// ever touching the main app that Dean/Kay/Wasz/etc. use daily.
//
// HOW IT WORKS (on the Palermo's site only):
//   1. Cookie check — `pvi_gate=ok-2026`. Present -> pass through, no
//      re-prompt for the life of the cookie (30 days).
//   2. POST with a `password` form field matching the expected password
//      -> set the cookie and 302-redirect back to the originally
//      requested path (so the SPA loads normally after login).
//   3. Anything else -> serve a small self-contained HTML login form
//      (inline CSS, zero external asset requests — it has to render even
//      though nothing else has passed the gate yet). Shows an error
//      banner after a failed attempt (401 response, same form).
//
// PASSWORD SOURCE: checks the PVI_SITE_PASSWORD site environment variable
// first; falls back to the hardcoded default below if that env var isn't
// set. This means Dan can rotate the password later from the Netlify
// dashboard (Site settings -> Environment variables -> PVI_SITE_PASSWORD)
// without touching code or redeploying — the hardcoded fallback just means
// it works immediately without that extra setup step.
//
// SECURITY NOTE: this is a basic shared-secret gate suitable for keeping
// casual/unauthenticated visitors out of an internal-facing dashboard. It
// is NOT per-user auth, NOT rate-limited, and the cookie is a static
// marker rather than a signed/expiring token. Fine for this use case;
// don't extend this pattern to anything handling sensitive data without
// hardening it first.

const COOKIE_NAME = 'pvi_gate'
const COOKIE_VALUE = 'ok-2026'
const DEFAULT_PASSWORD = 'palermos2026'

function getEnv(name) {
  try {
    // Netlify's documented way to read site env vars from an Edge Function.
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      return Netlify.env.get(name)
    }
  } catch (_) { /* fall through */ }
  try {
    // Deno.env works too on Netlify's edge runtime; kept as a fallback in
    // case the Netlify global isn't present in some execution context.
    return Deno.env.get(name)
  } catch (_) {
    return undefined
  }
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=')
    if (idx === -1) return
    const k = pair.slice(0, idx).trim()
    const v = pair.slice(idx + 1).trim()
    out[k] = v
  })
  return out
}

function renderForm(showError) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Palermo's At Risk Inventory Manager</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a1a;
    color: #eee;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    margin: 0;
  }
  form {
    background: #242424;
    padding: 32px;
    border-radius: 8px;
    width: 280px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  }
  h1 {
    font-size: 16px;
    margin: 0 0 4px;
    color: #c0392b;
    font-weight: 700;
  }
  p {
    font-size: 12px;
    color: #999;
    margin: 0 0 20px;
  }
  input {
    width: 100%;
    padding: 10px;
    margin-bottom: 12px;
    border-radius: 4px;
    border: 1px solid #444;
    background: #1a1a1a;
    color: #eee;
    font-size: 14px;
  }
  input:focus {
    outline: none;
    border-color: #c0392b;
  }
  button {
    width: 100%;
    padding: 10px;
    border-radius: 4px;
    border: none;
    background: #c0392b;
    color: white;
    font-weight: 600;
    cursor: pointer;
    font-size: 14px;
  }
  button:hover { background: #a5301f; }
  .err {
    color: #e05a5a;
    font-size: 12px;
    margin-bottom: 12px;
  }
</style>
</head>
<body>
<form method="POST">
  <h1>Palermo's At Risk Inventory Manager</h1>
  <p>This site is password protected.</p>
  ${showError ? '<div class="err">Incorrect password &mdash; try again.</div>' : ''}
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Enter</button>
</form>
</body>
</html>`
}

export default async (request, context) => {
  // Only gate the Palermo's standalone deploy. Main CSW-WI app passes
  // straight through untouched.
  const appMode = getEnv('VITE_APP_MODE')
  if (appMode !== 'palermos') {
    return
  }

  const url = new URL(request.url)
  const expectedPassword = getEnv('PVI_SITE_PASSWORD') || DEFAULT_PASSWORD

  const cookies = parseCookies(request.headers.get('cookie'))
  if (cookies[COOKIE_NAME] === COOKIE_VALUE) {
    return
  }

  if (request.method === 'POST') {
    let submitted = null
    try {
      const form = await request.formData()
      submitted = form.get('password')
    } catch (_) {
      submitted = null
    }
    if (submitted === expectedPassword) {
      const headers = new Headers()
      headers.set('Location', url.pathname + url.search)
      headers.set(
        'Set-Cookie',
        `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
      )
      return new Response(null, { status: 302, headers })
    }
    return new Response(renderForm(true), {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  return new Response(renderForm(false), {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export const config = { path: '/*' }
