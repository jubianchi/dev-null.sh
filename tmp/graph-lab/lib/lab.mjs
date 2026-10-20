import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from './app.mjs';
import { startFilm } from './film.mjs';
import { checkPaint } from './pixels.mjs';

// Console messages known to come from elsewhere than the graph, kept out of the console check.
const knownConsole = [
    { pattern: /two children with the same key.*wordmark/i, reason: 'duplicate React key in the wordmark, not the graph' },
    { pattern: /Download the React DevTools/i, reason: 'React DevTools hint' },
];

/** The part of the viewport the graph's canvas covers, in CSS pixels, padded a little. */
const graphRegion = (page) =>
    page.evaluate(() => {
        const svg = document.querySelector('[data-test="graph-canvas"]');
        if (!svg) return null;
        const rect = svg.parentElement.getBoundingClientRect();
        const x = Math.max(0, rect.left - 8);
        const y = Math.max(0, rect.top - 8);
        const right = Math.min(window.innerWidth, rect.right + 8);
        const bottom = Math.min(window.innerHeight, rect.bottom + 8);
        return right - x > 50 && bottom - y > 50 ? { x, y, width: right - x, height: bottom - y } : null;
    });

/** What one scenario gets to act with, and where it records its checks. */
export function createLab({ browser, base, fixture, outDir, scenario, filming = { enabled: true, format: 'webp', speed: 1 } }) {
    const checks = [];
    const shots = [];
    const films = [];
    const contexts = [];
    const consoleMessages = [];

    const listen = (page) => {
        page.on('console', (message) => {
            if (!['error', 'warning'].includes(message.type())) return;
            consoleMessages.push({ type: message.type(), text: message.text(), url: page.url() });
        });
        page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: String(error), url: page.url() }));
    };

    const lab = {
        base,
        fixture,
        checks,
        shots,
        films,

        async as(username, options) {
            const context = await signIn(browser, base, username, options);
            context.on('page', listen);
            contexts.push(context);
            return context;
        },

        async open(username, path, options) {
            const context = await lab.as(username, options);
            const page = await context.newPage();
            await page.goto(path);
            await lab.settle(page);
            return page;
        },

        async settle(page, extra = 900) {
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.evaluate(() => document.fonts?.ready);
            await page.waitForTimeout(extra);
        },

        check(label, ok, details = []) {
            checks.push({ label, ok: Boolean(ok), details: [details].flat().filter(Boolean).slice(0, 12) });
            return ok;
        },

        /** A check this environment can't run, reported without failing the run. */
        skip(label, reason) {
            checks.push({ label, ok: true, skipped: true, details: [reason] });
        },

        async shot(page, name, { fullPage = true } = {}) {
            const file = `${scenario}--${name}.png`.replace(/[^a-z0-9.-]+/gi, '-');
            await page.screenshot({ path: join(outDir, file), fullPage });
            shots.push({ name, file });
        },

        /**
         * Every static rule on the page's canvases (alignment, cut-outs, gaps, widths, dashes, fades, overlaps, lanes),
         * then, on the screenshot, whether each line is actually painted.
         */
        async audit(page, label, { screenshot = true, requireDrawn = true } = {}) {
            const { issues, stats } = await page.evaluate((options) => window.__glab.audit(options), { requireDrawn });
            lab.check(`${label}: ${stats.nodes} nodes, ${stats.edges} lines drawn cleanly`, issues.length === 0, issues);
            if (!screenshot) return stats;

            const lines = await page.evaluate(() => window.__glab.paintSamples());
            const buffer = await page.screenshot({ fullPage: true });
            const file = `${scenario}--${label}.png`.replace(/[^a-z0-9.-]+/gi, '-');
            writeFileSync(join(outDir, file), buffer);
            shots.push({ name: label, file });
            const scale = await page.evaluate(() => window.devicePixelRatio);
            const paint = checkPaint(buffer, lines, scale);
            if (lines.length > 0) lab.check(`${label}: ${paint.checked} lines painted on screen`, paint.issues.length === 0, paint.issues);
            return stats;
        },

        /** Console errors and warnings since the scenario started, without the known ones from elsewhere. */
        consoleProblems() {
            return consoleMessages.filter((message) => !knownConsole.some(({ pattern }) => pattern.test(message.text)));
        },

        /**
         * Runs an action while recording every frame, for `duration` ms after it, and films it unless filming is off.
         * The film is cropped to the graph's column on screen, or keeps the whole viewport with `crop: false`.
         */
        async record(page, action, { watch = null, duration = 2500, film = `recording ${films.length + 1}`, crop = true } = {}) {
            const region = crop ? await graphRegion(page) : null;
            const stopFilm = filming.enabled ? await startFilm(page) : null;
            await page.evaluate((options) => window.__glab.startRecording(options), { watch });
            await action();
            await page.waitForTimeout(duration);
            const frames = await page.evaluate(() => window.__glab.stop());
            if (stopFilm) {
                const name = `${scenario}--${film}`.replace(/[^a-z0-9.-]+/gi, '-');
                const made = await stopFilm({ dir: outDir, name, crop: region, speed: filming.speed, format: filming.format }).catch((error) => {
                    lab.check(`${film}: film encoded`, false, String(error).slice(0, 300));
                    return null;
                });
                if (made) films.push({ name: film, ...made });
            }
            return frames;
        },

        async edgeCount(page) {
            return page.evaluate(() => document.querySelectorAll('[data-test="graph-canvas"] > g path').length);
        },

        async expandReplies(page) {
            for (let round = 0; round < 4; round++) {
                const toggles = page.locator('[data-test="toggle-replies-button"][aria-expanded="false"]');
                if ((await toggles.count()) === 0) break;
                await toggles.first().click();
                await lab.settle(page, 600);
            }
        },

        async close() {
            await Promise.all(contexts.map((context) => context.close().catch(() => {})));
            const problems = lab.consoleProblems();
            const known = consoleMessages.length - problems.length;
            lab.check(
                `no console error or warning${known ? ` (${known} known one(s) from elsewhere left out)` : ''}`,
                problems.length === 0,
                [...new Set(problems.map((message) => `${message.type}: ${message.text.slice(0, 220)} (${new URL(message.url || base).pathname})`))],
            );
        },
    };

    return lab;
}

