// Runs inside the page (installed with addInitScript), so it must stay self-contained.
export function installProbe() {
    if (window.__glab) {
        return;
    }

    // Errors the browser reports on the window without logging them, like "ResizeObserver loop completed with
    // undelivered notifications", relayed to the console so the lab's console check sees them.
    window.addEventListener('error', (event) => {
        if (!event.error) console.error(`[window error] ${event.message}`);
    });

    // How often elements start or stop being observed for resizes: a node registering again shows up here.
    window.__glabObserved = { observe: 0, unobserve: 0 };
    const { observe, unobserve } = ResizeObserver.prototype;
    ResizeObserver.prototype.observe = function (...args) {
        window.__glabObserved.observe++;
        return observe.apply(this, args);
    };
    ResizeObserver.prototype.unobserve = function (...args) {
        window.__glabObserved.unobserve++;
        return unobserve.apply(this, args);
    };

    const railPieces = [
        '[data-test="rail-tail"]',
        '[data-test="rail-previous"]',
        '[data-test="commit-reply-spine"]',
        '[data-test="thread-spine"]',
        '[data-test="thread-elbow"]',
        '[data-test="reply-link"]',
        '[data-test="reply-tail"]',
    ].join(',');

    // The layout size, so a node scaled down to nothing by its entrance still counts as there.
    const isVisible = (element) => {
        if (element.offsetWidth === 0 && element.offsetHeight === 0) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
    };

    const isRound = (element) => {
        if (element.offsetWidth < 4) return false;
        const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius);
        return radius >= element.offsetWidth / 2 - 0.5;
    };

    const describe = (element) => {
        const article = element.closest('[data-test="commit"], [data-test="reply"], [data-test="notification"], li, article');
        const label = article?.querySelector('p, [data-test="commit-body"]')?.textContent?.trim().slice(0, 40) ?? '';
        const kind = element.closest('[data-test="rail-end-dot"]')
            ? 'end dot'
            : element.closest('[data-test="more-replies-button"]')
              ? 'more dot'
              : element.closest('[data-test="reply"]')
                ? 'reply avatar'
                : element.offsetWidth <= 16
                  ? 'dot'
                  : 'avatar';
        return `${kind}${label ? ` «${label}»` : ''}`;
    };

    const nodeInAnimation = (element, container) => {
        for (let current = element; current && current !== container; current = current.parentElement) {
            for (const animation of current.getAnimations()) {
                if (animation.animationName === 'node-in' && animation.playState === 'running') {
                    const delay = Number(animation.effect?.getTiming().delay ?? 0);
                    return { element: current, isWaiting: Number(animation.currentTime) < delay };
                }
            }
        }
        return null;
    };

    // The elements the canvas should treat as nodes: card rail nodes, end dots, reply avatars, "more replies" dots.
    // Other rail nodes, like the hollow dot ending a feed, only count when a line reaches them.
    const expectedNodes = (container, { strictOnly = false } = {}) => {
        const found = new Set();
        const loose = new Set();
        for (const anchor of container.querySelectorAll('[class*="group/rail-node"]')) {
            if (anchor.closest('[role="status"]')) continue;
            // A card measures its node's link, which a grouped dot shifts up inside the anchor.
            const link = anchor.querySelector('a[class*="rounded-full"]');
            const target = link && isVisible(link) ? link : isRound(anchor) && isVisible(anchor) ? anchor : null;
            if (!target) continue;
            (anchor.closest('[data-test="commit"]') ? found : loose).add(target);
        }
        for (const reply of container.querySelectorAll('[data-test="reply"]')) {
            const avatar = reply.querySelector('a.rounded-full, a[class*="rounded-full"]');
            if (avatar && isVisible(avatar)) found.add(avatar);
        }
        for (const tombstone of container.querySelectorAll('[data-test="reply-tombstone"]')) {
            const node = tombstone.querySelector(':scope > div span[class*="border-dashed"]');
            if (node && isVisible(node)) found.add(node);
        }
        for (const button of container.querySelectorAll('[data-test="more-replies-button"]')) {
            const dot = [...button.querySelectorAll('[aria-hidden] *')].find((element) => isRound(element) && isVisible(element));
            if (dot) found.add(dot);
        }
        const strict = [...found].map((element) => ({ element, isStrict: true }));
        return strictOnly ? strict : [...strict, ...[...loose].filter((element) => !found.has(element)).map((element) => ({ element, isStrict: false }))];
    };

    const lineTouches = (edges, centre, radius) =>
        edges.some(({ path }) => {
            const length = path.getTotalLength();
            for (let at = 0; at <= length; at += 3) {
                const point = path.getPointAtLength(at);
                if (Math.hypot(point.x - centre.x, point.y - centre.y) < radius + 2) return true;
            }
            return false;
        });

    const candidates = (container, svg) =>
        [...container.querySelectorAll('[class*="rounded-full"], img')].filter(
            (element) => !svg.contains(element) && isRound(element) && isVisible(element),
        );

    const centreOf = (element, box) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2 };
    };

    // Colours compared as the browser resolves them, so var(--lane-3) and its oklch value match.
    const swatch = document.createElement('span');
    const rgbCache = new Map();
    const toRgb = (value) => {
        if (!value) return null;
        if (!swatch.isConnected) {
            swatch.style.display = 'none';
            document.documentElement.append(swatch);
        }
        if (!rgbCache.has(value)) {
            swatch.style.color = '';
            swatch.style.color = value;
            rgbCache.set(value, getComputedStyle(swatch).color);
        }
        return rgbCache.get(value);
    };
    // Only rail nodes carry their lane in --lane; a reply avatar's lane isn't in the page.
    const laneOf = (element) => {
        if (!element.closest('[class*="group/rail-node"]')) return null;
        const host = element.closest('[style*="--lane"]');
        return host ? toRgb(getComputedStyle(host).getPropertyValue('--lane').trim()) : null;
    };

    // A line keeps the lane of the node it leaves to its end, as the rail did: no fade into the next author's lane.
    const laneMismatches = (edges, nodes) =>
        edges.flatMap(({ path, d }) => {
            const start = path.getPointAtLength(0);
            const node = nodes.find(({ centre }) => Math.hypot(centre.x - start.x, centre.y - start.y) < 1.5);
            const lane = node && laneOf(node.element);
            const colour = path.style.stroke.startsWith('url(') ? null : getComputedStyle(path).stroke;
            return lane && colour && lane !== colour ? [`line ${d} is ${colour} but the node it leaves is ${lane}`] : [];
        });

    // Names a line by the node elements at its two ends, so a line keeps its name when it moves.
    let nextNodeId = 1;
    const nodeKey = (element) => {
        if (!element.dataset.glabNode) element.dataset.glabNode = String(nextNodeId++);
        return element.dataset.glabNode;
    };
    const edgeKey = (path, nodes) => {
        const length = path.getTotalLength();
        return [path.getPointAtLength(0), path.getPointAtLength(length)]
            .map((end) => {
                const node = nodes.find(({ centre }) => Math.hypot(centre.x - end.x, centre.y - end.y) < 1.5);
                return node ? nodeKey(node.element) : 'line';
            })
            .join('->');
    };
    const nodesWithCentres = (container, box) => expectedNodes(container).map(({ element }) => ({ element, centre: centreOf(element, box) }));

    // Points along a stretch of a line (fractions of its length), every 2px, in the canvas's coordinates.
    const pointsAlong = (path, from = 0, to = 1) => {
        const length = path.getTotalLength();
        const points = [];
        for (let at = from * length; at <= to * length; at += 2) {
            const { x, y } = path.getPointAtLength(at);
            points.push({ x, y });
        }
        return points;
    };

    // What each node's lines painted before an action, by the node they leave and where it stood.
    const paintedLines = (edges, nodes) => {
        const painted = new Map();
        for (const { path } of edges) {
            const start = path.getPointAtLength(0);
            const node = nodes.find(({ centre }) => Math.hypot(centre.x - start.x, centre.y - start.y) < 1.5);
            if (!node) continue;
            const key = nodeKey(node.element);
            painted.set(key, [...(painted.get(key) ?? []), { start, points: pointsAlong(path) }]);
        }
        return painted;
    };

    // How many px of a line drawing itself in are hidden where a line from the same node, which hasn't moved, was painted.
    const repaintedLength = (path, hidden, nodes, painted) => {
        const start = path.getPointAtLength(0);
        const node = nodes.find(({ centre }) => Math.hypot(centre.x - start.x, centre.y - start.y) < 1.5);
        const before = node ? (painted.get(nodeKey(node.element)) ?? []).filter((line) => Math.hypot(line.start.x - start.x, line.start.y - start.y) < 1) : [];
        if (before.length === 0) return 0;
        const covered = pointsAlong(path, 1 - hidden, 1).filter((point) =>
            before.some((line) => line.points.some((old) => Math.hypot(old.x - point.x, old.y - point.y) < 1)),
        );
        return covered.length * 2;
    };

    function readCanvas(svg) {
        const container = svg.parentElement;
        const box = container.getBoundingClientRect();
        const circles = [...svg.querySelectorAll('mask[id$="-nodes"] circle')].map((circle) => ({
            x: Number(circle.getAttribute('cx')),
            y: Number(circle.getAttribute('cy')),
            r: Number(circle.getAttribute('r')),
        }));
        const edges = [...svg.querySelectorAll(':scope > g path')].map((path) => ({ path, d: path.getAttribute('d') }));
        return { container, box, circles, edges };
    }

    // Whether a point sits on a line, gaps between its dashes included: a branch may leave a dashed trunk between two dashes.
    const inStroke = (path, point) => {
        const dashes = path.style.strokeDasharray;
        path.style.strokeDasharray = 'none';
        const isIn = path.isPointInStroke(point);
        path.style.strokeDasharray = dashes;
        return isIn;
    };

    // A canvas has drawn once it has measured nodes: until then it cuts no ring out of its mask.
    const hasDrawn = (svg) => svg.querySelector('mask[id$="-nodes"] circle') !== null;

    function matchCircles(container, svg, box, circles) {
        const pool = candidates(container, svg).map((element) => ({ element, centre: centreOf(element, box), half: element.offsetWidth / 2 }));
        return circles.map((circle) => {
            const match = pool.find(
                ({ centre, half }) =>
                    Math.hypot(centre.x - circle.x, centre.y - circle.y) < 1.5 && circle.r >= half - 0.5 && circle.r <= half + 4.5,
            );
            return { circle, element: match?.element ?? null };
        });
    }

    function audit({ requireDrawn = true } = {}) {
        const issues = [];
        const canvases = [...document.querySelectorAll('[data-test="graph-canvas"]')];
        const stats = { canvases: canvases.length, nodes: 0, edges: 0, dashed: 0, faded: 0, dimmedEdges: 0 };

        for (const svg of canvases) {
            const { container, box, circles, edges } = readCanvas(svg);
            const isDrawn = hasDrawn(svg);
            stats.nodes += circles.length;
            stats.edges += edges.length;

            if (!isDrawn) {
                if (requireDrawn && container.querySelector('[data-test="commit"]')) issues.push('canvas never measured: no lines drawn');
                continue;
            }

            const size = svg.getBoundingClientRect();
            if (Math.abs(size.left - box.left) > 1 || Math.abs(size.top - box.top) > 1 || Math.abs(size.width - box.width) > 1 || Math.abs(size.height - box.height) > 1) {
                issues.push(`canvas ${Math.round(size.width)}x${Math.round(size.height)} at ${Math.round(size.left - box.left)},${Math.round(size.top - box.top)} ≠ container ${Math.round(box.width)}x${Math.round(box.height)}`);
            }

            const leftovers = [...container.querySelectorAll(railPieces)].filter(isVisible);
            if (leftovers.length > 0) issues.push(`${leftovers.length} old rail piece(s) still shown (${[...new Set(leftovers.map((element) => element.dataset.test))].join(', ')})`);

            const matched = matchCircles(container, svg, box, circles);
            for (const { circle, element } of matched) {
                if (!element) issues.push(`cut-out at ${Math.round(circle.x)},${Math.round(circle.y)} (r${circle.r}) matches no node: stale position or radius`);
            }

            for (const { element: node, isStrict } of expectedNodes(container)) {
                const centre = centreOf(node, box);
                const half = node.offsetWidth / 2;
                const circle = circles.find((c) => Math.hypot(c.x - centre.x, c.y - centre.y) < 1.5);
                if (!circle) {
                    if (nodeInAnimation(node, container)) continue;
                    if (isStrict || lineTouches(edges, centre, half)) issues.push(`${describe(node)} at ${Math.round(centre.x)},${Math.round(centre.y)} has no cut-out: lines would cross it`);
                } else if (circle.r < half - 0.5) {
                    issues.push(`${describe(node)} cut-out r${circle.r} smaller than its ring (${half}): lines overlap it`);
                }
            }

            issues.push(...laneMismatches(edges, nodesWithCentres(container, box)));

            const sampled = edges.map(({ path, d }) => {
                const length = path.getTotalLength();
                const points = [];
                for (let at = 0; at <= length; at += 3) points.push(path.getPointAtLength(at));
                points.push(path.getPointAtLength(length));
                return { path, d, length, points, start: points[0], end: points.at(-1) };
            });

            for (const edge of sampled) {
                const { path, d } = edge;
                const style = getComputedStyle(path);

                if (path.getAttribute('stroke-width') !== '2') issues.push(`line ${d} is ${path.getAttribute('stroke-width')}px wide, not 2px`);

                const isDashed = path.dataset.test === 'graph-edge-dashed';
                if (isDashed) stats.dashed++;
                const dasharray = path.getAttribute('stroke-dasharray');
                if (isDashed && dasharray !== '4 4') issues.push(`dashed line ${d} has dashes "${dasharray}", not "4 4"`);
                if (!isDashed && dasharray) issues.push(`solid line ${d} has dashes "${dasharray}"`);

                if (path.style.stroke.startsWith('url(')) {
                    stats.faded++;
                    issues.push(`line ${d} fades into another lane (${path.style.stroke}): upstream took fades out (9e465e64)`);
                }

                const mask = path.getAttribute('mask');
                const drawMask = mask ? document.getElementById(mask.slice(5, -1).replace(/^#/, '')) : null;
                if (mask && !drawMask) issues.push(`line ${d} draws through a missing mask`);
                // A line done drawing should drop its draw mask, which otherwise costs a mask on every paint.
                const drawPath = drawMask?.querySelector('path');
                const isDone = drawPath?.getAnimations().every((animation) => animation.playState === 'finished');
                if (drawPath && isDone && parseFloat(getComputedStyle(drawPath).strokeDashoffset) < 0.01) {
                    issues.push(`line ${d} keeps its draw mask after drawing`);
                }

                const opacity = Number(path.getAttribute('opacity') ?? 1);
                if (opacity !== 1 && opacity !== 0.6) issues.push(`line ${d} has opacity ${opacity}`);
                if (opacity === 0.6) stats.dimmedEdges++;

                if (style.transitionProperty.split(',').some((property) => property.trim() === 'd')) issues.push(`line ${d} transitions its shape`);

                const endCircle = circles.find((c) => Math.hypot(c.x - edge.end.x, c.y - edge.end.y) < 1.5);
                if (!endCircle) issues.push(`line ${d} ends at ${Math.round(edge.end.x)},${Math.round(edge.end.y)}, on no node: gap`);

                const startCircle = circles.find((c) => Math.hypot(c.x - edge.start.x, c.y - edge.start.y) < 1.5);
                const startsOnTrunk = sampled.some((other) => other !== edge && inStroke(other.path, new DOMPoint(edge.start.x, edge.start.y)));
                if (!startCircle && !startsOnTrunk) issues.push(`line ${d} starts at ${Math.round(edge.start.x)},${Math.round(edge.start.y)}, on no node or line: gap`);

                const crossed = circles.filter(
                    (c) => c !== endCircle && c !== startCircle && edge.points.some((point) => Math.hypot(point.x - c.x, point.y - c.y) < c.r - 1),
                );
                for (const c of crossed) issues.push(`line ${d} runs through the node at ${Math.round(c.x)},${Math.round(c.y)}`);
            }

            // A branch leaving a trunk shares it along its corner (12px): that junction is drawn on purpose.
            const cornerRadius = 12;
            for (let i = 0; i < sampled.length; i++) {
                for (let j = i + 1; j < sampled.length; j++) {
                    const a = sampled[i];
                    const b = sampled[j];
                    const junctions = [
                        b.path.isPointInStroke(new DOMPoint(a.start.x, a.start.y)) && a.start,
                        a.path.isPointInStroke(new DOMPoint(b.start.x, b.start.y)) && b.start,
                    ].filter(Boolean);
                    const shared = a.points.filter(
                        (point) =>
                            !junctions.some((junction) => Math.hypot(point.x - junction.x, point.y - junction.y) <= cornerRadius + 3) &&
                            !circles.some((c) => Math.hypot(point.x - c.x, point.y - c.y) < c.r + 3) &&
                            b.path.isPointInStroke(new DOMPoint(point.x, point.y)),
                    ).length;
                    if (shared * 3 > 6) issues.push(`lines ${a.d} and ${b.d} overlap over ~${shared * 3}px`);
                }
            }
        }

        return { issues: [...new Set(issues)], stats };
    }

    // Records what each frame shows, to check animations: alignment, sliding lines, entrance order.
    function startRecording({ watch = null } = {}) {
        const frames = [];
        const baseline = new Set();
        const painted = new Map();
        // Lines that had a node scaling in at one end during the recording.
        const scaledIn = new Set();
        for (const svg of document.querySelectorAll('[data-test="graph-canvas"]')) {
            const { container, box, edges } = readCanvas(svg);
            const nodes = nodesWithCentres(container, box);
            for (const { path } of edges) baseline.add(edgeKey(path, nodes));
            painted.set(svg, paintedLines(edges, nodes));
        }
        const startedAt = performance.now();
        let running = true;

        // Samples right after each paint, so it sees what the frame showed once observers had run.
        const tick = () => {
            if (!running) return;
            setTimeout(sample, 0);
            requestAnimationFrame(tick);
        };
        const sample = () => {
            if (!running) return;
            const frame = { t: Math.round(performance.now() - startedAt), misaligned: [], lineOverScalingNode: 0, sliding: 0, draws: [], redrawn: [], repainted: [], offscreenDraws: 0, nodeIn: 0 };

            for (const svg of document.querySelectorAll('[data-test="graph-canvas"]')) {
                const { container, box, circles, edges } = readCanvas(svg);
                if (!hasDrawn(svg)) continue;
                const nodes = nodesWithCentres(container, box);
                frame.misaligned.push(...laneMismatches(edges, nodes));

                for (const { element: node } of expectedNodes(container, { strictOnly: true })) {
                    const animation = nodeInAnimation(node, container);
                    if (animation) {
                        frame.nodeIn++;
                        continue;
                    }
                    const centre = centreOf(node, box);
                    const circle = circles.find((c) => Math.hypot(c.x - centre.x, c.y - centre.y) < 1.5);
                    if (!circle || circle.r < node.offsetWidth / 2 - 0.5) frame.misaligned.push(describe(node));
                }

                for (const { path, d } of edges) {
                    if (path.getAnimations().some((animation) => animation.transitionProperty === 'd')) frame.sliding++;

                    const mask = path.getAttribute('mask');
                    const drawPath = mask ? document.getElementById(mask.slice(5, -1).replace(/^#/, ''))?.querySelector('path') : null;
                    const hidden = drawPath ? parseFloat(getComputedStyle(drawPath).strokeDashoffset) : 0;
                    if (drawPath) {
                        const key = edgeKey(path, nodes);
                        frame.draws.push({ d, key, hidden: Math.round(hidden * 100) / 100 });
                        if (hidden > 0.01 && baseline.has(key)) frame.redrawn.push(d);
                        // A line taking over from one its node already showed, like the line to a "more replies" dot
                        // once the replies load: the stretch already painted stays. One waiting for a node at its end to
                        // scale in, like a reply just posted, draws in full after it instead.
                        const length = path.getTotalLength();
                        const ends = [path.getPointAtLength(0), path.getPointAtLength(length)];
                        const waitsForNode = expectedNodes(container, { strictOnly: true }).some(({ element: node }) => {
                            const centre = centreOf(node, box);
                            return nodeInAnimation(node, container) && ends.some((end) => Math.hypot(end.x - centre.x, end.y - centre.y) < 12);
                        });
                        if (waitsForNode) scaledIn.add(key);
                        const repainted = hidden > 0.01 && !scaledIn.has(key) ? repaintedLength(path, hidden, nodes, painted.get(svg) ?? new Map()) : 0;
                        if (repainted > 4) frame.repainted.push(`${d} (${repainted}px)`);
                        // Drawing a line nobody can see is wasted work.
                        const rect = path.getBoundingClientRect();
                        if (hidden > 0.01 && hidden < 0.99 && (rect.bottom < 0 || rect.top > window.innerHeight)) frame.offscreenDraws++;
                    }

                    // Still drawing itself in: an end dot popping at a line already drawn is the intended order.
                    if (drawPath && hidden > 0.1 && hidden < 0.99) {
                        const length = path.getTotalLength();
                        const ends = [path.getPointAtLength(0), path.getPointAtLength(length)];
                        for (const { element: node } of expectedNodes(container, { strictOnly: true })) {
                            const animation = nodeInAnimation(node, container);
                            if (!animation || animation.isWaiting) continue;
                            const centre = centreOf(node, box);
                            if (ends.some((end) => Math.hypot(end.x - centre.x, end.y - centre.y) < 12)) frame.lineOverScalingNode++;
                        }
                    }
                }
            }

            // The card whose body holds the watched text, once it shows up.
            const watched = watch ? [...document.querySelectorAll('[data-test="commit"]')].find((card) => card.textContent.includes(watch)) : null;
            if (watched) {
                const scaleOf = (element) => (element ? new DOMMatrix(getComputedStyle(element).transform).a : null);
                const anchors = [...watched.querySelectorAll('[class*="group/rail-node"]')];
                frame.avatar = scaleOf(anchors.find((anchor) => anchor.dataset.test !== 'rail-end-dot'));
                frame.dot = scaleOf(anchors.find((anchor) => anchor.dataset.test === 'rail-end-dot'));
            }

            // The card a scenario marked as being removed: its lines fade and clip with its row, as the rail did.
            const leavingCard = document.querySelector('[data-glab-leaving]');
            if (leavingCard) frame.leaving = leavingOf(leavingCard);

            frames.push(frame);
        };
        requestAnimationFrame(tick);

        window.__glabStop = () => {
            running = false;
            return frames;
        };
    }

    // The rect an element of the canvas is clipped to, through its own clip-path and its groups', in canvas coordinates.
    function clipRectOf(element, svg) {
        let rect = null;
        for (let current = element; current && current !== svg; current = current.parentElement) {
            const id = getComputedStyle(current).clipPath.match(/url\("?#([^")]+)"?\)/)?.[1];
            const shape = id ? document.getElementById(id)?.querySelector('rect') : null;
            if (!shape) continue;
            const { x, y, width, height } = shape.getBBox();
            rect = rect
                ? { top: Math.max(rect.top, y), bottom: Math.min(rect.bottom, y + height), left: Math.max(rect.left, x), right: Math.min(rect.right, x + width) }
                : { top: y, bottom: y + height, left: x, right: x + width };
        }
        return rect;
    }

    const opacityUpTo = (element, stop) => {
        let opacity = 1;
        for (let current = element; current && current !== stop; current = current.parentElement) opacity *= Number(getComputedStyle(current).opacity);
        return opacity;
    };

    // What a removed card's lines show against its row: how far they run past the row's visible part, how much more
    // opaque they are than the row, and how many of its hidden nodes still cut holes in other cards' lines.
    function leavingOf(card) {
        const svg = [...document.querySelectorAll('[data-test="graph-canvas"]')].find((canvas) => canvas.parentElement.contains(card));
        if (!svg || !card.isConnected) return { isGone: true };
        const { container, box, circles, edges } = readCanvas(svg);
        const row = card.getBoundingClientRect();
        const rowTop = row.top - box.top;
        const rowBottom = row.bottom - box.top;
        const rowOpacity = opacityUpTo(card, container);
        const nodes = [...card.querySelectorAll('[class*="group/rail-node"], [data-test="reply"] a[class*="rounded-full"], [data-test="reply-tombstone"] span[class*="border-dashed"]')].map(
            (element) => centreOf(element.querySelector?.('a[class*="rounded-full"]') ?? element, box),
        );
        // Another card's node can pass right over one of the hidden nodes as the row collapses: its lines are its own.
        const elsewhere = expectedNodes(container)
            .map(({ element }) => element)
            .filter((element) => !card.contains(element))
            .map((element) => centreOf(element, box));
        const near = (list, point) => list.some((node) => Math.hypot(node.x - point.x, node.y - point.y) < 1.5);
        const onCard = (point) => near(nodes, point) && !near(elsewhere, point);
        const result = { rowHeight: Math.round(row.height), rowOpacity: Math.round(rowOpacity * 100) / 100, lines: 0, overflow: 0, excess: 0, holes: 0 };
        const others = [];

        for (const { path } of edges) {
            const length = path.getTotalLength();
            if (![path.getPointAtLength(0), path.getPointAtLength(length)].some(onCard)) {
                others.push({ path });
                continue;
            }
            result.lines++;
            const opacity = opacityUpTo(path, svg);
            if (opacity < 0.01) continue;
            result.excess = Math.max(result.excess, Math.round((opacity - rowOpacity) * 100) / 100);
            const bbox = path.getBBox();
            const clip = clipRectOf(path, svg);
            const top = Math.max(bbox.y, clip?.top ?? -Infinity);
            const bottom = Math.min(bbox.y + bbox.height, clip?.bottom ?? Infinity);
            const overflow = bottom > top ? Math.round(Math.max(bottom - rowBottom, rowTop - top)) : 0;
            if (overflow > result.overflow || opacity - rowOpacity > 0.05) result.worst = `${path.getAttribute('d')} (opacity ${Math.round(opacity * 100) / 100}, ${path.getAttribute('clip-path') ? 'clipped' : 'unclipped'}, ${svg.querySelectorAll('clipPath').length} clip(s))`;
            result.overflow = Math.max(result.overflow, overflow);
        }

        for (const node of nodes) {
            if (node.y >= rowTop && node.y <= rowBottom) continue;
            const circle = [...svg.querySelectorAll('mask[id$="-nodes"] circle')].find(
                (shape) => Math.hypot(Number(shape.getAttribute('cx')) - node.x, Number(shape.getAttribute('cy')) - node.y) < 1.5,
            );
            if (!circle) continue;
            const clip = clipRectOf(circle, svg);
            if (clip && (node.y < clip.top - 1 || node.y > clip.bottom + 1)) continue;
            if (lineTouches(others, node, Number(circle.getAttribute('r')))) result.holes++;
        }

        return result;
    }

    // A line is dimmed exactly when one of its card nodes is: checked on lines whose two ends are card nodes.
    function dimming() {
        const mismatches = [];
        let dimmedNodes = 0;
        let checked = 0;
        for (const svg of document.querySelectorAll('[data-test="graph-canvas"]')) {
            const { container, box, edges } = readCanvas(svg);
            const cardNodes = expectedNodes(container, { strictOnly: true })
                .map(({ element }) => element)
                .filter((element) => element.closest('[data-test="commit"]') && !element.closest('[data-test="reply"]'))
                .map((element) => ({ centre: centreOf(element, box), isDimmed: Boolean(element.closest('[data-dimmed]')) }));
            dimmedNodes += cardNodes.filter((node) => node.isDimmed).length;
            for (const { path, d } of edges) {
                const length = path.getTotalLength();
                const ends = [path.getPointAtLength(0), path.getPointAtLength(length)].map((end) =>
                    cardNodes.find((node) => Math.hypot(node.centre.x - end.x, node.centre.y - end.y) < 1.5),
                );
                if (ends.some((end) => !end)) continue;
                checked++;
                const expected = ends.some((end) => end.isDimmed) ? 0.6 : 1;
                const actual = Number(path.getAttribute('opacity') ?? 1);
                if (actual !== expected) mismatches.push(`line ${d} has opacity ${actual}, expected ${expected}`);
            }
        }
        return { mismatches, dimmedNodes, checked };
    }

    // Where to read each line's pixels on a full-page screenshot, with the colour expected there and a background point
    // beside it. Points near nodes and junctions are left out.
    function paintSamples() {
        const lines = [];
        // A full-page screenshot keeps fixed and sticky bars where they sit on screen, over whatever lines run there.
        const overlays = [...document.body.querySelectorAll('*')]
            .filter((element) => ['fixed', 'sticky'].includes(getComputedStyle(element).position) && isVisible(element))
            .map((element) => element.getBoundingClientRect())
            .map((rect) => ({ left: rect.left + window.scrollX - 2, right: rect.right + window.scrollX + 2, top: rect.top + window.scrollY - 2, bottom: rect.bottom + window.scrollY + 2 }));
        const covered = (x, y) => overlays.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
        for (const svg of document.querySelectorAll('[data-test="graph-canvas"]')) {
            const { box, circles, edges } = readCanvas(svg);
            if (!hasDrawn(svg)) continue;
            const page = { x: box.left + window.scrollX, y: box.top + window.scrollY };
            for (const { path, d } of edges) {
                const length = path.getTotalLength();
                const start = path.getPointAtLength(0);
                const startsOnLine = !circles.some((c) => Math.hypot(c.x - start.x, c.y - start.y) < 1.5);
                // One colour end to end: the pixel check's blend from one lane to the next stays at the first.
                const from = getComputedStyle(path).stroke;
                const to = from;
                const opacity = Number(path.getAttribute('opacity') ?? 1);
                const samples = [];
                for (let at = 2; at < length - 2; at += 4) {
                    const point = path.getPointAtLength(at);
                    if (circles.some((c) => Math.hypot(point.x - c.x, point.y - c.y) < c.r + 3)) continue;
                    if (startsOnLine && at < 16) continue;
                    if (covered(page.x + point.x, page.y + point.y)) continue;
                    const ahead = path.getPointAtLength(Math.min(length, at + 1));
                    const tx = ahead.x - point.x;
                    const ty = ahead.y - point.y;
                    const norm = Math.hypot(tx, ty) || 1;
                    samples.push({
                        x: page.x + point.x,
                        y: page.y + point.y,
                        bx: page.x + point.x - (ty / norm) * 6,
                        by: page.y + point.y + (tx / norm) * 6,
                        mix: 0,
                    });
                }
                lines.push({ d, from, to, opacity, dashed: path.dataset.test === 'graph-edge-dashed', samples });
            }
        }
        return lines;
    }

    // From the very first frame, before hydration: how many rail pieces and canvas lines show, to check the hand-over.
    function startHandoff() {
        const frames = [];
        const startedAt = performance.now();
        const tick = () => {
            const cards = document.querySelectorAll('[data-test="commit"]').length;
            const pieces = [...document.querySelectorAll(railPieces)].filter(isVisible).length;
            const lines = document.querySelectorAll('[data-test="graph-canvas"] > g path').length;
            // Where the cards sit, to tell whether the hand-over moves anything.
            const layout = [...document.querySelectorAll('[data-test="commit"]')]
                .slice(0, 12)
                .map((card) => `${Math.round(card.getBoundingClientRect().top + window.scrollY)}:${card.offsetHeight}`)
                .join(' ');
            frames.push({ t: Math.round(performance.now() - startedAt), cards, pieces, lines, layout });
            if (performance.now() - startedAt < 4000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        window.__glabHandoff = frames;

        // Hydration keeps the server's elements; a fresh client render throws them away and builds new ones.
        window.__glabServerCardsReplaced = 0;
        const replaced = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.removedNodes) {
                    if (node.nodeType === 1 && (node.matches('[data-test="commit"]') || node.querySelector('[data-test="commit"]'))) window.__glabServerCardsReplaced++;
                }
            }
        });
        replaced.observe(document, { childList: true, subtree: true });
        setTimeout(() => replaced.disconnect(), 4000);
    }

    window.__glab = { audit, dimming, paintSamples, startHandoff, startRecording, stop: () => window.__glabStop?.() ?? [] };
}
