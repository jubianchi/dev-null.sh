// Traces a feed scroll on two production builds and tells what invalidates layout, to find where extra layouts come
// from. Usage: node tmp/graph-lab/tools/trace-scroll.mjs <before worktree> <after worktree>
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { cast, signIn } from '../lib/app.mjs';

const php = process.env.GLAB_PHP ?? '/opt/homebrew/opt/php/bin/php';
const env = { ...process.env, DB_PASSWORD: process.env.DB_PASSWORD ?? 'password', PHP_CLI_SERVER_WORKERS: '4' };
const [beforeDir, afterDir] = process.argv.slice(2);

async function serve(dir, port) {
    const url = `http://localhost:${port}`;
    const server = spawn(php, ['artisan', 'serve', '--host=127.0.0.1', `--port=${port}`], { cwd: dir, env: { ...env, APP_URL: url }, stdio: 'ignore' });
    for (let tries = 0; !(await fetch(url).catch(() => null))?.ok; tries++) {
        if (tries > 80) {
            server.kill();
            throw new Error(`${dir} did not start`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { url, stop: () => server.kill() };
}

async function trace(browser, url, label) {
    const context = await signIn(browser, url, cast.author);
    const page = await context.newPage();
    await page.goto('/log/latest');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await browser.startTracing(page, {
        categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking', 'disabled-by-default-devtools.timeline.stack'],
    });
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                let step = 0;
                const tick = () => {
                    window.scrollBy(0, 40);
                    if (++step < 150) requestAnimationFrame(tick);
                    else resolve();
                };
                requestAnimationFrame(tick);
            }),
    );
    await page.waitForTimeout(1500);
    const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
    await context.close();

    const layouts = events.filter((event) => event.name === 'Layout' && event.ph === 'X');
    const invalidations = events.filter((event) => event.name === 'LayoutInvalidationTracking');
    const byReason = {};
    for (const event of invalidations) {
        const data = event.args?.data ?? {};
        const key = `${data.reason ?? '?'} · ${data.nodeName ?? '?'}`;
        byReason[key] = (byReason[key] ?? 0) + 1;
    }
    const forced = events.filter((event) => event.name === 'Layout' && event.args?.beginData?.stackTrace?.length);
    const forcedBy = {};
    for (const event of forced) {
        const frame = event.args.beginData.stackTrace[0];
        const key = `${frame.functionName || '(anonymous)'} ${frame.url?.split('/').pop()}:${frame.lineNumber}`;
        forcedBy[key] = (forcedBy[key] ?? 0) + 1;
    }
    console.log(`\n${label}: ${layouts.length} layouts, ${layouts.reduce((sum, event) => sum + event.dur, 0) / 1000 | 0} ms; ${forced.length} forced by script`);
    for (const [key, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(count).padStart(5)}  ${key}`);
    if (forced.length) console.log('  forced by:');
    for (const [key, count] of Object.entries(forcedBy).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(count).padStart(5)}  ${key}`);
}

const browser = await chromium.launch({ channel: 'chrome' });
const before = await serve(beforeDir, 8101);
const after = await serve(afterDir, 8102);
try {
    await trace(browser, before.url, `before (${beforeDir.split('-').pop()})`);
    await trace(browser, after.url, `after (${afterDir.split('-').pop()})`);
} finally {
    await browser.close();
    before.stop();
    after.stop();
}
