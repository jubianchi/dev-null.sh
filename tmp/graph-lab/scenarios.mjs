import { cast, deleteCommit, postCommit, postReply, viewports } from './lib/app.mjs';
import { checkEntrance, checkFrames, drawnLines } from './lib/lab.mjs';
import { compareRegions } from './lib/pixels.mjs';
import { withSsr } from './lib/ssr.mjs';

const railPieceNames = ['rail-tail', 'rail-previous', 'commit-reply-spine', 'thread-spine', 'thread-elbow', 'thread-column', 'reply-link', 'reply-tail'];
const railPiecesPattern = new RegExp(`data-test="(${railPieceNames.join('|')})"`, 'g');
const railPieces = railPieceNames.map((name) => `[data-test="${name}"]`).join(',');

/**
 * What the viewport shows of the graph: where the cards sit, and the boxes of the rail pieces or the canvas lines,
 * padded a little and named after the card around them.
 */
const graphBoxes = (page, selector) =>
    page.evaluate((selector) => {
        const onScreen = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
        };
        const nameOf = (element) => {
            const card = element.closest('[data-test="reply"], [data-test="commit"]');
            return card?.querySelector('a[href^="/@"]')?.textContent?.trim() || card?.textContent?.trim().slice(0, 30) || 'page';
        };
        const box = (element, kind) => {
            const rect = element.getBoundingClientRect();
            return { kind, name: nameOf(element), left: rect.left - 3, right: rect.right + 3, top: rect.top + window.scrollY - 3, bottom: rect.bottom + window.scrollY + 3 };
        };
        const canvasLines = [...document.querySelectorAll('[data-test="graph-canvas"] > g path')].filter(onScreen);
        // The nodes the canvas cuts out of its lines: avatars and dots, which both sides draw alike.
        const nodes = [...document.querySelectorAll('[data-test="graph-canvas"]')].flatMap((svg) => {
            const origin = svg.getBoundingClientRect();
            return [...svg.querySelectorAll('mask[id$="-nodes"] circle')].map((circle) => ({
                x: origin.left + Number(circle.getAttribute('cx')),
                y: origin.top + window.scrollY + Number(circle.getAttribute('cy')),
                r: Number(circle.getAttribute('r')) + 1,
            }));
        });
        return {
            nodes,
            layout: [...document.querySelectorAll('[data-test="commit"], [data-test="reply"]')].filter(onScreen).map((card) => Math.round(card.getBoundingClientRect().top)),
            boxes: [
                // The elbow is an SVG element, which has no offset size.
                ...[...document.querySelectorAll(selector)]
                    .filter((element) => {
                        const rect = element.getBoundingClientRect();
                        return (rect.width || rect.height) && onScreen(element);
                    })
                    .map((element) => box(element, element.dataset.test)),
                ...canvasLines.map((path) => box(path, path.dataset.test)),
            ],
        };
    }, selector);

/** What the server sent: cards, rail pieces, and canvas lines (none expected before the browser measures). */
const serverMarkup = (html) => {
    const canvas = html.match(/<svg[^>]*data-test="graph-canvas"[\s\S]*?<\/svg>/)?.[0] ?? '';
    return {
        cards: (html.match(/data-test="commit"/g) ?? []).length,
        pieces: (html.match(railPiecesPattern) ?? []).length,
        canvases: (html.match(/data-test="graph-canvas"/g) ?? []).length,
        lines: (canvas.match(/<path/g) ?? []).length,
    };
};

const unique = (label) => `glab ${label} ${Date.now()}`;

// A commit chained under the last one of a thread scales in at the end of the line it takes over, which draws on to it
// meanwhile: once it shows, it never stands apart from the thread.
const checkJoined = (lab, label, frames) => {
    const apart = [...new Set(frames.flatMap((frame) => frame.apart))];
    lab.check(`${label}: the new commit never shows apart from the thread`, apart.length === 0, apart.slice(0, 4));
};

const pagesOf = (fixture) => [
    { name: 'following', path: '/log/following' },
    { name: 'latest', path: '/log/latest' },
    { name: 'trending', path: '/log/trending' },
    { name: 'profile', path: `/@${cast.author}` },
    { name: 'profile-replies', path: `/@${cast.author}?tab=replies` },
    { name: 'thread-root', path: `/@${cast.author}/commits/${fixture.root}`, expand: true },
    { name: 'thread-continuation', path: `/@${cast.author}/commits/${fixture.self1}`, expand: true },
    { name: 'thread-nested', path: `/@${cast.peer}/commits/${fixture.peer1}`, expand: true },
    { name: 'notifications', path: '/notifications' },
];

