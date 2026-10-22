# Graph lab

A Playwright lab for the commit graph: it checks how the graph renders and animates against the local dev server.
It was built alongside nunomaduro/dev-null.sh#783 and isn't part of the project: it lives in `tmp/` (git-ignored) and
this branch only exists on the fork.

## Running it

```sh
php artisan dev                         # the dev server must be running
node tmp/graph-lab/run.mjs              # everything (~4 min, including up to 35 s waiting for "arrival")
node tmp/graph-lab/run.mjs --fast       # everything but the slow scenarios
node tmp/graph-lab/run.mjs --only=post,swap
node tmp/graph-lab/run.mjs --skip=static --hunt=60
node tmp/graph-lab/run.mjs --list       # the available scenarios
node tmp/graph-lab/perf.mjs             # rendering performance, before and after (see below)
```

| Option | Effect |
|---|---|
| `--only=a,b` / `--skip=a,b` | picks scenarios |
| `--fast` | skips the slow scenarios (`arrival`) |
| `--fresh` | rebuilds the fixture thread instead of reusing `fixture.json` |
| `--hunt=N` | steps of the random navigation (25 by default) |
| `--headed` | shows the browser |
| `--film=gif` | records GIFs instead of animated WebP |
| `--film-speed=0.25` | slows the recordings down (0.25 plays four times slower) |
| `--no-film` | records nothing |
| `--base=URL` | another server than `http://localhost:8000` |

The exit code is 0 when everything passes, 1 otherwise. The HTML report (checks, screenshots, recordings) is written to
`tmp/graph-lab/runs/<date>/index.html`, with `report.json` next to it.

If PHP can't reach the Docker PostgreSQL with "Cannot find KDC for realm", a Kerberos ticket makes libpq try GSSAPI:
run the dev server and the lab with `PGGSSENCMODE=disable`.

## What it checks

On every page, and after every action (`audit`):

