'use strict'

/**
 * Shared helper for creating a Front draft reply with appointment confirmation details.
 * Ported from front_netlify_datex/scripts/front-draft.js (2026-08-03), including
 * the reply-all fix already shipped to that repo (includes original "to"
 * recipients, not just the sender, in the reply's "to" list).
 *
 * Used by scheduling-push-to-datex-background.cjs.
 *
 * UPDATED 2026-08-20 — two fixes to draft reliability, both diagnosed
 * directly from this file's own logic (no live test needed, unlike the
 * earlier "does Front auto-resolve recipients" question this replaces):
 *
 *   1. RECIPIENT BUG ("sometimes only replies to one person"):
 *      getReplyAllRecipients used to look at only the SINGLE most recent
 *      inbound message's recipient list. On a thread with multiple
 *      messages over time, anyone CC'd earlier but not on the latest
 *      message silently dropped off. Now unions recipients across EVERY
 *      message in the conversation instead — using data already returned
 *      by the same /messages call, no extra API cost. Also no longer
 *      silently swallows API errors into an empty {to:[],cc:[]} — errors
 *      now propagate so a draft-creation failure is visible instead of
 *      quietly producing a recipient-less draft.
 *
 *   2. CHANNEL/THREADING BUG (Richelieu/O&H: replies show up as a new
 *      thread instead of an actual reply): resolveChannelId used to pick
 *      the send channel from a STATIC warehouse-name lookup table
 *      (WAREHOUSE_MAP), never checking which channel the conversation
 *      actually arrived on. If that static mapping was ever wrong or
 *      stale, the reply would go out from a DIFFERENT email identity than
 *      the one the customer originally wrote to — most email clients
 *      thread by matching sender/message headers, not just subject line,
 *      so a mismatched "from" address shows up as an unrelated new email
 *      even though Front's own UI still shows it threaded correctly on
 *      our side. Now resolves the channel from the conversation's own
 *      inbound message (the real "to" address the customer emailed,
 *      matched against Front's actual channel directory) FIRST, falling
 *      back to the static WAREHOUSE_MAP only if that lookup fails.
 *
 * Both fixes share one fetch of /channels and one fetch of /messages per
 * draft, rather than each function refetching independently.
 */

// Maps normalized warehouse names to their appointments inbox channel IDs.
// Kept as a FALLBACK only as of 2026-08-20 — the real channel is now
// resolved from the conversation's own inbound message first (see
// resolveChannelId below). This table only matters if that resolution
// fails (e.g. Front API hiccup, or a conversation with no inbound message
// yet, such as one created entirely inside the plugin with no incoming
// email at all).
const WAREHOUSE_MAP = {
  'csw-franksville':      { channel: 'cha_ema1g', inbox: 'inb_aut78' }, // CAL Appointments
  'csw-kenosha':          { channel: 'cha_ema6s', inbox: 'inb_awl90' }, // KEN Appointments
  'csw-madison':          { channel: 'cha_ema8k', inbox: 'inb_awlas' }, // MAD Appointments
  'csw-wisconsin-rapids': { channel: 'cha_euvx0', inbox: 'inb_b8n2s' }, // WR Appointments
  'csw-eau-claire':       { channel: 'cha_eubx0', inbox: 'inb_beis4' }, // EC Appointments
};

// Physical addresses for each facility — used by the {{address}} template placeholder.
const WAREHOUSE_ADDRESSES = {
  'csw-franksville':      '12725 4 Mile Rd, Franksville, WI 53126',
  'csw-caledonia':        '12725 4 Mile Rd, Franksville, WI 53126', // legacy key alias
  'csw-kenosha':          '7800 95th St, Pleasant Prairie, WI 53158',
  'csw-madison':          '4309 Cottage Grove Rd, Madison, WI 53716',
  'csw-wisconsin-rapids': '801 21st Ave N, Wisconsin Rapids, WI 54495',
  'csw-eau-claire':       '2650 Fortune Dr, Eau Claire, WI 54703',
};

