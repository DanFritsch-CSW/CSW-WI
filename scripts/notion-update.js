/**
 * Called by the notion-sync GitHub Action on every push to main.
 * Updates the "Last Deployed" banner and appends a changelog entry.
 *
 * Required env vars (set as GitHub Secrets):
 *   NOTION_API_KEY   — Notion integration token
 *   NOTION_PAGE_ID   — ID of the documentation page (output by notion-init.js)
 *
 * Injected by the GitHub Action:
 *   COMMIT_SHA, COMMIT_MESSAGE, COMMIT_AUTHOR
 */

import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const pageId = process.env.NOTION_PAGE_ID;

const commitSha = process.env.COMMIT_SHA || 'unknown';
const commitMessage = process.env.COMMIT_MESSAGE || '(no message)';
const commitAuthor = process.env.COMMIT_AUTHOR || 'Unknown';

if (!process.env.NOTION_API_KEY || !pageId) {
  console.error('Missing required env vars: NOTION_API_KEY, NOTION_PAGE_ID');
  process.exit(1);
}

const rt = (text) => [{ type: 'text', text: { content: text } }];
const shortSha = commitSha.slice(0, 7);
const now = new Date().toISOString();
const dateStr = now.split('T')[0];
const firstLine = commitMessage.split('\n')[0].slice(0, 80);

async function update() {
  // 1. Update the "Last Deployed" callout (always the first block of the page)
  const { results: topBlocks } = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 5
  });

  const banner = topBlocks[0];
  if (banner?.type === 'callout') {
    await notion.blocks.update({
      block_id: banner.id,
      callout: {
        rich_text: [
          { type: 'text', text: { content: 'Last Deployed: ' }, annotations: { bold: true } },
          { type: 'text', text: { content: `${now} — ${shortSha}` } }
        ]
      }
    });
    console.log(`Updated Last Deployed banner → ${shortSha}`);
  } else {
    console.warn('First block is not a callout — skipping banner update');
  }

  // 2. Append a changelog toggle at the end of the page
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        type: 'toggle',
        toggle: {
          rich_text: rt(`🚀 ${dateStr} — ${shortSha} — ${firstLine}`),
          children: [
            { type: 'paragraph', paragraph: { rich_text: rt(`Author:   ${commitAuthor}`) } },
            { type: 'paragraph', paragraph: { rich_text: rt(`SHA:      ${commitSha}`) } },
            { type: 'paragraph', paragraph: { rich_text: rt(`Message:  ${commitMessage}`) } },
            { type: 'paragraph', paragraph: { rich_text: rt(`Deployed: ${now}`) } }
          ]
        }
      }
    ]
  });

  console.log(`Appended changelog entry for ${shortSha}`);
}

update().catch((err) => {
  console.error('Notion update failed:', err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
