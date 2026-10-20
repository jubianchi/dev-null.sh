#!/usr/bin/env node
// Graph lab: checks every rendering and animation rule of the commit graph against the local dev server.
// Usage: node tmp/graph-lab/run.mjs [--only=a,b] [--skip=a,b] [--fast] [--fresh] [--headed] [--hunt=25] [--base=URL] [--list]
//        [--film=webp|gif] [--film-speed=0.25] [--no-film]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ensureFixture, trustCast } from './lib/app.mjs';
import { healHotFile } from './lib/ssr.mjs';
import { createLab } from './lib/lab.mjs';
import { writeReport } from './lib/report.mjs';
import { scenarios } from './scenarios.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
        return [key, value];
    }),
);
const list = (value) => (value ? value.split(',').map((entry) => entry.trim()) : null);
const here = fileURLToPath(new URL('.', import.meta.url));
const base = args.base ?? 'http://localhost:8000';

if (args.list) {
    for (const scenario of scenarios) console.log(`${scenario.name.padEnd(12)} ${scenario.title}${scenario.slow ? ' (slow, skipped by --fast)' : ''}`);
    process.exit(0);
}

const only = list(args.only);
const skip = list(args.skip) ?? [];
const selected = scenarios.filter(
    (scenario) => (!only || only.includes(scenario.name)) && !skip.includes(scenario.name) && !(args.fast && scenario.slow),
);
const unknown = [...(only ?? []), ...skip].filter((name) => !scenarios.some((scenario) => scenario.name === name));
if (unknown.length > 0) {
    console.error(`unknown scenario(s): ${unknown.join(', ')} (see --list)`);
    process.exit(2);
}

const ping = await fetch(base).catch(() => null);
if (!ping?.ok) {
    console.error(`the dev server doesn't answer on ${base}: start it first (php artisan dev)`);
    process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(here, 'runs', stamp);
mkdirSync(outDir, { recursive: true });
const log = (message) => console.log(`\x1b[2m${message}\x1b[0m`);

healHotFile(log);
trustCast(log);
const browser = await chromium.launch({ channel: 'chrome', headless: args.headed !== 'true' });
const fixture = await ensureFixture(browser, base, join(here, 'fixture.json'), { fresh: args.fresh === 'true', log });

const filming = {
    enabled: args['no-film'] !== 'true',
    format: args.film === 'gif' ? 'gif' : 'webp',
    speed: Number(args['film-speed'] ?? 1),
};
if (!['true', 'gif', 'webp', undefined].includes(args.film) || !(filming.speed > 0)) {
    console.error('--film takes gif or webp, --film-speed a positive number (0.25 plays four times slower)');
    process.exit(2);
}

const results = [];
for (const scenario of selected) {
    const startedAt = Date.now();
    console.log(`\n\x1b[1m${scenario.name}\x1b[0m — ${scenario.title}`);
    const lab = createLab({ browser, base, fixture, outDir, scenario: scenario.name, filming });
    let error = null;
    try {
        await scenario.run(lab, { steps: Number(args.hunt ?? 25), log });
    } catch (caught) {
        error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
    }
    await lab.close();
    for (const check of lab.checks) {
        if (check.skipped) {
            console.log(`  \x1b[33m–\x1b[0m ${check.label} \x1b[2m(skipped: ${check.details[0]})\x1b[0m`);
            continue;
        }
        console.log(`  ${check.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${check.label}`);
        if (!check.ok) for (const detail of check.details) console.log(`      \x1b[31m${detail}\x1b[0m`);
    }
    if (error) console.log(`  \x1b[31m✗ crashed: ${error.split('\n')[0]}\x1b[0m`);
    for (const film of lab.films) console.log(`  \x1b[2m▶ ${film.file} (${film.frames} frames, ${(film.ms / 1000).toFixed(1)}s)\x1b[0m`);
    results.push({ ...scenario, run: undefined, checks: lab.checks, shots: lab.shots, films: lab.films, error, seconds: Math.round((Date.now() - startedAt) / 100) / 10 });
}

await browser.close();

const failed = results.filter((result) => result.error || result.checks.some((check) => !check.ok));
const total = results.reduce((sum, result) => sum + result.checks.length, 0);
const failedChecks = results.reduce((sum, result) => sum + result.checks.filter((check) => !check.ok).length, 0);
writeFileSync(join(outDir, 'report.json'), JSON.stringify({ base, stamp, fixture, results }, null, 2));
const report = writeReport(outDir, { base, stamp, results });

console.log(
    `\n${failed.length === 0 ? '\x1b[32m' : '\x1b[31m'}${total - failedChecks}/${total} checks passed, ${results.length - failed.length}/${results.length} scenarios clean\x1b[0m`,
);
console.log(`report: ${relative(process.cwd(), report)}`);
process.exit(failed.length === 0 ? 0 : 1);