function warehouseKey(warehouse) {
  return (warehouse || '').toLowerCase().replace(/\s+/g, '-');
}

function computeDisplayArrival(record) {
  if (record.type !== 'Outbound/Drop' || !record.scheduled_arrival) return record.scheduled_arrival;
  const d = new Date(record.scheduled_arrival);
  if (isNaN(d.getTime())) return record.scheduled_arrival;
  return new Date(d.getTime() + 2 * 60 * 60 * 1000).toISOString();
}

function formatArrival(raw) {
  if (!raw) return '—';
  const [datePart, timePart] = raw.split('T');
  if (!datePart) return raw;
  const [year, month, day] = datePart.split('-');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthName = months[parseInt(month, 10) - 1] || month;
  if (!timePart) return `${monthName} ${parseInt(day, 10)}, ${year}`;
  const [hStr, mStr] = timePart.split(':');
  const m = mStr || '00';
  return `${monthName} ${parseInt(day, 10)}, ${year} at ${hStr.padStart(2, '0')}:${m} CT`;
}

async function frontGet(path, apiKey) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Front GET ${path} → ${res.status}`);
  return res.json();
}

// Fetches Front's channel directory ONCE per draft-creation call, shared
// by both channel resolution and recipient filtering below. Returns:
//   byId       — Map(channel_id -> address)
//   byAddress  — Map(lowercased address -> channel_id)
//   addressSet — Set(lowercased address) of every CSW channel's own
//                address, used to exclude our own identity from
//                recipient lists (we should never "reply to" ourselves).
async function fetchChannelDirectory(apiKey) {
  const r = await frontGet('/channels', apiKey);
  const channels = r._results || [];
  const byId = new Map();
  const byAddress = new Map();
  const addressSet = new Set();
  for (const ch of channels) {
    if (!ch.id || !ch.address) continue;
    const lower = ch.address.toLowerCase();
    byId.set(ch.id, ch.address);
    byAddress.set(lower, ch.id);
    addressSet.add(lower);
  }
  return { byId, byAddress, addressSet };
}

// Fetches every message in the conversation ONCE, shared by both channel
// resolution and recipient unioning below.
async function fetchConversationMessages(conversationId, apiKey) {
  const data = await frontGet(`/conversations/${conversationId}/messages?limit=50`, apiKey);
  return data._results || [];
}

// Reply-all recipients — UPDATED 2026-08-20: unions recipients across
// EVERY message in the conversation (not just the latest inbound one), so
// someone CC'd earlier in a growing thread but absent from the most
// recent message doesn't silently drop off a later reply. Excludes our
// own channel addresses (ownAddressSet) from both lists — we never want
// to "reply to" our own inbox. No longer swallows errors into an empty
// result; a caller that wants best-effort behavior should catch this
// itself (createFrontDraft/createFrontMultiDraft/sendFrontEmail do NOT
// catch it — a recipient-resolution failure should surface as a real
// error, not a silently recipient-less draft).
function computeReplyAllRecipients(messages, ownAddressSet) {
  const toMap = new Map(); // lowercase handle -> original-case handle
  const ccMap = new Map();
  for (const msg of messages) {
    const recipients = msg.recipients || [];
    for (const r of recipients) {
      if (!r.handle) continue;
      const lower = r.handle.toLowerCase();
      if (ownAddressSet.has(lower)) continue; // never include our own channel identity
      if (r.role === 'from' || r.role === 'to') {
        if (!toMap.has(lower)) toMap.set(lower, r.handle);
      } else if (r.role === 'cc') {
        if (!ccMap.has(lower)) ccMap.set(lower, r.handle);
      }
    }
  }
  return { to: [...toMap.values()], cc: [...ccMap.values()] };
}

// Resolves the channel to send from. UPDATED 2026-08-20: prefers the
// REAL channel the conversation arrived on (read from the inbound
// message's "to" address, matched against Front's actual channel
// directory) over the static warehouse-name lookup table. A stale/wrong
// static mapping used to be able to silently send the reply from a
// DIFFERENT email identity than the one the customer originally
// emailed — most email clients thread by matching sender/message
// headers, so that mismatch is a plausible direct cause of replies
// showing up as a new thread instead of an actual reply.
function resolveChannelIdFromMessages(messages, directory) {
  const inbound = messages.find((m) => m.is_inbound);
  if (!inbound) return null;
  const toHandle = (inbound.recipients || []).find((r) => r.role === 'to')?.handle;
  if (!toHandle) return null;
  return directory.byAddress.get(toHandle.toLowerCase()) || null;
}

function resolveChannelIdFallback(warehouse, directory) {
  if (process.env.FRONT_CHANNEL_ID) return process.env.FRONT_CHANNEL_ID;
  const key = warehouseKey(warehouse);
  const mapping = WAREHOUSE_MAP[key];
  if (mapping?.channel) return mapping.channel;
  const first = [...directory.byId.keys()][0];
  if (!first) throw new Error('Could not resolve a sending channel. Set FRONT_CHANNEL_ID in Netlify env vars.');
  return first;
}

// Fetches everything shared between channel resolution and recipient
// unioning in one place: the channel directory, the conversation's
// messages, the resolved channel ID, and the resolved to/cc lists.
async function resolveDraftContext(conversationId, warehouse, apiKey) {
  const [directory, messages] = await Promise.all([
    fetchChannelDirectory(apiKey),
    fetchConversationMessages(conversationId, apiKey),
  ]);
  const channelId = resolveChannelIdFromMessages(messages, directory) || resolveChannelIdFallback(warehouse, directory);
  const { to, cc } = computeReplyAllRecipients(messages, directory.addressSet);
  return { channelId, to, cc };
}

const DEFAULT_DRAFT_TEMPLATE = [
  'Your appointment {{lookup_code}} is confirmed for {{arrival}}',
  '',
  'PICKUP/DELIVERY ADDRESS: {{address}}',
  '',
  'Please note that due to high volume, if your requested time is not available we will confirm the next available appointment to ensure that you receive a confirmation. If the appointment provided will not work, please reach out and we will do our best to find an alternative that fits your needs.',
  '',
  "Please ensure if picking up for Fair Oaks Farms or Palermo's that the driver arrives with two load bars, as Fair Oaks Farms / Palermo's requires them upon check-in. Drivers will not be checked in without the proper equipment for securing the load.",
  '',
  'No reply is necessary, thank you!',
].join('\n');

function buildBody(record, template) {
  const rawArrival = formatArrival(computeDisplayArrival(record));
  const arrival = record.type === 'Outbound/Drop' ? `Ready Time: ${rawArrival}` : rawArrival;
  const lookupCode = record.appointment_lookup_code || '—';
  const appointmentId = record.datex_appointment_id != null ? String(record.datex_appointment_id) : '—';
  const address = WAREHOUSE_ADDRESSES[warehouseKey(record.warehouse)] || '';
  return (template || DEFAULT_DRAFT_TEMPLATE)
    .replace(/\{\{lookup_code\}\}/g, lookupCode)
    .replace(/\{\{arrival\}\}/g, arrival)
    .replace(/\{\{appointment_id\}\}/g, appointmentId)
    .replace(/\{\{address\}\}/g, address);
}

function toHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split('\n')
    .map(line => {
      const withBold = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      return `<div>${withBold === '' ? '<br />' : withBold}</div>`;
    })
    .join('');
}

async function createFrontDraft(record, apiKey, template) {
  const { channelId, to, cc } = await resolveDraftContext(record.front_conversation_id, record.warehouse, apiKey);

  const payload = { channel_id: channelId, body: toHtml(buildBody(record, template)), mode: 'shared', type: 'replyAll' };
  if (to.length) payload.to = to;
  if (cc.length) payload.cc = cc;

  const draftRes = await fetch(
    `https://api2.frontapp.com/conversations/${record.front_conversation_id}/drafts`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }
  );

  if (!draftRes.ok) {
    const text = await draftRes.text();
    throw new Error(`Front drafts API → ${draftRes.status}: ${text}`);
  }
}

