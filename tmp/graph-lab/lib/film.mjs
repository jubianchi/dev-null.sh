import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Films a page with Chrome's screencast, which hands over every painted frame with its timestamp, so the animation
 * plays back at its real pace. Returns a function that stops filming and encodes the film.
 */
export async function startFilm(page) {
    const cdp = await page.context().newCDPSession(page);
    const viewport = page.viewportSize();
    const frames = [];
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        frames.push({ data, at: metadata.timestamp });
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    // Headless Chrome hands frames over at CSS size, whatever the device scale: films are 1x.
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });

    return async function stop({ dir, name, crop = null, speed = 1, format = 'webp' }) {
        const stoppedAt = Date.now() / 1000;
        await cdp.send('Page.stopScreencast').catch(() => {});
        await cdp.detach().catch(() => {});
        if (frames.length < 2) return null;

        const work = join(dir, `.film-${name}`);
        mkdirSync(work, { recursive: true });
        frames.forEach((frame, index) => writeFileSync(join(work, `${String(index).padStart(4, '0')}.jpg`), Buffer.from(frame.data, 'base64')));

        // Each frame lasts until the next one was painted; the last one until filming stopped.
        const durations = frames.map((frame, index) => {
            const next = frames[index + 1]?.at ?? Math.min(stoppedAt, frame.at + 0.5);
            return Math.max(20, Math.round(((next - frame.at) * 1000) / speed));
        });

        const filter = crop
            ? `crop=iw*${crop.width / viewport.width}:ih*${crop.height / viewport.height}:iw*${crop.x / viewport.width}:ih*${crop.y / viewport.height},`
            : '';
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(work, '%04d.jpg'), '-vf', `${filter}scale=trunc(iw/2)*2:-2`, join(work, '%04d.png')]);

        const file = `${name}.${format}`;
        if (format === 'gif') {
            const list = frames.map((_, index) => `file '${String(index + 1).padStart(4, '0')}.png'\nduration ${durations[index] / 1000}`).join('\n');
            writeFileSync(join(work, 'frames.txt'), `${list}\nfile '${String(frames.length).padStart(4, '0')}.png'\n`);
            execFileSync('ffmpeg', [
                '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'),
                '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
                '-loop', '0', join(dir, file),
            ]);
        } else {
            const args = ['-loop', '0', '-lossy', '-q', '82', '-m', '4'];
            frames.forEach((_, index) => args.push('-d', String(durations[index]), join(work, `${String(index + 1).padStart(4, '0')}.png`)));
            execFileSync('img2webp', [...args, '-o', join(dir, file)]);
        }
        // GLAB_KEEP_FRAMES=1 keeps each film's frames, to step through one.
        if (!process.env.GLAB_KEEP_FRAMES) rmSync(work, { recursive: true, force: true });
        return { file, frames: frames.length, ms: durations.reduce((sum, duration) => sum + duration, 0) };
    };
}
