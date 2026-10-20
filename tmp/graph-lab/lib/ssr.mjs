import { execFileSync, spawn } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Laravel only renders on the server outside of Vite's hot mode (this project has no Vite SSR endpoint). For the length
// of the SSR checks, the lab builds the client and SSR bundles, moves public/hot aside so the running dev server serves
// the build and calls the SSR server, then puts everything back.

const root = process.cwd();
const hot = join(root, 'public/hot');
const parked = join(root, 'public/hot.graph-lab');
const bundle = join(root, 'bootstrap/ssr');
const php = process.env.GLAB_PHP ?? '/opt/homebrew/opt/php/bin/php';
const env = {
    ...process.env,
    PATH: `${php.replace(/\/php$/, '')}:${join(root, 'node_modules/.bin')}:${process.env.PATH}`,
    DB_PASSWORD: process.env.DB_PASSWORD ?? 'password',
    NODE_OPTIONS: '--experimental-strip-types',
};

/** Puts public/hot back if an earlier run was killed before it could. */
export function healHotFile(log = () => {}) {
    if (existsSync(parked) && !existsSync(hot)) {
        renameSync(parked, hot);
        log('restored public/hot left aside by an interrupted run');
    }
}

const health = () =>
    fetch('http://127.0.0.1:13714/health')
        .then((response) => response.ok)
        .catch(() => false);

export async function withSsr(log, run) {
    healHotFile(log);
    if (!existsSync(hot)) throw new Error('public/hot is missing: start the Vite dev server (php artisan dev) first');
    if (await health()) throw new Error('an SSR server already runs on port 13714: stop it first (php artisan inertia:stop-ssr)');

    const hadBundle = existsSync(bundle);
    log('building the client and SSR bundles');
    execFileSync('vp', ['build'], { env, stdio: 'pipe' });
    execFileSync('vp', ['build', '--ssr'], { env, stdio: 'pipe' });

    const server = spawn(php, ['artisan', 'inertia:start-ssr'], { env, stdio: 'ignore' });
    const restore = () => {
        if (existsSync(parked)) renameSync(parked, hot);
        try {
            execFileSync(php, ['artisan', 'inertia:stop-ssr'], { env, stdio: 'ignore' });
        } catch {}
        server.kill();
        if (!hadBundle) rmSync(bundle, { recursive: true, force: true });
    };
    const interrupted = () => {
        restore();
        process.exit(130);
    };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);

    try {
        for (let tries = 0; !(await health()); tries++) {
            if (tries > 40) throw new Error('the SSR server did not start');
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        renameSync(hot, parked);
        log('dev server switched to the build with server rendering (public/hot moved aside)');
        return await run();
    } finally {
        restore();
        process.off('SIGINT', interrupted);
        process.off('SIGTERM', interrupted);
        log('public/hot restored, SSR server stopped');
    }
}