async function sendFrontEmail(record, apiKey, template) {
  const { channelId, to, cc } = await resolveDraftContext(record.front_conversation_id, record.warehouse, apiKey);

  const payload = { channel_id: channelId, body: toHtml(buildBody(record, template)), type: 'replyAll' };
  if (to.length) payload.to = to;
  if (cc.length) payload.cc = cc;

  const res = await fetch(
    `https://api2.frontapp.com/conversations/${record.front_conversation_id}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Front send API → ${res.status}: ${text}`);
  }
}

async function createFrontComment(record, apiKey, template) {
  const commentRes = await fetch(
    `https://api2.frontapp.com/conversations/${record.front_conversation_id}/comments`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body: buildBody(record, template) }),
    }
  );

  if (!commentRes.ok) {
    const text = await commentRes.text();
    throw new Error(`Front comments API → ${commentRes.status}: ${text}`);
  }
}

async function createFrontErrorNote(record, apiKey, errorMessage) {
  const code = record.appointment_lookup_code || record.id || 'unknown';
  const body = `⚠️ Datex push failed for appointment ${code} — ${errorMessage}\n\nPlease retry from the scheduling plugin.`;
  const res = await fetch(
    `https://api2.frontapp.com/conversations/${record.front_conversation_id}/comments`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Front comments API → ${res.status}: ${text}`);
  }
}

// Multi-appointment draft (used by scheduling-create-multi-front-draft.cjs)
const DEFAULT_MULTI_DRAFT_TEMPLATE = [
  'The following appointments have been confirmed:',
  '',
  '{{appointments}}',
  '',
  'PICKUP/DELIVERY ADDRESS: {{address}}',
  '',
  'Please note that due to high volume, if your requested time is not available we will confirm the next available appointment to ensure that you receive a confirmation. If the appointment provided will not work, please reach out and we will do our best to find an alternative that fits your needs.',
  '',
  "Please ensure if picking up for Fair Oaks Farms or Palermo's that the driver arrives with two load bars, as Fair Oaks Farms / Palermo's requires them upon check-in. Drivers will not be checked in without the proper equipment for securing the load.",
  '',
  'No reply is necessary, thank you!',
].join('\n');

function buildMultiBody(records, template = DEFAULT_MULTI_DRAFT_TEMPLATE) {
  const lines = records.map((record, i) => {
    const rawArrival = formatArrival(computeDisplayArrival(record));
    const arrival = record.type === 'Outbound/Drop' ? `Ready Time: ${rawArrival}` : rawArrival;
    const code = record.appointment_lookup_code || '—';
    return `${i + 1}. ${code} — ${arrival}`;
  }).join('\n');
  const address = WAREHOUSE_ADDRESSES[warehouseKey(records[0]?.warehouse)] || '';
  return template
    .replace(/\{\{appointments\}\}/g, lines)
    .replace(/\{\{address\}\}/g, address);
}

async function createFrontMultiDraft(records, apiKey, template) {
  if (!records.length) throw new Error('No records provided');
  const conversationId = records[0].front_conversation_id;
  const { channelId, to, cc } = await resolveDraftContext(conversationId, records[0].warehouse, apiKey);

  const payload = { channel_id: channelId, body: toHtml(buildMultiBody(records, template)), mode: 'shared', type: 'replyAll' };
  if (to.length) payload.to = to;
  if (cc.length) payload.cc = cc;

  const draftRes = await fetch(
    `https://api2.frontapp.com/conversations/${conversationId}/drafts`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  if (!draftRes.ok) {
    const text = await draftRes.text();
    throw new Error(`Front drafts API → ${draftRes.status}: ${text}`);
  }
}

module.exports = {
  createFrontDraft, sendFrontEmail, createFrontComment, createFrontMultiDraft, createFrontErrorNote,
  DEFAULT_DRAFT_TEMPLATE, DEFAULT_MULTI_DRAFT_TEMPLATE,
};
