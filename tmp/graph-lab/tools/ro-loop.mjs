// Finds which action raises "ResizeObserver loop completed with undelivered notifications" on a feed.
import { chromium } from 'playwright';
import { cast, signIn, viewports } from '../lib/app.mjs';

const browser = await chromium.launch({ channel: 'chrome' });
const context = await signIn(browser, 'http://localhost:8000', cast.author);
const page = await context.newPage();
const errors = [];
page.on('console', (message) => message.text().includes('ResizeObserver') && errors.push(message.text()));

const actions = {
    load: async () => {
        await page.goto('/log/following');
        await page.waitForLoadState('networkidle');
    },
    scrollBottom: async () => {
        for (let i = 0; i < 4; i++) {
            await page.mouse.wheel(0, 3000);
            await page.waitForTimeout(500);
        }
    },
    tabLatest: () => page.locator('a[href="/log/latest"]').first().click(),
    tabFollowing: () => page.locator('a[href="/log/following"]').first().click(),
    back: () => page.goBack(),
    mobile: () => page.setViewportSize(viewports.mobile),
    desktop: () => page.setViewportSize(viewports.desktop),
    hover: () => page.locator('[data-test="commit"] a[href^="/@"]').nth(2).hover(),
    expand: async () => {
        const toggle = page.locator('[data-test="toggle-replies-button"][aria-expanded="false"]').first();
        if (await toggle.count()) await toggle.click();
    },
    commit: () => page.locator('[data-test="commit-permalink"]').nth(1).click(),
    backToFeed: () => page.goBack(),
    profile: () => page.locator('[data-test="commit"] a[href^="/@glab-peer"]').first().click(),
    notifications: () => page.locator('a[href="/notifications"]').first().click(),
    forward: () => page.goForward(),
    top: () => page.evaluate(() => window.scrollTo(0, 0)),
};

for (let round = 0; round < Number(process.env.ROUNDS ?? 3); round++) {
    for (const [name, action] of Object.entries(actions)) {
        const before = errors.length;
        await action().catch(() => {});
        await page.waitForTimeout(700);
        if (errors.length > before) console.log(`round ${round + 1}: ${name} → ${errors.length - before} error(s)`);
    }
}
console.log(`total: ${errors.length}`);
await browser.close();