const sample = (frames, pick) =>
    frames
        .filter(pick)
        .slice(0, 4)
        .map((frame) => `at ${frame.t}ms`);

/** The frame rules every animation must keep. */
export function checkFrames(lab, label, frames, { allowNodeIn = true } = {}) {
    const misaligned = frames.filter((frame) => frame.misaligned.length > 0);
    lab.check(
        `${label}: lines stay on their nodes in every frame (${frames.length} frames)`,
        misaligned.length === 0,
        misaligned.slice(0, 4).map((frame) => `at ${frame.t}ms: ${frame.misaligned.slice(0, 3).join(', ')}`),
    );
    lab.check(`${label}: no line slides to a new place`, frames.every((frame) => frame.sliding === 0), sample(frames, (frame) => frame.sliding > 0));
    lab.check(
        `${label}: no line draws itself in off screen`,
        frames.every((frame) => frame.offscreenDraws === 0),
        frames.filter((frame) => frame.offscreenDraws > 0).slice(0, 4).map((frame) => `at ${frame.t}ms: ${frame.offscreenDraws} line(s)`),
    );
    const redrawn = [...new Set(frames.flatMap((frame) => frame.redrawn))];
    lab.check(`${label}: no line already there draws itself in again`, redrawn.length === 0, redrawn.slice(0, 4));
    lab.check(
        `${label}: no line shows over a node while it scales in`,
        frames.every((frame) => frame.lineOverScalingNode === 0),
        sample(frames, (frame) => frame.lineOverScalingNode > 0),
    );
    if (!allowNodeIn) {
        lab.check(`${label}: no node scales in`, frames.every((frame) => frame.nodeIn === 0), sample(frames, (frame) => frame.nodeIn > 0));
    }
}

/** How many lines drew themselves in during the recording, each named by its two nodes. */
export function drawnLines(frames) {
    return new Set(frames.flatMap((frame) => frame.draws.filter((draw) => draw.hidden < 0.99).map((draw) => draw.key))).size;
}

/** Avatar scales in, then its line draws, then the end dot pops: read from the watched card's frames. */
export function checkEntrance(lab, label, frames) {
    const watched = frames.filter((frame) => frame.avatar !== undefined && frame.avatar !== null);
    if (!lab.check(`${label}: the new card shows up`, watched.length > 0)) return;

    const firstIndex = frames.indexOf(watched[0]);
    const after = frames.slice(firstIndex);
    const avatarMoving = after.filter((frame) => Math.abs(frame.avatar - 1) > 0.01);
    const avatarEnd = avatarMoving.at(-1)?.t ?? watched[0].t;
    const offsets = (frame) => frame.draws.map((draw) => draw.hidden);
    const lineStart = after.find((frame) => offsets(frame).some((hidden) => hidden < 0.99))?.t;
    const lineDone = after.find((frame) => offsets(frame).length > 0 && offsets(frame).every((hidden) => hidden <= 0.05))?.t;
    const dotStartFrame = after.find((frame) => frame.dot !== null && frame.dot > 0.01);
    const dotStart = dotStartFrame?.t;
    const lineAtDot = dotStartFrame ? Math.min(1, ...offsets(dotStartFrame)) : null;
    const timeline = `avatar until ${avatarEnd}ms, line ${lineStart}→${lineDone}ms, dot from ${dotStart}ms`;

    lab.check(`${label}: the avatar scales in`, avatarMoving.length > 0, timeline);
    lab.check(`${label}: the line draws once the avatar has scaled in`, lineStart !== undefined && lineStart >= avatarEnd - 20, timeline);
    lab.check(`${label}: the line finishes drawing`, lineDone !== undefined, timeline);
    lab.check(
        `${label}: the end dot pops as the line ends (not before 90% drawn, not 150ms after)`,
        dotStart !== undefined && lineAtDot !== null && lineAtDot <= 0.1 && (lineDone === undefined || dotStart - lineDone <= 150),
        `${timeline}; line ${lineAtDot === null ? '?' : Math.round((1 - lineAtDot) * 100)}% drawn when the dot starts`,
    );
}
