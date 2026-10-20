// Crops a screenshot, in device pixels: node tmp/graph-lab/tools/crop.mjs <in.png> <out.png> <x> <y> <width> <height>
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [file, out, ...box] = process.argv.slice(2);
const [x, y, width, height] = box.map(Number);
const source = PNG.sync.read(readFileSync(file));
const crop = new PNG({ width: Math.min(width, source.width - x), height: Math.min(height, source.height - y) });
PNG.bitblt(source, crop, x, y, crop.width, crop.height, 0, 0);
writeFileSync(out, PNG.sync.write(crop));
