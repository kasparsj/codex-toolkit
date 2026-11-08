const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

async function render() {
  const [input, width = '1440', height = '1000', ...extra] = process.argv.slice(2);
  if (!input?.endsWith('.html') || extra.length || ![width, height].every(value => /^[1-9]\d{0,3}$/.test(value))) {
    throw new Error('Usage: node render-mockup.cjs INPUT.html [WIDTH HEIGHT]');
  }

  const packageRoot = process.env.PLAN_PR_PLAYWRIGHT_ROOT ?? process.cwd();
  const requirePlaywright = createRequire(resolve(packageRoot, 'package.json'));
  const { chromium } = requirePlaywright('playwright');
  const html = resolve(input);
  const browser = await chromium.launch({ channel: process.env.PLAN_PR_CHROMIUM_CHANNEL });
  try {
    const context = await browser.newContext({
      viewport: { width: Number(width), height: Number(height) },
      serviceWorkers: 'block',
    });
    await context.route(/^https?:\/\//, route => route.abort());
    await context.routeWebSocket(/^wss?:\/\//, webSocket => webSocket.close());
    const page = await context.newPage();
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    await page.screenshot({
      path: html.replace(/\.html$/, '.jpeg'),
      type: 'jpeg',
      quality: 90,
      fullPage: true,
      animations: 'disabled',
      timeout: 15_000,
    });
  } finally {
    await browser.close();
  }
}

render().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
