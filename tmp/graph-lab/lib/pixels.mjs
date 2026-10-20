import { PNG } from 'pngjs';

const parse = (rgb) => rgb?.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? null;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mix = (a, b, t) => a.map((value, index) => value + (b[index] - value) * t);

/**
 * Reads each line's pixels on a full-page screenshot: a line counts as painted where the pixel matches its lane blended
 * at its opacity over the background beside it. Dashes leave gaps, so a dashed line only needs a third of its samples.
 * Samples where the lane is too close to the background to tell are left out.
 */
export function checkPaint(buffer, lines, scale) {
    const png = PNG.sync.read(buffer);
    // Chrome can't capture past 16,384 device pixels down a page: beyond, it repeats the top of the page instead.
    const capturedHeight = Math.min(png.height, 16384);
    const pixel = (x, y) => {
        const px = Math.round(x * scale);
        const py = Math.round(y * scale);
        if (px < 0 || py < 0 || px >= png.width || py >= capturedHeight) return null;
        const index = (py * png.width + px) * 4;
        return [png.data[index], png.data[index + 1], png.data[index + 2]];
    };

    const issues = [];
    let checked = 0;
    for (const line of lines) {
        const from = parse(line.from);
        const to = parse(line.to) ?? from;
        if (!from) continue;
        let telling = 0;
        let painted = 0;
        for (const sample of line.samples) {
            const seen = pixel(sample.x, sample.y);
            const background = pixel(sample.bx, sample.by);
            if (!seen || !background) continue;
            const lane = mix(from, to, sample.mix);
            const expected = mix(background, lane, line.opacity);
            if (distance(expected, background) < 40) continue;
            telling++;
            if (distance(seen, expected) < 70) painted++;
        }
        if (telling < 3) continue;
        checked++;
        const share = painted / telling;
        const needed = line.dashed ? 0.3 : 0.8;
        if (share < needed) issues.push(`line ${line.d} is painted on ${Math.round(share * 100)}% of its length (needs ${needed * 100}%): hidden or not drawn`);
    }
    return { issues, checked };
}
