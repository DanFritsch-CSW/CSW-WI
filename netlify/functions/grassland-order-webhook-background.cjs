'use strict'

// SUPERSEDED 2026-10-13 — do not use, and do NOT paste this function's URL
// into Front's agent Credentials screen.
//
// The Grassland order agent's real Front webhook is a Supabase Edge
// Function, not Netlify — see netlify/functions/lib/grassland-front-agent.cjs
// for the full explanation of why. Register this URL in Front instead:
//   https://ppsbqekabtbwsmvdiyga.supabase.co/functions/v1/grassland-order-webhook
//
// This file is kept only so its git history isn't lost; nothing requires it.

exports.handler = async () => ({ statusCode: 410, body: 'Superseded — see netlify/functions/lib/grassland-front-agent.cjs' })
