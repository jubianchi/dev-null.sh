// Shows whether the cards move when the canvas takes over from the rail pieces, page by page.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { cast, signIn } from '../lib/app.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixture.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: 'chrome' });
for (const path of ['/log/following', '/log/latest', `/@${cast.author}`, `/@${cast.author}/commits/${fixture.root}`, '/notifications']) {
    const context = await signIn(browser, 'http://localhost:8000', cast.author);
    await context.addInitScript(() => window.__glab.startHandoff());
    const page = await context.newPage();
    await page.goto(path);
    await page.waitForTimeout(2500);
    const frames = (await page.evaluate(() => window.__glabHandoff)).filter((frame) => frame.cards > 0);
    const before = frames.filter((frame) => frame.lines === 0).at(-1);
    const after = frames.find((frame) => frame.lines > 0);
    const moved = before && after && before.layout !== after.layout;
    console.log(`${path}: ${moved ? 'MOVES' : 'still'}${moved ? `\n   before ${before.layout}\n   after  ${after.layout}` : ''}`);
    await context.close();
}
await browser.close();
