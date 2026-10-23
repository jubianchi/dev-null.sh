import { PNG } from 'pngjs';

const parse = (rgb) => rgb?.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? null;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mix = (a, b, t) => a.map((value, index) => value + (b[index] - value) * t);

/**
 * How a region of a screenshot looks, as an eye would compare it: how much of it is painted over its background (the
 * colour most of it has), in which colour, and, for a line running down, how long its dashes are. Where the dashes
 * start doesn't count: a line split in pieces can't match the phase of one drawn in a single path.
 */
function inkOf(png, region, scale, nodes) {
    const onNode = (px, py) => nodes.some((node) => Math.hypot(px / scale - node.x, py / scale - node.y) <= node.r);
    const left = Math.max(0, Math.floor(region.left * scale));
    const right = Math.min(png.width, Math.ceil(region.right * scale));
    const top = Math.max(0, Math.floor(region.top * scale));
    const bottom = Math.min(png.height, 16384, Math.ceil(region.bottom * scale));
    const at = (px, py) => {
        const index = (py * png.width + px) * 4;
        return [png.data[index], png.data[index + 1], png.data[index + 2]];
    };
    const counts = new Map();
    for (let py = top; py < bottom; py++) {
        for (let px = left; px < right; px++) {
            const key = at(px, py).join(',');
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    const background = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0].split(',').map(Number) ?? [0, 0, 0];
    const painted = (px, py) => !onNode(px, py) && distance(at(px, py), background) > 60;

    let ink = 0;
    const colour = [0, 0, 0];
    const columns = new Map();
    const rows = new Map();
    for (let py = top; py < bottom; py++) {
        for (let px = left; px < right; px++) {
            if (!painted(px, py)) continue;
            ink++;
            at(px, py).forEach((value, channel) => (colour[channel] += value));
            columns.set(px, (columns.get(px) ?? 0) + 1);
            rows.set(py, (rows.get(py) ?? 0) + 1);
        }
    }
    const perRow = [...rows.values()].sort((x, y) => x - y);

    // Dashes down the most painted column, leaving out the runs cut by the region's edges.
    let dash = null;
    if (bottom - top > 3 * (right - left)) {
        const column = [...columns].sort((x, y) => y[1] - x[1])[0]?.[0];
        const runs = [];
        let run = 0;
        for (let py = top; column !== undefined && py < bottom; py++) {
            if (painted(column, py)) run++;
            else {
                if (run > 0 && py - run > top) runs.push(run);
                run = 0;
            }
        }
        runs.sort((x, y) => x - y);
        if (runs.length >= 3) dash = runs[Math.floor(runs.length / 2)] / scale;
    }

    return {
        ink: ink / (scale * scale),
        // How thick the line is where it's painted, whatever its dashes' phase: the ink of its median painted row. An
        // elbow's few horizontal rows hold most of its ink, so its ink over all its rows would swing with how many
        // dashes its vertical stretch holds.
        width: perRow.length ? perRow[Math.floor(perRow.length / 2)] / scale : null,
        colour: ink ? colour.map((value) => value / ink) : null,
        dash,
    };
}

/**
 * Compares two screenshots of the same layout within regions (CSS pixels, page coordinates) as an eye would: a region
 * painted with a third more or less ink, with a thicker or thinner line, in another colour, or with dashes of another
 * length is reported. The nodes
 * (circles in the same coordinates) are left out: both sides draw them alike, and their rings would drown a line's ink.
 */
export function compareRegions(before, after, regions, scale, nodes = []) {
    const a = PNG.sync.read(before);
    const b = PNG.sync.read(after);
    const changed = [];
    for (const region of regions) {
        const was = inkOf(a, region, scale, nodes);
        const is = inkOf(b, region, scale, nodes);
        const reasons = [];
        // A short dashed piece holds one dash more or less depending on where its dashes start.
        if (Math.abs(was.ink - is.ink) > Math.max(8, 0.3 * Math.max(was.ink, is.ink))) reasons.push(`ink ${Math.round(was.ink)} → ${Math.round(is.ink)}px`);
        if (was.width !== null && is.width !== null && Math.abs(was.width - is.width) > 0.5) reasons.push(`width ${was.width.toFixed(1)} → ${is.width.toFixed(1)}px`);
        if (was.colour && is.colour && distance(was.colour, is.colour) > 40) reasons.push(`colour ${was.colour.map(Math.round)} → ${is.colour.map(Math.round)}`);
        if (was.dash !== null && is.dash !== null && Math.abs(was.dash - is.dash) > 1) reasons.push(`dashes ${was.dash} → ${is.dash}px`);
        if (reasons.length > 0) changed.push({ ...region, reasons });
    }
    return changed;
}

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
