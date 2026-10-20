import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const escape = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

/** A single HTML page with every check and screenshot of a run. */
export function writeReport(outDir, { base, stamp, results }) {
    const sections = results
        .map((result) => {
            const failed = result.error || result.checks.some((check) => !check.ok);
            const checks = result.checks
                .map(
                    (check) => check.skipped
                        ? `<li class="skip">– ${escape(check.label)} <small>(skipped: ${escape(check.details[0])})</small></li>`
                        : `<li class="${check.ok ? 'ok' : 'ko'}">${check.ok ? '✓' : '✗'} ${escape(check.label)}${
                        check.details.length && !check.ok ? `<ul>${check.details.map((detail) => `<li>${escape(detail)}</li>`).join('')}</ul>` : ''
                    }</li>`,
                )
                .join('');
            const shots = result.shots
                .map((shot) => `<a href="${escape(shot.file)}" target="_blank"><figure><img loading="lazy" src="${escape(shot.file)}"><figcaption>${escape(shot.name)}</figcaption></figure></a>`)
                .join('');
            const films = (result.films ?? [])
                .map((film) => `<a href="${escape(film.file)}" target="_blank"><figure class="film"><img loading="lazy" src="${escape(film.file)}"><figcaption>▶ ${escape(film.name)} <small>${film.frames} frames, ${(film.ms / 1000).toFixed(1)}s</small></figcaption></figure></a>`)
                .join('');
            return `<details ${failed ? 'open' : ''} class="${failed ? 'ko' : 'ok'}">
  <summary><b>${failed ? '✗' : '✓'} ${escape(result.name)}</b> — ${escape(result.title)} <small>${result.seconds}s</small></summary>
  ${result.error ? `<pre class="ko">${escape(result.error)}</pre>` : ''}
  <ul class="checks">${checks}</ul>
  ${films ? `<div class="films">${films}</div>` : ''}
  ${shots ? `<div class="shots">${shots}</div>` : ''}
</details>`;
        })
        .join('\n');

    const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Graph lab ${escape(stamp)}</title>
<style>
  :root { color-scheme: light dark; --ok: #1a7f37; --ko: #cf222e; --line: #d0d7de; --bg: #fff; --fg: #1f2328; }
  @media (prefers-color-scheme: dark) { :root { --ok: #3fb950; --ko: #f85149; --line: #30363d; --bg: #0d1117; --fg: #e6edf3; } }
  body { margin: 0 auto; max-width: 1100px; padding: 24px 16px; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  details { border: 1px solid var(--line); border-radius: 8px; margin: 12px 0; padding: 8px 14px; }
  details.ko { border-color: var(--ko); }
  summary { cursor: pointer; }
  small { opacity: .6; }
  .ok { color: var(--ok); } .ko { color: var(--ko); } .skip { color: #9a6700; }
  ul.checks { list-style: none; padding-left: 4px; }
  ul.checks ul { color: var(--ko); font-family: ui-monospace, monospace; font-size: 12px; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
  figure { margin: 0; } img { width: 100%; height: 220px; object-fit: cover; object-position: top; border: 1px solid var(--line); border-radius: 4px; }
  .films { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .film img { height: auto; max-height: 520px; object-fit: contain; background: var(--line); }
  figcaption { font-size: 12px; color: var(--fg); opacity: .7; }
  pre { white-space: pre-wrap; font-size: 12px; }
</style>
<h1>Graph lab</h1>
<p>${escape(stamp)} on ${escape(base)}</p>
${sections}
</html>`;

    const file = join(outDir, 'index.html');
    writeFileSync(file, html);
    return file;
}
