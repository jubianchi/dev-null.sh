#!/usr/bin/env node
// Rendering performance, before and after: builds two refs for production in throwaway worktrees, serves them side by
// side on the same database, and measures the same pages and interactions on each, alternating, with the CPU slowed.
// Usage: node tmp/graph-lab/perf.mjs [--before=<ref>] [--after=<ref>] [--runs=5] [--throttle=4] [--keep] [--rebuild]
//        [--reduced-motion]

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { cast, signIn, trustCast } from './lib/app.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
        return [key, value];
    }),
);
const root = process.cwd();
const here = fileURLToPath(new URL('.', import.meta.url));
const git = (...command) => execFileSync('git', command, { encoding: 'utf8' }).trim();
const php = process.env.GLAB_PHP ?? '/opt/homebrew/opt/php/bin/php';
const env = {
    ...process.env,
    PATH: `${php.replace(/\/php$/, '')}:${join(root, 'node_modules/.bin')}:${process.env.PATH}`,
    DB_PASSWORD: process.env.DB_PASSWORD ?? 'password',
    NODE_OPTIONS: '--experimental-strip-types',
};
const runs = Number(args.runs ?? 5);
const throttle = Number(args.throttle ?? 4);
const log = (message) => console.log(`\x1b[2m${message}\x1b[0m`);

const versions = [
    { name: 'before', ref: args.before ?? git('merge-base', 'HEAD', 'upstream/production'), port: 8101 },
    { name: 'after', ref: args.after ?? 'HEAD', port: 8102 },
].map((version) => {
    const sha = git('rev-parse', `${version.ref}^{commit}`);
    return { ...version, sha, label: `${version.name} (${sha.slice(0, 8)} ${git('log', '-1', '--format=%s', sha).slice(0, 50)})`, dir: join(root, '.claude/worktrees', `graph-lab-perf-${sha.slice(0, 8)}`) };
});

function prepare(version) {
    if (!existsSync(version.dir)) {
        log(`${version.name}: worktree at ${relative(root, version.dir)}`);
        git('worktree', 'add', '--detach', version.dir, version.sha);
    }
    for (const shared of ['vendor', 'node_modules', '.env']) {
        if (!existsSync(join(version.dir, shared))) symlinkSync(join(root, shared), join(version.dir, shared));
    }
    if (args.rebuild || !existsSync(join(version.dir, 'public/build/manifest.json'))) {
        log(`${version.name}: production build`);
        execFileSync('vp', ['build'], { cwd: version.dir, env, stdio: 'pipe' });
    }
}

