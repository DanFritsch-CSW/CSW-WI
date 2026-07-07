// netlify/edge-functions/pvi-password-gate.js
//
// Password-gates the Palermo's At Risk Inventory Manager standalone site
// (cswpvi.netlify.app). Dan ask, 2026-07-07: "make just the PVI/csw url
// site password protected. Password = palermos2026."
//
// SCOPING: this repo builds TWO Netlify sites from the same netlify.toml —
// the main CSW-WI app (csw-wi.netlify.app) and the Palermo's standalone
// build (cswpvi.netlify.app, built with VITE_APP_MODE=palermos). Both sites
// pick up this edge function since it's registered repo-wide. To avoid
// gating the main app that Dean/Kay/Wasz/etc. use daily, the very first
// thing this function does is check the VITE_APP_MODE site environment
// variable and pass through untouched if it isn't 'palermos'.
//
// AUTH MODEL: single shared password, not per-user accounts. On success,
// sets a long-lived cookie so the operator isn't re-prompted every visit.
// This is a basic site-wide gate — anyone with the password has full
// access, same as a screen-lock, not a permissions system.
//
// PASSWORD SOURCE: checks the PVI_SITE_PASSWORD site environment variable
// first (Site settings -> Environment variables in the Netlify dashboard),
// falling back to the hardcoded default below if that var isn't set. This
// lets Dan rotate the password later without a code change/redeploy — the
// hardcoded fallback just means it works immediately without that extra
// setup step.

const DEFAULT_PASSWORD = 'palermos2026'
const COOKIE_NAME  = 'pvi_gate'
const COOKIE_VALUE = 'ok-2026'
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

function readEnv(key) {
  // Netlify Edge Functions run on Deno. Netlify also injects a `Netlify`
  // global with an `env.get()` helper on recent runtimes — prefer that,
  // fall back to Deno.env directly so this keeps working either way.
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      return Netlify.env.get(key)
    }
  } catch (_) { /* fall through */ }
  try {
    // eslint-disable-next-line no-undef
    return Deno.env.get(key)
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
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
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
  ${showError ? '<div class="err">Incorrect password — try again.</div>' : ''}
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Enter</button>
</form>
</body>
</html>`
}

export default async (request, context) => {
  // Only gate the Palermo's standalone deploy. The main CSW-WI app builds
  // from the same repo without VITE_APP_MODE set to 'palermos', so this
  // check keeps the gate scoped correctly across both sites.
  const appMode = readEnv('VITE_APP_MODE')
  if (appMode !== 'palermos') {
    return // passthrough — not the Palermo's site
  }

  const expectedPassword = readEnv('PVI_SITE_PASSWORD') || DEFAULT_PASSWORD

  const cookies = parseCookies(request.headers.get('cookie'))
  if (cookies[COOKIE_NAME] === COOKIE_VALUE) {
    return // already authenticated this browser — let the request through
  }

  const url = new URL(request.url)

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
        `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`
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
