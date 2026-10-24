#!/usr/bin/env node
// Rendering performance, before and after: builds two refs for production in throwaway worktrees, serves them side by
// side on the same database, and measures the same pages and interactions on each, alternating, with the CPU slowed.
// Usage: node tmp/graph-lab/perf.mjs [--before=<ref>] [--after=<ref>] [--runs=5] [--throttle=4] [--keep] [--rebuild]
//        [--reduced-motion] [--ssr[=both|before|after]]
//
// --ssr serves the versions as production does: each one renders on its own SSR server, which loads also measure (time
// to first byte, HTML size, first lines of the graph). Comparing a ref with itself (--before=X --after=X) tells the
// noise of each metric.

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

const ssrSides = args.ssr === undefined ? [] : args.ssr === 'true' || args.ssr === 'both' ? ['before', 'after'] : [args.ssr];

const versions = [
    { name: 'before', ref: args.before ?? git('merge-base', 'HEAD', 'upstream/production'), port: 8101, ssrPort: 13801 },
    { name: 'after', ref: args.after ?? 'HEAD', port: 8102, ssrPort: 13802 },
].map((version) => {
    const sha = git('rev-parse', `${version.ref}^{commit}`);
    const ssr = ssrSides.includes(version.name);
    return {
        ...version,
        sha,
        ssr,
        label: `${version.name} (${sha.slice(0, 8)} ${git('log', '-1', '--format=%s', sha).slice(0, 50)})${ssr ? ', SSR' : ''}`,
        // Named after the side too, so a ref compared with itself gets two worktrees and two builds.
        dir: join(root, '.claude/worktrees', `graph-lab-perf-${version.name}-${sha.slice(0, 8)}`),
    };
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
    if (version.ssr && (args.rebuild || ssrBundle(version) === undefined)) {
        log(`${version.name}: SSR build`);
        execFileSync('vp', ['build', '--ssr'], { cwd: version.dir, env, stdio: 'pipe' });
    }
}

const waitFor = async (check, what, stop) => {
    for (let tries = 0; ; tries++) {
        if (await check().catch(() => false)) return;
        if (tries > 80) {
            stop();
            throw new Error(what);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
};

// Named as `inertia:start-ssr` looks for it.
const ssrBundle = (version) => ['bootstrap/ssr/ssr.js', 'bootstrap/ssr/ssr.mjs'].find((path) => existsSync(join(version.dir, path)));

// The SSR bundle always listens on Inertia's default port: the preload moves it to the version's own.
async function startSsr(version) {
    const ssr = spawn('node', ['--import', join(here, 'lib/ssr-port.mjs'), ssrBundle(version)], {
        cwd: version.dir,
        env: { ...env, GLAB_SSR_PORT: String(version.ssrPort) },
        stdio: 'ignore',
    });
    const url = `http://127.0.0.1:${version.ssrPort}`;
    await waitFor(async () => (await fetch(`${url}/health`)).ok, `${version.name}: the SSR server did not start on ${url}`, () => ssr.kill());
    return { url, stop: () => ssr.kill() };
}

async function serve(version) {
    const url = `http://localhost:${version.port}`;
    const ssr = version.ssr ? await startSsr(version) : null;
    const server = spawn(php, ['artisan', 'serve', '--host=127.0.0.1', `--port=${version.port}`], {
        cwd: version.dir,
        env: {
            ...env,
            APP_URL: url,
            PHP_CLI_SERVER_WORKERS: '4',
            INERTIA_SSR_ENABLED: ssr ? 'true' : 'false',
            ...(ssr && { INERTIA_SSR_URL: ssr.url, INERTIA_SSR_THROW_ON_ERROR: 'true' }),
        },
        stdio: 'ignore',
    });
    const stop = () => {
        server.kill();
        ssr?.stop();
    };
    await waitFor(async () => (await fetch(url)).ok, `${version.name} did not start on ${url} (its code may not run on the migrated database)`, stop);
    return { url, stop };
}

const manifests = new Map();

/**
 * Throws unless the page comes from the version's own build, and from its SSR server when it renders on the server:
 * with SSR errors thrown, a page that did not render there would fail rather than fall back to the client.
 */
function checkServed(version, html) {
    if (!manifests.has(version.name)) {
        manifests.set(version.name, readFileSync(join(version.dir, 'public/build/manifest.json'), 'utf8'));
    }
    const asset = html.match(/\/build\/(assets\/app-[^"]+\.js)/)?.[1];
    if (asset === undefined || !manifests.get(version.name).includes(`"${asset}"`)) {
        throw new Error(`${version.name}: the page does not load its own build (${asset ?? 'no app bundle'})`);
    }
    if (html.includes('data-server-rendered="true"') !== version.ssr) {
        throw new Error(`${version.name}: the page is ${version.ssr ? 'not ' : ''}server-rendered`);
    }
}

const lineSelector = ['rail-previous', 'rail-tail', 'rail-staged-tail', 'commit-reply-spine', 'thread-spine', 'thread-column', 'thread-elbow', 'graph-edge', 'graph-edge-dashed']
    .map((name) => `[data-test="${name}"]`)
    .join(',');

// Collected in the page from the first frame: long tasks, the largest contentful paint, and when the first line of the
// graph reached the DOM, from the server's HTML (a rail piece) or from the client (a rail piece or a canvas line).
function installPerfProbe(lineSelector) {
    window.__perf = { longTasks: [], lcp: 0, firstLine: null };
    new PerformanceObserver((list) => window.__perf.longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__perf.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    const lines = new MutationObserver(() => {
        if (document.querySelector(lineSelector)) {
            window.__perf.firstLine = performance.now();
            lines.disconnect();
        }
    });
    lines.observe(document, { childList: true, subtree: true });
}

/** What a page load costs, read once it has settled. A line only shows once something paints, hence the max. */
async function loadMetrics(page, cdp) {
    return {
        ...(await metrics(cdp)),
        ...(await page.evaluate(() => {
            const [navigation] = performance.getEntriesByType('navigation');
            const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
            return {
                TTFB: navigation.responseStart,
                HtmlSize: navigation.decodedBodySize,
                FCP: fcp,
                LCP: window.__perf.lcp,
                FirstLine: window.__perf.firstLine === null ? 0 : Math.max(window.__perf.firstLine, fcp),
                LongTasks: window.__perf.longTasks.reduce((sum, value) => sum + value, 0),
            };
        })),
    };
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
    await context.addInitScript(installPerfProbe, lineSelector);
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

async function load(browser, url, version, path) {
    const { context, page, cdp } = await openPage(browser, url);
    const response = await page.goto(path);
    const html = await response.text();
    checkServed(version, html);
    await settle(page);
    const result = {
        ...(await loadMetrics(page, cdp)),
        // The elements the server's HTML holds, before any script runs.
        ServerElements: await page.evaluate((source) => new DOMParser().parseFromString(source, 'text/html').getElementsByTagName('*').length, html),
    };
    await context.close();
    return result;
}

/** What each run measures, on one version. Every measure returns plain numbers. */
const measures = {
    async 'load: feed'(browser, url, version) {
        return load(browser, url, version, '/log/latest');
    },
    async 'load: thread'(browser, url, version) {
        return load(browser, url, version, `/@${cast.author}/commits/${fixture.root}`);
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

// How far a side's runs stray from their median: the interquartile range, as a share of the median.
const spread = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (share) => sorted[Math.round((sorted.length - 1) * share)];
    const middle = median(values);
    return middle === 0 ? 0 : (at(0.75) - at(0.25)) / Math.abs(middle);
};

const units = { TaskDuration: 'ms', ScriptDuration: 'ms', LayoutDuration: 'ms', RecalcStyleDuration: 'ms', LongTasks: 'ms', LCP: 'ms', FCP: 'ms', TTFB: 'ms', FirstLine: 'ms', FrameP50: 'ms', FrameP95: 'ms', JSHeapUsedSize: 'MB' };
const shown = (name, value) => {
    if (['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(name)) return `${(value * 1000).toFixed(0)} ms`;
    if (name === 'JSHeapUsedSize') return `${(value / 1048576).toFixed(1)} MB`;
    if (name === 'HtmlSize') return `${(value / 1024).toFixed(0)} KB`;
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
        for (const [index, version] of versions.entries()) await measure(browser, servers[index].url, version);
        for (let run = 0; run < runs; run++) {
            for (const [index, version] of (run % 2 ? [...versions.entries()].reverse() : [...versions.entries()])) {
                results[name][version.name].push(await measure(browser, servers[index].url, version));
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
        rows.push({
            measure: name,
            metric,
            before: b,
            after: a,
            change: b === 0 ? (a === 0 ? 0 : Infinity) : (a - b) / b,
            spread: Math.max(spread(before.map((run) => run[metric])), spread(after.map((run) => run[metric]))),
        });
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
    `- spread: the larger interquartile range of the two sides, as a share of the median; a change within it is noise`,
    '',
    '| Measure | Metric | Before | After | Change | Spread |',
    '|---|---|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row.measure} | ${row.metric} | ${shown(row.metric, row.before)} | ${shown(row.metric, row.after)} | ${changeText(row)} | ${(row.spread * 100).toFixed(0)}% |`),
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