async function serve(version) {
    const url = `http://localhost:${version.port}`;
    const server = spawn(php, ['artisan', 'serve', '--host=127.0.0.1', `--port=${version.port}`], {
        cwd: version.dir,
        env: { ...env, APP_URL: url, PHP_CLI_SERVER_WORKERS: '4' },
        stdio: 'ignore',
    });
    for (let tries = 0; ; tries++) {
        if ((await fetch(url).catch(() => null))?.ok) break;
        if (tries > 80) {
            server.kill();
            throw new Error(`${version.name} did not start on ${url} (its code may not run on the migrated database)`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { url, stop: () => server.kill() };
}

// Collected in the page from the first frame: long tasks and the largest contentful paint.
function installPerfProbe() {
    window.__perf = { longTasks: [], lcp: 0 };
    new PerformanceObserver((list) => window.__perf.longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__perf.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
}

const metricNames = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'Nodes', 'JSHeapUsedSize'];

async function metrics(cdp) {
    const { metrics: list } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(list.filter((metric) => metricNames.includes(metric.name)).map((metric) => [metric.name, metric.value]));
}

const delta = (after, before) => Object.fromEntries(Object.keys(after).map((name) => [name, after[name] - (['Nodes', 'JSHeapUsedSize'].includes(name) ? 0 : before[name])]));

// --reduced-motion measures without animations, to tell their share of the cost from the rest.
async function openPage(browser, url) {
    const context = await signIn(browser, url, cast.author, { reducedMotion: args['reduced-motion'] ? 'reduce' : 'no-preference' });
    await context.addInitScript(installPerfProbe);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    return { context, page, cdp };
}

const settle = async (page) => {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
};

const fixture = JSON.parse(readFileSync(join(here, 'fixture.json'), 'utf8'));

/** What each run measures, on one version. Every measure returns plain numbers. */
const measures = {
    async 'load: feed'(browser, url) {
        const { context, page, cdp } = await openPage(browser, url);
        await page.goto('/log/latest');
        await settle(page);
        const result = { ...(await metrics(cdp)), ...(await page.evaluate(() => ({ LongTasks: window.__perf.longTasks.reduce((sum, value) => sum + value, 0), LCP: window.__perf.lcp }))) };
        await context.close();
        return result;
    },
    async 'load: thread'(browser, url) {
        const { context, page, cdp } = await openPage(browser, url);
        await page.goto(`/@${cast.author}/commits/${fixture.root}`);
        await settle(page);
        const result = { ...(await metrics(cdp)), ...(await page.evaluate(() => ({ LongTasks: window.__perf.longTasks.reduce((sum, value) => sum + value, 0), LCP: window.__perf.lcp }))) };
        await context.close();
        return result;
    },
    async 'scroll: feed'(browser, url) {
        const { context, page, cdp } = await openPage(browser, url);
        await page.goto('/log/latest');
        await settle(page);
        const before = await metrics(cdp);
        const frames = await page.evaluate(
            () =>
                new Promise((resolve) => {
                    const gaps = [];
                    let last = performance.now();
                    let count = 0;
                    const step = (now) => {
                        gaps.push(now - last);
                        last = now;
                        window.scrollBy(0, 40);
                        if (++count < 150) requestAnimationFrame(step);
                        else resolve(gaps.slice(1));
                    };
                    requestAnimationFrame(step);
                }),
        );
        const sorted = [...frames].sort((a, b) => a - b);
        const result = {
            ...delta(await metrics(cdp), before),
            FrameP50: sorted[Math.floor(sorted.length * 0.5)],
            FrameP95: sorted[Math.floor(sorted.length * 0.95)],
            JankyFrames: frames.filter((gap) => gap > 50).length,
        };
        await context.close();
        return result;
    },
    async 'hover: dim lanes'(browser, url) {
        const { context, page, cdp } = await openPage(browser, url);
        await page.goto('/log/latest');
        await settle(page);
        const avatars = page.locator('[data-test="commit"] a[href^="/@"]');
        const count = Math.min(await avatars.count(), 10);
        const before = await metrics(cdp);
        for (let i = 0; i < count; i++) {
            await avatars.nth(i).hover();
            await page.waitForTimeout(120);
        }
        await page.mouse.move(2, 2);
        await page.waitForTimeout(400);
        const result = delta(await metrics(cdp), before);
        await context.close();
        return result;
    },
    async 'click: open replies'(browser, url) {
        const { context, page, cdp } = await openPage(browser, url);
        await page.goto(`/@${cast.author}/commits/${fixture.root}`);
        await settle(page);
        const before = await metrics(cdp);
        for (let round = 0; round < 4; round++) {
            const toggle = page.locator('[data-test="toggle-replies-button"][aria-expanded="false"]').first();
            if ((await toggle.count()) === 0) break;
            await toggle.click();
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForTimeout(400);
        }
        const result = delta(await metrics(cdp), before);
        await context.close();
        return result;
    },
    async 'resize: window'(browser, url) {
        const { context, page, cdp } = await openPage(browser, url);
        await page.goto(`/@${cast.author}/commits/${fixture.root}`);
        await settle(page);
        const before = await metrics(cdp);
        for (const width of [390, 820, 1280, 600, 1100, 1280]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.waitForTimeout(200);
        }
        const result = delta(await metrics(cdp), before);
        await context.close();
        return result;
    },
};

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

const units = { TaskDuration: 'ms', ScriptDuration: 'ms', LayoutDuration: 'ms', RecalcStyleDuration: 'ms', LongTasks: 'ms', LCP: 'ms', FrameP50: 'ms', FrameP95: 'ms', JSHeapUsedSize: 'MB' };
const shown = (name, value) => {
    if (['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(name)) return `${(value * 1000).toFixed(0)} ms`;
    if (name === 'JSHeapUsedSize') return `${(value / 1048576).toFixed(1)} MB`;
    if (units[name] === 'ms') return `${value.toFixed(0)} ms`;
    return value.toFixed(0);
};

trustCast(log);
for (const version of versions) prepare(version);
const servers = [];
const browser = await chromium.launch({ channel: 'chrome' });
const results = Object.fromEntries(Object.keys(measures).map((name) => [name, { before: [], after: [] }]));

try {
    for (const version of versions) servers.push(await serve(version));
    log(`serving ${versions.map((version, index) => `${version.name} on ${servers[index].url}`).join(', ')}; CPU slowed ${throttle}x, ${runs} runs`);

    for (const [name, measure] of Object.entries(measures)) {
        // A warm-up run on each side, then runs alternating, so caches and drift weigh on both alike.
        for (const [index] of versions.entries()) await measure(browser, servers[index].url);
        for (let run = 0; run < runs; run++) {
            for (const [index, version] of (run % 2 ? [...versions.entries()].reverse() : [...versions.entries()])) {
                results[name][version.name].push(await measure(browser, servers[index].url));
            }
        }
        process.stdout.write(`\x1b[2m${name} measured\x1b[0m\n`);
    }
} finally {
    await browser.close();
    for (const server of servers) server.stop();
    if (!args.keep) for (const version of versions) git('worktree', 'remove', '--force', version.dir);
}

const rows = [];
for (const [name, { before, after }] of Object.entries(results)) {
    for (const metric of Object.keys(before[0])) {
        const b = median(before.map((run) => run[metric]));
        const a = median(after.map((run) => run[metric]));
        rows.push({ measure: name, metric, before: b, after: a, change: b === 0 ? (a === 0 ? 0 : Infinity) : (a - b) / b });
    }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(here, 'perf', stamp);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ versions, throttle, runs, results, rows }, null, 2));

const changeText = (row) => (row.change === Infinity ? 'new' : `${row.change > 0 ? '+' : ''}${(row.change * 100).toFixed(0)}%`);
const markdown = [
    `# Rendering performance, before and after`,
    '',
    `- before: ${versions[0].label}`,
    `- after: ${versions[1].label}`,
    `- production builds, CPU slowed ${throttle}x, median of ${runs} runs (after one warm-up run each)${args['reduced-motion'] ? ', reduced motion' : ''}`,
    '',
    '| Measure | Metric | Before | After | Change |',
    '|---|---|---:|---:|---:|',
    ...rows.map((row) => `| ${row.measure} | ${row.metric} | ${shown(row.metric, row.before)} | ${shown(row.metric, row.after)} | ${changeText(row)} |`),
    '',
].join('\n');
writeFileSync(join(outDir, 'report.md'), markdown);

console.log(`\n${versions[0].label}\n${versions[1].label}\nCPU ${throttle}x, median of ${runs} runs\n`);
let current = '';
for (const row of rows) {
    if (row.measure !== current) {
        current = row.measure;
        console.log(`\x1b[1m${current}\x1b[0m`);
    }
    const colour = Math.abs(row.change) < 0.05 ? '\x1b[2m' : row.change > 0 ? '\x1b[31m' : '\x1b[32m';
    console.log(`  ${row.metric.padEnd(20)} ${shown(row.metric, row.before).padStart(10)} → ${shown(row.metric, row.after).padStart(10)}  ${colour}${changeText(row)}\x1b[0m`);
}
console.log(`\nreport: ${relative(root, join(outDir, 'report.md'))}`);
