// Counts the DOM mutation callbacks the graph canvas would react to while replies open, and what triggers them.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { cast, signIn } from '../lib/app.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixture.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: 'chrome' });
const context = await signIn(browser, process.env.BASE ?? 'http://localhost:8000', cast.author);
const page = await context.newPage();
await page.goto(`/@${cast.author}/commits/${fixture.root}`);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);

await page.evaluate(() => {
    window.__gc = { read: 0, ro: 0, mo: 0, anim: 0, initial: 0 };
    window.__gcAnim = [];
    const svg = document.querySelector('[data-test="graph-canvas"]');
    window.__mutations = { callbacks: 0, records: 0, targets: {} };
    new MutationObserver((records) => {
        const outside = records.filter((record) => !svg.contains(record.target));
        if (outside.length === 0) return;
        window.__mutations.callbacks++;
        window.__mutations.records += outside.length;
        for (const record of outside) {
            const key = `${record.target.tagName.toLowerCase()}${record.target.dataset?.test ? `[${record.target.dataset.test}]` : ''}.${String(record.target.className).split(' ')[0]}`;
            window.__mutations.targets[key] = (window.__mutations.targets[key] ?? 0) + 1;
        }
    }).observe(svg.parentElement, { childList: true, subtree: true });
});

for (let round = 0; round < 4; round++) {
    const toggle = page.locator('[data-test="toggle-replies-button"][aria-expanded="false"]').first();
    if ((await toggle.count()) === 0) break;
    await toggle.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
}

console.log('canvas measures', JSON.stringify(await page.evaluate(() => window.__gc)));
console.log('animations ending', JSON.stringify(await page.evaluate(() => Object.entries((window.__gcAnim ?? []).reduce((all, key) => ({ ...all, [key]: (all[key] ?? 0) + 1 }), {})))));
const result = await page.evaluate(() => window.__mutations);
console.log(`callbacks ${result.callbacks}, records ${result.records}`);
for (const [target, count] of Object.entries(result.targets).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${count}\t${target}`);
await browser.close();
