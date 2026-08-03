'use strict'

/**
 * Shared helper for creating a Front draft reply with appointment confirmation details.
 * Ported from front_netlify_datex/scripts/front-draft.js (2026-08-03), including
 * the reply-all fix already shipped to that repo (includes original "to"
 * recipients, not just the sender, in the reply's "to" list).
 *
 * Used by scheduling-push-to-datex-background.cjs.
 */

// Maps normalized warehouse names to their appointments inbox channel IDs.
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

// Reply-all recipients — includes original 'from' AND 'to' recipients in the
// new "to" line (the fix shipped 2026-08-03), only original 'cc' in "cc".
async function getReplyAllRecipients(conversationId, apiKey) {
  try {
    const data = await frontGet(`/conversations/${conversationId}/messages?limit=50`, apiKey);
    const messages = data._results || [];
    const inbound = messages.slice().reverse().find(m => m.is_inbound) || messages[messages.length - 1];
    if (!inbound) return { to: [], cc: [] };
    const recipients = inbound.recipients || [];
    const to = recipients.filter(r => r.role === 'from' || r.role === 'to').map(r => r.handle).filter(Boolean);
    const cc = recipients.filter(r => r.role === 'cc').map(r => r.handle).filter(Boolean);
    return { to, cc };
  } catch {
    return { to: [], cc: [] };
  }
}

async function resolveChannelId(warehouse, apiKey) {
  if (process.env.FRONT_CHANNEL_ID) return process.env.FRONT_CHANNEL_ID;

  const key = warehouseKey(warehouse);
  const mapping = WAREHOUSE_MAP[key];
  if (mapping?.channel) return mapping.channel;

  const r = await frontGet('/channels', apiKey);
  const ch = r._results?.find(c => ['smtp','office365','gmail','imap'].includes(c.type)) || r._results?.[0];
  if (!ch?.id) throw new Error('Could not resolve a sending channel. Set FRONT_CHANNEL_ID in Netlify env vars.');
  return ch.id;
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
  const [channelId, { to, cc }] = await Promise.all([
    resolveChannelId(record.warehouse, apiKey),
    getReplyAllRecipients(record.front_conversation_id, apiKey),
  ]);

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
  const [channelId, { to, cc }] = await Promise.all([
    resolveChannelId(record.warehouse, apiKey),
    getReplyAllRecipients(record.front_conversation_id, apiKey),
  ]);

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
  const [channelId, { to, cc }] = await Promise.all([
    resolveChannelId(records[0].warehouse, apiKey),
    getReplyAllRecipients(conversationId, apiKey),
  ]);

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
