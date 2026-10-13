'use strict'

// SUPERSEDED 2026-10-13 — do not use.
//
// This file assumed the Grassland order agent's Front webhook would run on
// Netlify, matching lib/lens-front-agent.cjs's pattern. That turned out to
// be dead/pre-migration code even for customer-lens itself — the REAL,
// live webhook for both customer-lens and scheduling_agent is a Supabase
// Edge Function (Deno), confirmed directly via Supabase's list_edge_functions
// (lens-webhook v14, scheduling-agent-webhook v27, both ACTIVE). Netlify's
// function env-var limits are what forced that, same reason this file's
// replacement lives where it does now.
//
// Real Grassland implementation:
//   - Front/MCP/Claude-extraction side: Supabase Edge Function
//     `grassland-order-webhook` (project ppsbqekabtbwsmvdiyga)
//   - Live MotherDuck resolution + Datex push: this repo's
//     netlify/functions/lib/grassland-order-shared.cjs (resolveAndPushBatch),
//     invoked via netlify/functions/grassland-order-resolve-background.cjs
//   - Posting results back to Front: Supabase Edge Function
//     `grassland-order-reply`
//
// This file is kept only so its git history isn't lost; nothing requires it.

module.exports = {}
