#!/usr/bin/env node
// One-off task script driving the bridge exactly like an MCP client would.
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ADAPTER_PATH = path.join(__dirname, '..', 'mcp-adapter', 'index.js');

(async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ADAPTER_PATH] });
  const client = new Client({ name: 'amazon-search-task', version: '1.0.0' });
  await client.connect(transport);

  let tabId = process.env.AMAZON_TAB_ID ? Number(process.env.AMAZON_TAB_ID) : null;
  if (!tabId) {
    const nt = await client.callTool({
      name: 'new_tab',
      arguments: { url: 'https://www.amazon.com/s?k=koss+porta+pro&s=price-asc-rank' },
    });
    tabId = JSON.parse(nt.content[0].text).tabId;
  }

  try {
    await client.callTool({ name: 'wait_for', arguments: { selector: '[data-component-type="s-search-result"]', tabId, timeoutMs: 15000 } });

    const ev = await client.callTool({
      name: 'evaluate',
      arguments: {
        tabId,
        expression: `
          Array.from(document.querySelectorAll('[data-component-type="s-search-result"]')).map(el => {
            // Amazon renders two <h2>s per card: one brand-only ("Koss"), and one
            // with the real title nested inside the product link (its aria-label
            // holds the clean title text).
            const brandEl = el.querySelector('[data-cy="title-recipe"] h2 span');
            const linkEl = el.querySelector('a[href*="/dp/"]');
            const titleH2 = el.querySelector('h2[aria-label]');
            const rawTitle = titleH2 ? titleH2.getAttribute('aria-label') : null;
            const brand = brandEl ? brandEl.textContent.trim() : '';
            const title = rawTitle && brand && !rawTitle.toLowerCase().startsWith(brand.toLowerCase())
              ? (brand + ' ' + rawTitle) : rawTitle;
            const priceEl = el.querySelector('.a-price .a-offscreen');
            const href = linkEl ? linkEl.getAttribute('href') : null;
            return {
              title,
              priceText: priceEl ? priceEl.textContent.trim() : null,
              url: href ? new URL(href, 'https://www.amazon.com').href : null,
              sponsored: /sponsored/i.test(el.textContent),
            };
          }).filter(x => x.title && x.priceText)
        `,
      },
    });
    const evParsed = JSON.parse(ev.content[0].text);
    const items = evParsed.result || [];

    const ACCESSORY_WORDS = /\b(replacement|compatible with|aftermarket|spare parts?|diy|modification|ear\s?pads?|cushions?|foam|cable|wire|pouch|storage bag)\b/i;
    const relevant = items
      .filter((x) => !x.sponsored)
      .filter((x) => /koss/i.test(x.title))
      .filter((x) => /porta ?pro/i.test(x.title))
      .filter((x) => /headphone/i.test(x.title))
      .filter((x) => !ACCESSORY_WORDS.test(x.title))
      .map((x) => ({ ...x, price: parseFloat(x.priceText.replace(/[^0-9.]/g, '')) }))
      .filter((x) => !Number.isNaN(x.price))
      .sort((a, b) => a.price - b.price);

    console.log(JSON.stringify(relevant.slice(0, 5), null, 2));
    console.log(`\n(${items.length} total results scraped, ${relevant.length} matched "porta pro" and non-sponsored)`);
    if (process.env.DEBUG_RAW) {
      console.log('\n--- raw titles containing koss ---');
      for (const x of items.filter((i) => /koss/i.test(i.title))) {
        console.log(`[${x.sponsored ? 'SPONSORED' : 'organic'}] ${x.priceText} — ${x.title}`);
      }
    }
  } finally {
    // Leave the tab open — no open/close churn between calls.
    await client.close();
  }
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