export const scenarios = [
    {
        name: 'static',
        title: 'Every page draws a clean graph, on desktop, mobile and dark',
        async run(lab) {
            for (const [variant, options] of [
                ['desktop', { viewport: viewports.desktop }],
                ['mobile', { viewport: viewports.mobile }],
                ['dark', { viewport: viewports.desktop, colorScheme: 'dark' }],
            ]) {
                const context = await lab.as(cast.author, options);
                const page = await context.newPage();
                for (const { name, path, expand } of pagesOf(lab.fixture)) {
                    await page.goto(path);
                    await lab.settle(page);
                    if (expand) await lab.expandReplies(page);
                    await lab.audit(page, `${name} (${variant})`, { requireDrawn: name !== 'notifications' });
                }
            }
        },
    },
    {
        name: 'ssr',
        title: 'Server rendering: the rail comes from the server, and the client and canvas take over without a gap',
        async run(lab, { log }) {
            const pages = [
                { name: 'following', path: '/log/following' },
                { name: 'thread-root', path: `/@${cast.author}/commits/${lab.fixture.root}` },
                { name: 'profile', path: `/@${cast.author}` },
            ];
            await withSsr(log, async () => {
                const reader = await lab.as(cast.author);
                const quiet = await lab.as(cast.author, { javaScriptEnabled: false });
                const quietPage = await quiet.newPage();

                for (const { name, path } of pages) {
                    const markup = serverMarkup(await (await reader.request.get(path)).text());
                    lab.check(
                        `${name}: the server renders ${markup.cards} cards with their rail (${markup.pieces} pieces) and an empty canvas`,
                        markup.cards > 0 && markup.pieces > 0 && markup.canvases > 0 && markup.lines === 0,
                        JSON.stringify(markup),
                    );

                    await quietPage.goto(path);
                    const shown = await quietPage.evaluate(
                        (selector) => [...document.querySelectorAll(selector)].filter((element) => element.offsetWidth || element.offsetHeight).length,
                        '[data-test="rail-tail"], [data-test="rail-previous"], [data-test="commit-reply-spine"]',
                    );
                    lab.check(`${name}: without JavaScript, ${shown} rail pieces show`, shown > 0);
                    await lab.shot(quietPage, `${name} server only`);

                    const context = await lab.as(cast.author);
                    await context.addInitScript(() => window.__glab.startHandoff());
                    const page = await context.newPage();
                    await page.goto(path);
                    await lab.settle(page, 1500);
                    const frames = (await page.evaluate(() => window.__glabHandoff ?? [])).filter((frame) => frame.cards > 0);
                    const first = frames[0];
                    const last = frames.at(-1);
                    const blank = frames.filter((frame) => frame.pieces === 0 && frame.lines === 0);
                    const both = frames.filter((frame) => frame.pieces > 0 && frame.lines > 0);
                    const at = (list) => list.slice(0, 4).map((frame) => `at ${frame.t}ms: ${frame.pieces} pieces, ${frame.lines} lines`);
                    lab.check(`${name}: the first painted frame shows the server's rail`, first?.pieces > 0, first ? at([first]) : 'no frame with cards');
                    lab.check(`${name}: no frame shows the cards without any graph`, blank.length === 0, at(blank));
                    lab.check(`${name}: no frame shows the rail and the canvas lines together`, both.length === 0, at(both));
                    lab.check(`${name}: the canvas has taken over`, last?.lines > 0 && last?.pieces === 0, last ? at([last]) : []);
                    if (await page.evaluate(() => window.__glabServerCardsReplaced > 0)) {
                        lab.skip(`${name}: hydration without mismatch`, "the client re-renders the page instead of hydrating it (createRoot in app.tsx), so there's no hydration to check");
                    } else {
                        const mismatches = lab.consoleProblems().filter((message) => /hydrat|#418|#423|#425|did not match/i.test(message.text));
                        lab.check(`${name}: hydration without mismatch`, mismatches.length === 0, mismatches.map((message) => message.text.slice(0, 200)));
                    }
                    if (name === 'thread-root') await lab.expandReplies(page);
                    await lab.audit(page, `${name} in the browser`);
                }
            });
        },
    },
    {
        name: 'handover',
        title: "Server rendering: the canvas takes over from the server's rail without changing how the graph looks",
        async run(lab, { log }) {
            const pages = [
                { name: 'latest', path: '/log/latest' },
                { name: 'thread-root', path: `/@${cast.author}/commits/${lab.fixture.root}` },
                { name: 'thread-nested', path: `/@${cast.peer}/commits/${lab.fixture.peer1}` },
                { name: 'profile', path: `/@${cast.author}` },
                { name: 'profile-replies', path: `/@${cast.author}?tab=replies` },
                { name: 'notifications', path: '/notifications' },
            ];
            // The hand-over happens on the first screen. Cards off screen keep a placeholder height (content-visibility)
            // until they near it, so only the viewport is compared, made tall to take in more of the graph.
            const variants = [
                { variant: 'desktop', viewport: { ...viewports.desktop, height: 2000 } },
                { variant: 'mobile', viewport: { ...viewports.mobile, height: 1800 } },
                { variant: 'dark', viewport: { ...viewports.desktop, height: 2000 }, colorScheme: 'dark' },
            ];
            await withSsr(log, async () => {
                for (const { variant, viewport, colorScheme } of variants) {
                    for (const { name, path } of pages) {
                        const label = `${name} (${variant})`;
                        const context = await lab.as(cast.author, { viewport, colorScheme });
                        const page = await context.newPage();
                        // The app's bundles wait while the server's page, rail included, is captured as it first shows.
                        let release;
                        const held = new Promise((resolve) => (release = resolve));
                        await page.route('**/build/assets/*.js', async (route) => {
                            await held;
                            await route.continue();
                        });
                        // Deferred module scripts hold DOMContentLoaded back too: wait for the server's cards instead.
                        await page.goto(path, { waitUntil: 'commit' });
                        await page.waitForSelector(railPieces, { state: 'attached', timeout: 10000 }).catch(() => {});
                        await page.evaluate(() => document.fonts.ready);
                        await page.waitForTimeout(300);
                        const rail = { ...(await graphBoxes(page, railPieces)), buffer: await page.screenshot() };
                        if (!lab.check(`${label}: the server's page shows its rail before the client runs`, rail.boxes.length > 0, `${rail.boxes.length} rail pieces`)) continue;
                        await lab.shot(page, `${label} rail`, { fullPage: false });
                        release();
                        await page.waitForFunction(() => document.querySelectorAll('[data-test="graph-canvas"] > g path').length > 0, null, { timeout: 10000 }).catch(() => {});
                        await lab.settle(page, 1500);
                        const canvas = { ...(await graphBoxes(page, railPieces)), buffer: await page.screenshot() };
                        await lab.shot(page, `${label} canvas`, { fullPage: false });
                        // Content the client fills in, like who to follow on a mobile feed, can move the cards below it: the
                        // graph is compared above the first card that moves.
                        const moved = rail.layout.findIndex((top, index) => top !== canvas.layout[index]);
                        const cutoff = moved === -1 ? Infinity : Math.min(rail.layout[moved], canvas.layout[moved] ?? Infinity);
                        if (moved !== -1) lab.skip(`${label}: the graph below y=${cutoff}`, 'the cards there move when the client fills in deferred content, which the graph has no part in');
                        const changed = compareRegions(rail.buffer, canvas.buffer, [...rail.boxes, ...canvas.boxes].filter((box) => box.top < cutoff), 2, canvas.nodes);
                        lab.check(
                            `${label}: the ${rail.boxes.length} rail pieces and the ${canvas.boxes.length} canvas lines look the same`,
                            canvas.boxes.length > 0 && changed.length === 0,
                            changed.slice(0, 6).map((box) => `${box.kind} by ${box.name} at ${Math.round(box.left)},${Math.round(box.top)}: ${box.reasons.join(', ')}`),
                        );
                    }
                }
            });
        },
    },
    {
        name: 'reduced',
        title: 'With reduced motion, nothing animates and everything shows in its final state',
        async run(lab) {
            const options = { reducedMotion: 'reduce' };
            const context = await lab.as(cast.calm, options);
            const page = await context.newPage();
            await page.goto('/log/following');
            await lab.settle(page);
            const body = unique('calm');
            const frames = await lab.record(
                page,
                async () => {
                    await page.locator('textarea').first().click();
                    await page.keyboard.type(body);
                    await page.keyboard.press('Meta+Enter');
                },
                { watch: body, duration: 2500, film: 'posting with reduced motion' },
            );
            checkFrames(lab, 'posting with reduced motion', frames, { allowNodeIn: false });
            const midDraw = frames.filter((frame) => frame.draws.some((draw) => draw.hidden > 0.01));
            lab.check('posting with reduced motion: no line draws itself in, each shows whole', midDraw.length === 0, midDraw.slice(0, 4).map((frame) => `at ${frame.t}ms`));
            const shown = frames.filter((frame) => frame.avatar !== undefined && frame.avatar !== null);
            const scaled = shown.filter((frame) => Math.abs(frame.avatar - 1) > 0.01 || (frame.dot !== null && Math.abs(frame.dot - 1) > 0.01));
            lab.check(
                `posting with reduced motion: the new avatar and end dot show at full size from the start (${shown.length} frames)`,
                shown.length > 0 && scaled.length === 0,
                scaled.slice(0, 4).map((frame) => `at ${frame.t}ms: avatar ${frame.avatar}, dot ${frame.dot}`),
            );
            await lab.audit(page, 'after posting with reduced motion');

            await page.goto(`/@${cast.author}/commits/${lab.fixture.root}`);
            await lab.settle(page);
            const toggle = page.locator('[data-test="toggle-replies-button"][aria-expanded="false"]').first();
            if ((await toggle.count()) > 0) {
                const opening = await lab.record(page, () => toggle.click(), { duration: 1500, film: 'opening replies with reduced motion' });
                checkFrames(lab, 'opening replies with reduced motion', opening, { allowNodeIn: false });
                const drawing = opening.filter((frame) => frame.draws.some((draw) => draw.hidden > 0.01));
                lab.check('opening replies with reduced motion: no line draws itself in', drawing.length === 0, drawing.slice(0, 4).map((frame) => `at ${frame.t}ms`));
                await lab.audit(page, 'replies opened with reduced motion');
            }
        },
    },
    {
        name: 'expand',
        title: 'Opening replies draws only the new lines, in place',
        async run(lab) {
            const page = await lab.open(cast.author, `/@${cast.author}/commits/${lab.fixture.root}`);
            const toggle = page.locator('[data-test="toggle-replies-button"][aria-expanded="false"]').first();
            if (!lab.check('a collapsed thread to open', (await toggle.count()) > 0)) return;
            const before = await lab.edgeCount(page);
            const frames = await lab.record(page, () => toggle.click(), { film: 'opening replies' });
            const added = (await lab.edgeCount(page)) - before;
            checkFrames(lab, 'opening replies', frames);
            lab.check(`opening replies: the ${added} new line(s) draw in`, added > 0 && drawnLines(frames) >= 1, `${drawnLines(frames)} drawn for ${added} added`);
            await lab.audit(page, 'replies opened');
        },
    },
    {
        name: 'more',
        title: 'Loading more replies draws only the new lines, in place',
        async run(lab) {
            const page = await lab.open(cast.author, `/@${cast.author}/commits/${lab.fixture.root}`);
            await lab.expandReplies(page);
            const more = page.locator('[data-test="more-replies-button"]').first();
            if (!lab.check('a "more replies" button', (await more.count()) > 0)) return;
            // Down to the last page, where the "more replies" dot gives way to the replies and its line to theirs.
            const labels = [];
            for (let round = 0; round < 4 && (await more.count()) > 0; round++) {
                const label = `loading more ("${(await more.innerText()).trim()}")`;
                labels.push(label);
                const before = await lab.edgeCount(page);
                const frames = await lab.record(page, () => more.click(), { film: label });
                const added = (await lab.edgeCount(page)) - before;
                checkFrames(lab, label, frames);
                lab.check(`${label}: the new line(s) draw in`, drawnLines(frames) >= 1, `${drawnLines(frames)} drawn, ${added} added`);
                await lab.audit(page, `${label}: replies loaded`);
            }
            lab.check('every reply loaded, down to the last page', (await more.count()) === 0 && labels.some((label) => label.includes('the last')), labels);
        },
    },
    {
        name: 'post',
        title: 'Posting: avatar, then line, then dot; nothing else moves',
        async run(lab) {
            const page = await lab.open(cast.poster, '/log/following');
            const body = unique('post');
            const before = await lab.edgeCount(page);
            const frames = await lab.record(
                page,
                async () => {
                    await page.locator('textarea').first().click();
                    await page.keyboard.type(body);
                    await page.keyboard.press('Meta+Enter');
                },
                { watch: body, duration: 3500, film: 'posting' },
            );
            const added = (await lab.edgeCount(page)) - before;
            checkFrames(lab, 'posting', frames);
            checkEntrance(lab, 'posting', frames);
            // The feed's first page keeps its size, so the line count can stay the same as an older card drops off.
            lab.check(`posting: only the new card's line draws in`, drawnLines(frames) === 1, `${drawnLines(frames)} drawn, ${added} added`);
            await lab.audit(page, 'after posting');
        },
    },
    {
        name: 'reorder',
        title: 'Posting to a ranked feed reorders cards without stale lines',
        async run(lab) {
            const page = await lab.open(cast.ranker, '/log/trending');
            const body = unique('reorder');
            const frames = await lab.record(
                page,
                async () => {
                    await page.locator('textarea').first().click();
                    await page.keyboard.type(body);
                    await page.keyboard.press('Meta+Enter');
                },
                { duration: 3000, film: 'reordering' },
            );
            // Otherwise nothing reordered, and every check below passes for nothing.
            lab.check('reordering: the new card shows up', (await page.locator('[data-test="commit"]', { hasText: body }).count()) > 0);
            checkFrames(lab, 'reordering', frames);
            await lab.audit(page, 'after reordering');
        },
    },
    {
        name: 'scroll',
        title: 'Scrolling loads more cards: their lines show drawn, nothing draws off screen, no mask stays',
        async run(lab) {
            const page = await lab.open(cast.author, '/log/latest');
            const before = await lab.edgeCount(page);
            const frames = await lab.record(
                page,
                async () => {
                    // Slow enough for the server's rate limit on loading pages.
                    for (let step = 0; step < 8; step++) {
                        await page.mouse.wheel(0, 1200);
                        await page.waitForTimeout(700);
                    }
                },
                { duration: 2500, film: 'scrolling' },
            );
            const after = await lab.edgeCount(page);
            lab.check(`scrolling loads more cards (${before} → ${after} lines)`, after > before);
            checkFrames(lab, 'scrolling', frames);
            // Back at the top, where the full-page screenshot draws the sticky header in place rather than over cards.
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(300);
            await lab.audit(page, 'after scrolling');
        },
    },
    {
        name: 'quote',
        title: 'A quote listed under the commit it quotes, and as a card of its own, in the same feed',
        async run(lab) {
            const quoted = await lab.as(cast.quoted);
            const body = unique('quoted');
            const root = await postCommit(quoted, cast.quoted, body);
            const quoter = await lab.as(cast.quoter);
            await postCommit(quoter, cast.quoter, unique('quoting'), { quote: root });
            const page = await lab.open(cast.author, '/log/latest');
            // The quoting card holds the quoted body too, in its embed: the quoted card is the one listing replies.
            const listed = await page
                .locator('[data-test="commit"]', { hasText: body })
                .locator('[data-test="reply"]', { hasText: cast.quoter })
                .count();
            lab.check('the quote shows under the commit it quotes', listed > 0);
            await lab.audit(page, 'quote and quoted commit in one feed');
        },
    },
    {
        name: 'deleted',
        title: 'Deleted commits at every depth of a thread: tombstones keep their node and their lines',
        async run(lab) {
            const as = Object.fromEntries(
                await Promise.all(['eraser', 'peer', 'pal', 'survivor'].map(async (role) => [role, await lab.as(cast[role])])),
            );
            const post = (role, label) => postCommit(as[role], cast[role], unique(label));
            const reply = (role, parent, label) => postReply(as[role], cast[role], parent, unique(label));
            const erase = (role, id) => deleteCommit(as[role], cast[role], id);

            // root
            // ├─ self 1 (deleted, the continuation) ─ self 2
            // ├─ a (deleted) ─ a1 (deleted) ─ a1a
            // ├─ b ─ b1 (deleted) ─ b1a
            // │    └ b2 ─ b2a (deleted) ─ b2a1 (past the deepest indent)
            // └─ leaf (deleted, without replies: it goes)
            // other root (deleted) ─ other reply
            const root = await post('eraser', 'deleted root');
            const self1 = await reply('eraser', root, 'deleted self 1');
            await reply('eraser', self1, 'deleted self 2');
            const a = await reply('peer', root, 'deleted a');
            const a1 = await reply('pal', a, 'deleted a1');
            const a1a = await reply('survivor', a1, 'deleted a1a');
            const b = await reply('pal', root, 'deleted b');
            const b1 = await reply('peer', b, 'deleted b1');
            await reply('survivor', b1, 'deleted b1a');
            const b2 = await reply('survivor', b, 'deleted b2');
            const b2a = await reply('peer', b2, 'deleted b2a');
            const b2a1 = await reply('pal', b2a, 'deleted b2a1');
            const leaf = await reply('survivor', root, 'deleted leaf');
            const otherRoot = await post('eraser', 'deleted other root');
            await reply('peer', otherRoot, 'deleted other reply');

            await erase('eraser', self1);
            await erase('peer', a);
            await erase('pal', a1);
            await erase('peer', b1);
            await erase('peer', b2a);
            await erase('survivor', leaf);
            await erase('eraser', otherRoot);

            const pages = [
                { name: 'thread', path: `/@${cast.eraser}/commits/${root}`, tombstones: 5 },
                { name: 'feed', path: '/log/latest', card: root },
                { name: 'under two deleted ancestors', path: `/@${cast.survivor}/commits/${a1a}` },
                { name: 'past the deepest indent', path: `/@${cast.pal}/commits/${b2a1}` },
                { name: 'replies under deleted parents', path: `/@${cast.survivor}?tab=replies` },
                { name: 'under a deleted root', path: `/@${cast.peer}?tab=replies` },
            ];

            for (const [variant, viewport] of [
                ['desktop', viewports.desktop],
                ['mobile', viewports.mobile],
            ]) {
                const page = await (await lab.as(cast.author, { viewport })).newPage();
                for (const { name, path, tombstones, card } of pages) {
                    const response = await page.goto(path);
                    if (!lab.check(`${name} (${variant}) opens`, response.ok(), [`${path}: ${response.status()}`])) continue;
                    await lab.settle(page);
                    const scope = card ? page.locator('[data-test="commit"]', { has: page.locator(`[href$="${card}"]`) }).first() : page;
                    for (let round = 0; round < 12; round++) {
                        const toggles = scope.locator('[data-test="toggle-replies-button"][aria-expanded="false"]');
                        if ((await toggles.count()) === 0) break;
                        await toggles.first().click();
                        await lab.settle(page, 600);
                    }
                    if (tombstones !== undefined) {
                        const shown = await page.locator('[data-test="reply-tombstone"]').count();
                        lab.check(`${name} (${variant}): ${tombstones} tombstones (the continuation, a, a1, b1, b2a), the deleted leaf gone`, shown === tombstones, [`${shown} tombstones`]);
                    }
                    await lab.audit(page, `${name} (${variant})`);
                }
            }
        },
    },
    {
        name: 'delete',
        title: 'Deleting a commit from the feed: its lines fade and clip with its collapsing row',
        async run(lab) {
            const deleter = await lab.as(cast.deleter);
            const peer = await lab.as(cast.peer);
            const labels = [unique('delete filmed'), unique('delete shot')];
            for (const label of labels) {
                const body = `${label}\n\nA longer body, so the card's line runs well below its node.\n\nA second paragraph.\n\nA third one.`;
                const id = await postCommit(deleter, cast.deleter, body);
                await postReply(peer, cast.peer, id, unique('delete reply'));
            }

            const page = await lab.open(cast.deleter, '/log/latest');
            const start = async (label) => {
                const card = page.locator('[data-test="commit"]', { hasText: label }).first();
                await card.evaluate((element) => {
                    element.scrollIntoView({ block: 'center' });
                    element.dataset.glabLeaving = '';
                });
                await lab.settle(page, 400);
                await card.hover();
                await card.locator('[data-test="delete-commit-button"]').click();
                return card.locator('[data-test="confirm-delete-commit-button"]');
            };

            const confirmFilmed = await start(labels[0]);
            const frames = await lab.record(page, () => confirmFilmed.click(), { duration: 1400, film: 'deleting a commit' });
            const leaving = frames.filter((frame) => frame.leaving && !frame.leaving.isGone);
            const at = (frame) => `at ${frame.t}ms, row ${frame.leaving.rowHeight}px at ${frame.leaving.rowOpacity}${frame.leaving.worst ? `, line ${frame.leaving.worst}` : ''}`;
            if (lab.check('the row fades and collapses', leaving.some((frame) => frame.leaving.rowOpacity < 0.5), [`${leaving.length} frames`])) {
                const overflowing = leaving.filter((frame) => frame.leaving.overflow > 2);
                lab.check('its lines stay within the row as it collapses', overflowing.length === 0, overflowing.slice(0, 4).map((frame) => `${at(frame)}: lines run ${frame.leaving.overflow}px past it`));
                const opaque = leaving.filter((frame) => frame.leaving.excess > 0.05);
                lab.check('its lines fade with the row', opaque.length === 0, opaque.slice(0, 4).map((frame) => `${at(frame)}: lines ${frame.leaving.excess} more opaque`));
                const holed = leaving.filter((frame) => frame.leaving.holes > 0);
                lab.check('its hidden nodes cut no other line', holed.length === 0, holed.slice(0, 4).map((frame) => `${at(frame)}: ${frame.leaving.holes} hole(s)`));
            }
            checkFrames(lab, 'deleting a commit', frames);
            await lab.audit(page, 'after deleting');

            // Halfway through the fade, frozen: the card's 700ms removal is held and the transitions paused for the shot.
            const confirmShot = await start(labels[1]);
            await page.evaluate(() => {
                const setTimeout = window.setTimeout;
                window.setTimeout = (callback, delay, ...rest) => {
                    if (delay !== 700) return setTimeout(callback, delay, ...rest);
                    window.setTimeout = setTimeout;
                    window.__glabHeld = () => callback(...rest);
                    return 0;
                };
            });
            await confirmShot.click();
            await page.waitForTimeout(550);
            await page.evaluate(() => document.getAnimations().forEach((animation) => animation.pause()));
            await lab.shot(page, 'mid-deletion', { fullPage: false });
            await page.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
            await page.waitForTimeout(400);
            await page.evaluate(() => window.__glabHeld?.());
            await lab.settle(page, 1200);
            await lab.audit(page, 'after deleting again', { screenshot: false });
        },
    },
    {
        name: 'swap',
        title: 'Cards trading places without any resize: lines follow in the same frame',
        async run(lab) {
            const page = await lab.open(cast.author, '/log/latest');
            const swapped = await page.evaluate(() => {
                const cards = [...document.querySelectorAll('[data-test="graph-canvas"]')[0].parentElement.querySelectorAll('[data-test="commit"]')];
                for (let i = 0; i < cards.length - 1; i++) {
                    for (let j = i + 1; j < cards.length; j++) {
                        const [a, b] = [cards[i], cards[j]];
                        const lane = (card) => card.querySelector('[style*="--lane"]')?.style.getPropertyValue('--lane');
                        if (a.offsetHeight === b.offsetHeight && lane(a) !== lane(b) && a.parentElement === b.parentElement && b.previousElementSibling !== a) {
                            window.__glabSwap = () => {
                                const marker = document.createComment('glab');
                                a.replaceWith(marker);
                                b.replaceWith(a);
                                marker.replaceWith(b);
                            };
                            return true;
                        }
                    }
                }
                return false;
            });
            if (!lab.check('two cards of the same height, in different lanes, to swap', swapped)) return;
            const frames = await lab.record(page, () => page.evaluate(() => window.__glabSwap()), { duration: 600, film: 'swapping cards' });
            checkFrames(lab, 'swapping cards', frames);
            await lab.audit(page, 'after swapping');
        },
    },
    {
        name: 'arrival',
        title: 'A commit from someone else arriving through the "new commits" button',
        slow: true,
        async run(lab) {
            const page = await lab.open(cast.author, '/log/following');
            const peer = await lab.as(cast.peer);
            await postCommit(peer, cast.peer, unique('arrival'));
            const button = page.getByRole('button', { name: /new commits?$/ });
            const appeared = await button.waitFor({ timeout: 40_000 }).then(() => true, () => false);
            if (!lab.check('the "new commits" button shows up within 40s', appeared)) return;
            const before = await lab.edgeCount(page);
            const frames = await lab.record(page, () => button.click(), { duration: 3000, film: 'arrival' });
            const added = (await lab.edgeCount(page)) - before;
            checkFrames(lab, 'arrival', frames);
            lab.check(`arrival: the new card's line draws in`, drawnLines(frames) >= 1, `${drawnLines(frames)} drawn, ${added} added`);
            await lab.audit(page, 'after arrival');
        },
    },
    {
        name: 'thread-open',
        title: 'Opening a thread right after posting it: nothing pops again',
        async run(lab) {
            const context = await lab.as(cast.threader);
            const body = unique('thread');
            const root = await postCommit(context, cast.threader, body);
            await postReply(context, cast.threader, root, `${body} reply`);
            const page = await context.newPage();
            await page.goto('/log/following');
            await page.waitForLoadState('networkidle');
            const link = page.locator('[data-test="commit"]', { hasText: body }).locator('[data-test="show-thread-link"]').first();
            if (!lab.check('a "Show thread" link on the new thread', await link.isVisible().catch(() => false))) return;
            const frames = await lab.record(page, () => link.click(), { duration: 2500, film: 'opening the thread' });
            checkFrames(lab, 'opening the thread', frames, { allowNodeIn: false });
            lab.check('opening the thread: no line draws in', drawnLines(frames) === 0, `${drawnLines(frames)} drawn`);
            await lab.audit(page, 'thread opened');
        },
    },
    {
        name: 'chain',
        title: 'Replying to oneself on the thread page',
        async run(lab) {
            const context = await lab.as(cast.chainer);
            const body = unique('chain');
            const root = await postCommit(context, cast.chainer, body);
            await postReply(context, cast.chainer, root, `${body} 1`);
            // Each post dispatches the unique CheckUserLevel job inside its transaction: posting again before the queue
            // has run it trips over its lock (a 500 on the cache store in the database).
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const page = await context.newPage();
            await page.goto(`/@${cast.chainer}/commits/${root}`);
            await lab.settle(page);
            await page.locator('[data-test="commit"]').last().getByRole('button', { name: /^Reply/ }).first().click();
            await page.waitForTimeout(300);
            const frames = await lab.record(
                page,
                async () => {
                    await page.locator('textarea').last().click();
                    await page.keyboard.type(`${body} 2`);
                    await page.keyboard.press('Meta+Enter');
                },
                { duration: 3500, film: 'chained reply' },
            );
            checkFrames(lab, 'chained reply', frames);
            checkJoined(lab, 'chained reply', frames);
            await lab.audit(page, 'after the chained reply');
        },
    },
    {
        name: 'first-chain',
        title: 'Replying to oneself twice under a commit of its own: each new commit scales in on the line to it',
        async run(lab) {
            const context = await lab.as(cast.starter);
            const body = unique('first chain');
            const root = await postCommit(context, cast.starter, body);
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const page = await context.newPage();
            await page.goto(`/@${cast.starter}/commits/${root}`);
            await lab.settle(page);
            for (const index of [1, 2]) {
                const label = `reply ${index}`;
                await page.locator('[data-test="commit"]').last().getByRole('button', { name: /^Reply/ }).first().click();
                await page.waitForTimeout(300);
                const frames = await lab.record(
                    page,
                    async () => {
                        await page.locator('textarea').last().click();
                        await page.keyboard.type(`${body} ${index}`);
                        await page.keyboard.press('Meta+Enter');
                    },
                    { duration: 3500, film: label },
                );
                checkFrames(lab, label, frames);
                checkJoined(lab, label, frames);
                await lab.audit(page, `after ${label}`);
                // The unique CheckUserLevel job's lock again (see `chain`).
                await page.waitForTimeout(3000);
            }
        },
    },
    {
        name: 'go-on',
        title: "Going on with one's thread under a commit with replies: their branches stay drawn as the trunk goes on",
        async run(lab) {
            const context = await lab.as(cast.continuer);
            const peer = await lab.as(cast.peer);
            const body = unique('go on');
            const root = await postCommit(context, cast.continuer, body);
            for (const index of [1, 2, 3]) {
                // The unique CheckUserLevel job's lock (see `chain`).
                await new Promise((resolve) => setTimeout(resolve, 3000));
                await postReply(peer, cast.peer, root, `${body} reply ${index}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const page = await context.newPage();
            await page.goto(`/@${cast.continuer}/commits/${root}`);
            await lab.settle(page);
            await lab.expandReplies(page);
            await page.locator('[data-test="commit"]').last().getByRole('button', { name: /^Reply/ }).first().click();
            await page.waitForTimeout(300);
            const frames = await lab.record(
                page,
                async () => {
                    await page.locator('textarea').last().click();
                    await page.keyboard.type(`${body} going on`);
                    await page.keyboard.press('Meta+Enter');
                },
                { duration: 3500, film: 'going on' },
            );
            checkFrames(lab, 'going on', frames);
            checkJoined(lab, 'going on', frames);
            // The only new lines run down the trunk: a line turning to a reply is a branch already there drawing again.
            const redrawn = [...new Set(frames.flatMap((frame) => frame.draws).filter(({ d, hidden }) => hidden > 0.01 && / H [\d.]+$/.test(d)).map(({ d }) => d))];
            lab.check('going on: the branches to the replies already there stay drawn', redrawn.length === 0, redrawn.slice(0, 4));
            await lab.audit(page, 'after going on');
        },
    },
    {
        name: 'long-chain',
        title: 'Replying to oneself under a long thread: the line runs on to the new commit and its end dot',
        async run(lab) {
            const context = await lab.as(cast.longChainer);
            const body = unique('long chain');
            let last = await postCommit(context, cast.longChainer, body);
            const root = last;
            for (let index = 1; index < 6; index++) {
                // Each post holds the unique CheckUserLevel job's lock until the queue has run it (see `chain`).
                await new Promise((resolve) => setTimeout(resolve, 3000));
                last = await postReply(context, cast.longChainer, last, `${body} ${index}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const page = await context.newPage();
            await page.goto(`/@${cast.longChainer}/commits/${root}`);
            await lab.settle(page);
            await page.locator('[data-test="commit"]').last().getByRole('button', { name: /^Reply/ }).first().click();
            await page.waitForTimeout(300);
            const frames = await lab.record(
                page,
                async () => {
                    await page.locator('textarea').last().click();
                    await page.keyboard.type(`${body} 6`);
                    await page.keyboard.press('Meta+Enter');
                },
                { duration: 3500, film: 'chained reply' },
            );
            checkFrames(lab, 'chained reply', frames);
            checkJoined(lab, 'chained reply', frames);
            await lab.audit(page, 'after the chained reply');
            lab.check(
                'after the chained reply: the last commit ends on its dot',
                (await page.locator('[data-test="commit"]').last().locator('[data-test="rail-end-dot"]').count()) === 1,
            );
        },
    },
    {
        name: 'hover',
        title: 'Hovering an author dims the other lanes, lines with their nodes',
        async run(lab) {
            for (const path of ['/log/following', `/@${cast.author}/commits/${lab.fixture.root}`]) {
                const page = await lab.open(cast.author, path);
                await lab.expandReplies(page);
                // A rail or reply avatar, not a mention of the same account in a commit's body.
                const avatar = page
                    .locator(
                        ['[aria-hidden] a', '[data-test="reply"] a.rounded-full']
                            .flatMap((target) => ['glab-peer', 'glab-pal'].map((user) => `[data-test="commit"] ${target}[href^="/@${user}"]`))
                            .join(', '),
                    )
                    .first();
                if (!lab.check(`${path}: a card or reply by someone else to hover`, (await avatar.count()) > 0)) continue;
                // The feed ignores hovers while it scrolls, so bring the avatar on screen first.
                await avatar.scrollIntoViewIfNeeded();
                await page.waitForTimeout(500);
                const observedBefore = await page.evaluate(() => ({ ...window.__glabObserved }));
                await avatar.hover();
                await page.waitForTimeout(500);
                const { mismatches, dimmedNodes, checked } = await page.evaluate(() => window.__glab.dimming());
                lab.check(`${path}: hovering dims ${dimmedNodes} node(s) and their ${checked} checked lines match`, mismatches.length === 0 && (dimmedNodes > 0 || path.includes('/commits/')), mismatches);
                await lab.shot(page, `hover ${path}`, { fullPage: false });
                await page.mouse.move(5, 5);
                await page.waitForTimeout(500);
                const after = await page.evaluate(() => window.__glab.dimming());
                lab.check(`${path}: leaving brings every line back`, after.mismatches.length === 0 && after.dimmedNodes === 0, after.mismatches);
                const observedAfter = await page.evaluate(() => ({ ...window.__glabObserved }));
                const reobserved = observedAfter.observe - observedBefore.observe + observedAfter.unobserve - observedBefore.unobserve;
                lab.check(`${path}: hovering and leaving register no node again`, reobserved === 0, `${observedAfter.observe - observedBefore.observe} observe, ${observedAfter.unobserve - observedBefore.unobserve} unobserve`);
            }
        },
    },
    {
        name: 'resize',
        title: 'Resizing keeps every line on its nodes',
        async run(lab) {
            const page = await lab.open(cast.author, `/@${cast.author}/commits/${lab.fixture.root}`);
            await lab.expandReplies(page);
            const frames = await lab.record(
                page,
                async () => {
                    for (const width of [390, 820, 1280, 600]) {
                        await page.setViewportSize({ width, height: 1000 });
                        await page.waitForTimeout(250);
                    }
                },
                { duration: 500, film: 'resizing', crop: false },
            );
            checkFrames(lab, 'resizing', frames);
            await lab.audit(page, 'after resizing');
        },
    },
    {
        name: 'navigate',
        title: 'Navigating between pages: every new page draws cleanly and nothing is logged',
        async run(lab) {
            const page = await lab.open(cast.author, '/log/following');
            const steps = [
                ['an avatar to a profile', () => page.locator('[data-test="commit"] a[href^="/@glab-peer"]').first().click()],
                ['back to the feed', () => page.goBack()],
                ['a permalink to a thread', () => page.locator('[data-test="commit-permalink"]').nth(1).click()],
                ['back to the feed', () => page.goBack()],
                ['a tab', () => page.locator('a[href="/log/latest"]').first().click()],
                ['the notifications', () => page.locator('a[href="/notifications"]').first().click()],
                ['forward and back', async () => {
                    await page.goBack();
                    await page.goForward();
                }],
            ];
            for (const [label, step] of steps) {
                const consoleBefore = lab.consoleProblems().length;
                await step();
                await lab.settle(page, 700);
                const raised = lab.consoleProblems().slice(consoleBefore);
                lab.check(`following ${label} logs nothing`, raised.length === 0, raised.map((message) => message.text.slice(0, 200)));
                await lab.audit(page, `after following ${label}`, { screenshot: false, requireDrawn: false });
            }
        },
    },
    {
        name: 'hunt',
        title: 'Random navigation: the graph never goes stale or vanishes',
        async run(lab, { steps = 25 } = {}) {
            const page = await lab.open(cast.author, '/log/following');
            const moves = {
                tab: () => page.locator('a[href^="/log/"]').nth(Math.floor(Math.random() * 3)).click({ timeout: 3000 }),
                commit: () => page.locator('[data-test="commit-permalink"]').nth(Math.floor(Math.random() * 4)).click({ timeout: 3000 }),
                profile: () => page.goto(`/@${[cast.author, cast.peer, cast.pal][Math.floor(Math.random() * 3)]}`),
                avatar: () => page.locator('[data-test="commit"] a[href^="/@"]').nth(Math.floor(Math.random() * 4)).click({ timeout: 3000 }),
                notifications: () => page.goto('/notifications'),
                back: () => page.goBack(),
                forward: () => page.goForward(),
                scroll: () => page.mouse.wheel(0, 2500),
                top: () => page.evaluate(() => window.scrollTo(0, 0)),
                expand: () => lab.expandReplies(page),
                resize: () => page.setViewportSize([viewports.mobile, viewports.desktop][Math.floor(Math.random() * 2)]),
            };
            const names = Object.keys(moves);
            const trail = [];
            let clean = 0;
            for (let step = 0; step < steps; step++) {
                const name = names[Math.floor(Math.random() * names.length)];
                trail.push(name);
                const consoleBefore = lab.consoleProblems().length;
                await moves[name]().catch(() => {});
                await lab.settle(page, 600);
                const raised = lab.consoleProblems().slice(consoleBefore);
                if (raised.length > 0) {
                    lab.check(`step ${step + 1} (${name}) on ${new URL(page.url()).pathname} logs nothing`, false, raised.map((message) => message.text.slice(0, 200)));
                }
                const { issues } = await page.evaluate(() => window.__glab.audit({ requireDrawn: false }));
                if (issues.length === 0) {
                    clean++;
                    continue;
                }
                lab.check(`step ${step + 1} after ${trail.slice(-4).join(' › ')} on ${new URL(page.url()).pathname}`, false, issues);
                await lab.shot(page, `hunt step ${step + 1}`, { fullPage: false });
            }
            lab.check(`${clean} of ${steps} random steps clean (${trail.join(' › ')})`, clean === steps);
        },
    },
];
