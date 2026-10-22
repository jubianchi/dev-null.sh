import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request } from 'playwright';
import { installProbe } from './probe.mjs';

export const viewports = {
    desktop: { width: 1280, height: 1000 },
    mobile: { width: 390, height: 844 },
};

/** A local account the lab acts as. The local login creates it on first use. */
export async function signIn(
    browser,
    base,
    username,
    { viewport = viewports.desktop, colorScheme = 'light', javaScriptEnabled = true, reducedMotion = 'no-preference' } = {},
) {
    const context = await browser.newContext({ baseURL: base, viewport, colorScheme, javaScriptEnabled, reducedMotion, deviceScaleFactor: 2 });
    await context.addInitScript(installProbe);
    await context.request.get('/');
    await context.request.post('/login/local', {
        headers: { 'X-XSRF-TOKEN': await xsrf(context), 'X-Inertia': 'true' },
        data: { username },
    });
    return context;
}

async function xsrf(context) {
    const cookie = (await context.cookies()).find((entry) => entry.name === 'XSRF-TOKEN');
    if (!cookie) throw new Error('no XSRF-TOKEN cookie: is the dev server up?');
    return decodeURIComponent(cookie.value);
}

async function pageProps(context, path) {
    const html = await (await context.request.get(path)).text();
    const json = html.match(/<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    if (!json) throw new Error(`no Inertia page data on ${path}`);
    return JSON.parse(json).props;
}

// A post that fails with a 500 is rolled back, so it is sent again. A 500 on the CheckUserLevel lock means a migration is
// missing from the dev database (php artisan migrate).
async function send(attempt) {
    for (let tries = 1; ; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const response = await attempt();
        if (response.status() !== 500 || tries === 4) return response;
        await new Promise((resolve) => setTimeout(resolve, 600 * tries));
    }
}

/** Posts a root commit, quoting another one when given its id, and returns its id. */
export async function postCommit(context, username, body, { quote } = {}) {
    const response = await send(async () =>
        context.request.post('/commits', {
            headers: { 'X-XSRF-TOKEN': await xsrf(context), 'X-Inertia': 'true' },
            // A new account's first commit accepts the commit rules, as the composer does.
            data: { body, commit_rules_accepted: true, ...(quote ? { quoted_commit_id: quote } : {}) },
            maxRedirects: 0,
        }),
    );
    if (response.status() === 429) throw new Error(`@${username} hit the commit rate limit (10 per minute): wait a minute`);
    if (response.status() >= 400) throw new Error(`posting as @${username} failed: ${response.status()}`);
    const { commits } = await pageProps(context, `/@${username}`);
    const commit = commits.data.find((entry) => entry.body === body);
    if (!commit) throw new Error(`could not find the commit just posted by @${username}`);
    return commit.id;
}

/** Replies to a commit and returns the reply's id. */
export async function postReply(context, username, parentId, body) {
    const response = await send(async () =>
        context.request.post(`/commits/${parentId}/replies`, {
            headers: { 'X-XSRF-TOKEN': await xsrf(context), Accept: 'application/json' },
            data: { body, commit_rules_accepted: true },
        }),
    );
    if (response.status() === 429) throw new Error(`@${username} hit the commit rate limit (10 per minute): wait a minute`);
    if (!response.ok()) throw new Error(`replying as @${username} failed: ${response.status()} ${await response.text()}`);
    return (await response.json()).committed.id;
}

/** Deletes one of the account's own commits, which stays in its thread as a tombstone while it has replies. */
export async function deleteCommit(context, username, id) {
    const response = await send(async () =>
        context.request.delete(`/commits/${id}`, {
            headers: { 'X-XSRF-TOKEN': await xsrf(context), 'X-Inertia': 'true' },
            maxRedirects: 0,
        }),
    );
    if (response.status() >= 400) throw new Error(`deleting ${id} as @${username} failed: ${response.status()}`);
}

export async function follow(context, username) {
    await context.request.post(`/@${username}/follow`, {
        headers: { 'X-XSRF-TOKEN': await xsrf(context), 'X-Inertia': 'true' },
        maxRedirects: 0,
    });
}

export const cast = {
    author: 'glab-author',
    peer: 'glab-peer',
    pal: 'glab-pal',
    poster: 'glab-poster',
    ranker: 'glab-ranker',
    threader: 'glab-threader',
    chainer: 'glab-chainer',
    calm: 'glab-calm',
    quoted: 'glab-quoted',
    quoter: 'glab-quoter',
    eraser: 'glab-eraser',
    survivor: 'glab-survivor',
};

/**
 * New accounts post into the moderation queue, where nobody else sees their commits. This gives the lab's accounts the
 * reputation that skips it, through artisan tinker on the dev database.
 */
export function trustCast(log = () => {}) {
    const output = execFileSync(process.env.GLAB_PHP ?? '/opt/homebrew/opt/php/bin/php', ['artisan', 'tinker', fileURLToPath(new URL('./reputation.php', import.meta.url))], {
        env: { ...process.env, GLAB_CAST: Object.values(cast).join(','), DB_PASSWORD: process.env.DB_PASSWORD ?? 'password' },
        encoding: 'utf8',
    });
    const untrusted = output.split('\n').filter((line) => line.includes('NOT trusted'));
    if (untrusted.length > 0) throw new Error(`some lab accounts are not trusted: ${untrusted.join(', ')}`);
    log(`lab accounts trusted (${Object.values(cast).length})`);
}

/**
 * The thread every static check looks at: a root with a self-thread (continuation), replies from others that branch off
 * it, a nested reply, a reply off the continuation, and enough replies for a "more replies" button.
 */
export async function ensureFixture(browser, base, file, { fresh = false, log = () => {} } = {}) {
    if (!fresh && existsSync(file)) {
        const fixture = JSON.parse(readFileSync(file, 'utf8'));
        const check = await request.newContext({ baseURL: base });
        const response = await check.get(`/@${cast.author}/commits/${fixture.root}`);
        await check.dispose();
        if (response.ok()) {
            log(`reusing the fixture thread ${fixture.root}`);
            return fixture;
        }
    }

    log('building the fixture thread');
    const author = await signIn(browser, base, cast.author);
    const peer = await signIn(browser, base, cast.peer);
    const pal = await signIn(browser, base, cast.pal);
    const stamp = Date.now();

    await follow(author, cast.peer);
    await follow(author, cast.pal);

    const root = await postCommit(author, cast.author, `glab root ${stamp}`);
    const self1 = await postReply(author, cast.author, root, `glab self 1 ${stamp}`);
    const self2 = await postReply(author, cast.author, self1, `glab self 2 ${stamp}`);
    const peer1 = await postReply(peer, cast.peer, root, `glab peer 1 ${stamp}`);
    const nested = await postReply(pal, cast.pal, peer1, `glab nested ${stamp}`);
    const offContinuation = await postReply(peer, cast.peer, self1, `glab off continuation ${stamp}`);
    const extra = [];
    for (let i = 1; i <= 4; i++) extra.push(await postReply(pal, cast.pal, root, `glab pal ${i} ${stamp}`));
    await postCommit(peer, cast.peer, `glab peer root ${stamp}`);

    await Promise.all([author.close(), peer.close(), pal.close()]);

    const fixture = { root, self1, self2, peer1, nested, offContinuation, extra, stamp };
    writeFileSync(file, JSON.stringify(fixture, null, 2));
    return fixture;
}