- every cut-out of the node mask sits on a node (within 1.5 px, with a radius at least as large as the ring);
- every card node, reply avatar, deleted reply's tombstone and "more replies" dot has its cut-out;
- every line starts and ends on a node, or starts on another line (a branch): no gap;
- lines are 2 px wide, dashed ones use `4 4`, solid ones have no dashes;
- fades and masks a line refers to exist, opacity is 1 or 0.6;
- no line runs through a node, no line doubles another (but along a branch's 12 px junction);
- each line wears the lane of the rail node at either end;
- no old rail piece shows once the canvas draws, and the canvas is the size of its container;
- no line keeps its draw mask once it has drawn;
- **pixels**: on the screenshot, each line is actually painted (its lane, blended at its opacity over the background
  beside it) along at least 80% of its length, 30% for a dashed line. Points under a fixed or sticky bar, near a node or
  a junction, past Chrome's 16,384 px capture height, or where the lane blends into the background are left out. This
  is what catches a graph hidden under a card, or a mask that doesn't render.

During every scenario: **no console error or warning**, including errors the browser reports on the window without
logging them (like "ResizeObserver loop completed with undelivered notifications"), which the probe relays. Known
messages that don't come from the graph are listed in `knownConsole` (`lib/lab.mjs`), each with its reason.

Frame by frame during animations (`checkFrames`):

- lines stay on their nodes, with the right lanes, in every painted frame;
- no line slides (a transition on `d`);
- no line already there draws itself in again;
- no line draws itself in off screen;
- no line draws itself in while a node at its end scales in;
- when posting: the avatar scales in, then the line draws, then the end dot pops, with no pause between line and dot.

## Scenarios

| Name | What it does |
|---|---|
| `static` | audits 9 pages (feeds, profile, profile replies, threads, notifications) on desktop, mobile and dark |
| `ssr` | server rendering: the HTML holds the rail and an empty canvas, the page without JavaScript shows the rail, the first client frame shows the rail, no frame shows neither or both, then the canvas takes over |
| `reduced` | reduced motion: nothing animates, every line, avatar and dot shows in its final state right away |
| `expand` | opens collapsed replies |
| `more` | loads more replies |
| `post` | posts to the feed and checks the order of the animations |
| `reorder` | posts to *Trending*, which reorders the cards |
| `scroll` | scrolls until more cards load: their lines show drawn, nothing draws off screen, no mask stays |
| `quote` | a commit and a quote of it in the same feed: the quote is listed under the quoted card and shows as a card of its own, each with its own node |
| `deleted` | builds a thread with deleted commits at every depth (a deleted continuation, two deleted replies in a row, a deleted reply above the deepest indent, a deleted leaf that goes, a deleted root) and audits its pages on desktop and mobile: the thread (5 tombstones, the leaf gone), the feed card listing it, threads under deleted ancestors, and replies under a deleted parent or root. A deleted commit has no page of its own (404) |
| `swap` | swaps two cards of the same height in the DOM: only a `MutationObserver` can follow |
| `arrival` | a peer posts, the "new commits" button shows up (30 s poll), click it |
| `thread-open` | opens a thread right after creating it: nothing pops again |
| `chain` | replies to oneself on the thread page |
| `hover` | hovers an author: lines dim exactly with their nodes, and no node registers again |
| `resize` | resizes the window continuously |
| `navigate` | chains navigations (avatar to profile, permalink to thread, tab, notifications, back and forward): every page is clean and nothing is logged |
| `hunt` | random navigation with an audit at every step |

## Recordings

Every frame-by-frame recording (`lab.record`) is also filmed through Chrome's screencast, which hands over every
painted frame with its timestamp: the recording plays the animation back at its real pace (or slower with
`--film-speed`). It is cropped to the graph's column on screen (but `resize`, in full frame) and encoded as animated
WebP with `img2webp`, or as GIF with `ffmpeg`. Recordings sit in the run's folder and at the top of each scenario in the
report.

Headless Chrome hands screencast frames over at CSS size: recordings are 1x, screenshots 2x. `GLAB_KEEP_FRAMES=1` keeps
each recording's frames in `runs/<date>/.film-<name>/` to step through them.

## Server rendering

Laravel only renders on the server outside of Vite's hot mode, since the project has no SSR endpoint in Vite. For the
length of the `ssr` scenario, the lab:

1. builds the client and the SSR bundle (`vp build`, `vp build --ssr`, ~10 s);
2. starts `php artisan inertia:start-ssr`;
3. moves `public/hot` aside (`public/hot.graph-lab`), so the dev server serves the build and calls the SSR server;
4. puts everything back at the end, even on an error or Ctrl+C: `public/hot` restored, SSR server stopped,
   `bootstrap/ssr` removed if it didn't exist.

Meanwhile (~40 s), a tab open on the dev server that reloads gets the build instead of Vite. If a run is killed outright,
the next one puts `public/hot` back by itself; by hand: `mv public/hot.graph-lab public/hot`.

The app mounts React with `createRoot` (`resources/js/app.tsx`), not `hydrateRoot`: the client throws the server's HTML
away and renders again. There is no hydration to check, and the lab says so ("skipped"); it will check for hydration
mismatches in the console once the app moves to `hydrateRoot`.

## Rendering performance

`perf.mjs` builds two refs for production in throwaway worktrees (`.claude/worktrees/graph-lab-perf-<sha>`), serves them
side by side on ports 8101 and 8102 against the same database, and measures the same pages and interactions on each:
loading the feed and a thread, scrolling the feed, hovering authors, opening replies, resizing. It slows the CPU down 4x,
runs each side once to warm up, then 5 runs alternating between the two, and reports medians of Chrome's performance
metrics (main thread, script, layout and style time, layout counts, long tasks, LCP, frame times).

```sh
node tmp/graph-lab/perf.mjs                                  # merge base of HEAD and upstream/production vs HEAD
node tmp/graph-lab/perf.mjs --before=<ref> --after=<ref> --runs=5 --throttle=4 --keep --reduced-motion
```

Results go to `tmp/graph-lab/perf/<date>/` (`report.md`, `results.json`). `--keep` keeps the worktrees and their builds
for the next run. Run nothing else on the machine meanwhile: background work skews the numbers by tens of percent.
An old ref may not start on a database migrated past it (`before did not start`).

## Accounts and data

The lab plays local `glab-*` accounts (`glab-author`, `glab-peer`, `glab-pal`, and one or two accounts per scenario that posts),
created on first sign-in. New accounts post into the moderation queue: `lib/reputation.php` gives them, through
`artisan tinker`, the reputation that skips it (a day old, 10 `glab-fan-*` followers, an approved commit). All of this
only touches the dev database.

The fixture thread (`fixture.json`, kept out of git) holds a root commit, two chained self-replies, replies from peers
branching off it, a nested reply, a reply off the continuation and enough replies for a "more replies" button. It is
reused while it exists; `--fresh` rebuilds it.

Each account may post 10 commits a minute: running the posting scenarios several times in a row can hit that limit. The
error says so; wait a minute.

Posting twice in a row as the same account can fail with a 500: `CreateCommit` dispatches the unique `CheckUserLevel`
job inside its transaction, and with the database cache store on PostgreSQL, taking a lock that is already held aborts
the transaction. The lab spaces its posts and sends a failed one again. A missing migration in the dev database ends the
same way (`php artisan migrate`).

Useful variables: `GLAB_PHP` (PHP 8.5, `/opt/homebrew/opt/php/bin/php` by default), `DB_PASSWORD` (`password` by default)
and `PGGSSENCMODE`.

## Files

| File | Role |
|---|---|
| `run.mjs` | runner, options, summary and exit code |
| `scenarios.mjs` | the scenarios; adding one is an object `{ name, title, run(lab) }` |
| `perf.mjs` | rendering performance, before and after |
| `lib/probe.mjs` | probe injected in the page: `audit()`, `dimming()`, `paintSamples()`, frame-by-frame recording, hand-over recording |
| `lib/lab.mjs` | what scenarios act with: `open`, `audit`, `record`, `check`, `skip`, `shot`, `expandReplies`, frame checks |
| `lib/app.mjs` | sign-in, posting over HTTP, accounts, fixture thread |
| `lib/report.mjs` | HTML report |
| `lib/pixels.mjs` | reads each line's pixels on screenshots |
| `lib/film.mjs` | recordings (screencast, crop, WebP or GIF) |
| `lib/ssr.mjs` | switches the dev server to server rendering for the `ssr` scenario |
| `lib/reputation.php` | reputation of the lab's accounts |
| `tools/crop.mjs` | crops a screenshot to look closer: `node tmp/graph-lab/tools/crop.mjs in.png out.png x y w h` |
| `tools/trace-scroll.mjs` | traces a feed scroll on two production builds and tells what invalidates layout |
| `tools/ro-loop.mjs` | replays actions on a feed and tells which one raises the `ResizeObserver` loop error |
| `tools/handoff-shift.mjs` | tells, page by page, whether the canvas taking over moves the cards |
| `tools/mutation-count.mjs` | counts the DOM mutations the canvas reacts to while replies open |

## Checked against real bugs

Each bug fixed during the rework, put back by hand, fails the lab:

| Bug put back | Caught by |
|---|---|
| CSS transition on `d` (lines slide) | `static`, `post` |
| no `MutationObserver` (lines left behind) | `swap` |
| fresh nodes popping again when a thread opens | `thread-open` |
| a line drawing while its avatar scales in | `post` |
| canvas under the cards (geometry right, nothing visible) | `expand` and `static` (pixels) |
| canvas drawing from the start (no rail in the server's HTML) | `ssr` |
| draw-in animation despite reduced motion | `reduced` |
| a console warning | every scenario (console check) |
| measuring synchronously on a resize observer's first report (loop error when navigating) | `navigate` |
| the same commit registered twice, as a card and as a quote under another card | `quote` |
