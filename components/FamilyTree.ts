/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * FamilyTree — a static, hierarchical genealogy view of the cast.
 *
 * Unlike the force-directed StoryGraph / RelationshipMap, this lays characters
 * out in fixed generational rows: blood `parent`/`child` relations form the
 * vertical spine, `spouse`/`partner` relations join people into horizontal
 * "couple" units, and `birthday` orders siblings oldest→left.  Everyone in the
 * vault is shown — people with no parents and no spouse become roots, so when
 * zoomed all the way out the canvas reads as a *forest*: many small trees plus
 * an "Unconnected" band of true isolates.
 *
 * Layout: marriages are merged into units (union-find over spouse/partner
 * edges); each child-unit is attached to exactly one parent-unit so the result
 * is a clean tree of units, laid out with a two-pass Reingold–Tilford tidy-tree
 * (bottom-up widths, top-down centering).  Components are shelf-packed.
 *
 * Rendering mirrors StoryGraph's self-contained SVG pan/zoom idiom (an inner
 * <g> with `translate(pan) scale(zoom)`, wheel-zoom, drag-pan) but with no
 * physics — positions are computed once.
 */

import * as obsidian from 'obsidian';
import type { Character } from '../models/Character';
import { normalizeCharacterRelations, getPrimaryRole } from '../models/Character';

// ── Tunables ──────────────────────────────────────────
// Nodes mirror the Relationship Map's aesthetic: an accent-filled circle with
// the name below and a muted role badge above. NODE_W is the horizontal slot
// (label) footprint used for layout; CIRCLE_R is the drawn node radius.
const CIRCLE_R = 18;            // node circle radius (matches the Map)
const NODE_W = 140;             // horizontal layout footprint (label width)
const ROLE_GAP = 10;            // circle top → role badge baseline
const NAME_GAP = 15;            // circle bottom → name baseline
const SUB_GAP = 13;             // name baseline → birth-year baseline
const MEMBER_GAP = 26;          // gap between spouses inside a unit
const SIBLING_GAP = 30;         // gap between sibling units
const ROW_H = 132;              // vertical pitch between generations
const COMPONENT_GAP = 90;       // gap between separate family trees
const MAX_ROW_WIDTH = 2800;     // wrap point for shelf packing
const ISOLATE_COLS_WIDTH = 2400;

const MEMBER_STEP = NODE_W + MEMBER_GAP;

const svgNS = 'http://www.w3.org/2000/svg';

// ── Theming ───────────────────────────────────────────
function resolveColor(varName: string, fallback: string): string {
    const val = getComputedStyle(activeDocument.body).getPropertyValue(varName).trim();
    return val || fallback;
}

// ── Types ─────────────────────────────────────────────
interface FTNode {
    id: string;             // character filePath
    char: Character;
    label: string;
    birthMs: number;        // parsed birthday, or +Infinity if unknown
    gen: number;            // generation row (0 = top)
    unit: number;           // marriage-unit id
    x: number;              // final centre x (px)
    y: number;              // final centre y (px)
}

interface FTUnit {
    id: number;
    members: string[];      // node ids, left→right
    gen: number;
    /** parent unit this unit descends from, or -1 if a root */
    parentUnit: number;
    childUnits: number[];
    width: number;          // computed subtree width (px)
    centerX: number;        // assigned during placement
}

type CoupleKind = 'spouse' | 'partner' | 'ex';
interface CoupleEdge { a: string; b: string; kind: CoupleKind; }

export class FamilyTree {
    private container: HTMLElement;
    private characters: Character[];
    private resolve: (name: string) => Character | undefined;
    private onSelect: (filePath: string) => void;
    private onOpen: (filePath: string) => void;

    private nodes = new Map<string, FTNode>();
    private units = new Map<number, FTUnit>();
    private parentsOf = new Map<string, Set<string>>();
    private childrenOf = new Map<string, Set<string>>();
    private coupleEdges: CoupleEdge[] = [];
    private isolates: string[] = [];

    private svg: SVGSVGElement | null = null;
    private wrapper: HTMLElement | null = null;
    private width = 900;
    private height = 600;
    private panX = 0;
    private panY = 0;
    private zoom = 1;
    private isPanning = false;
    private panStart = { x: 0, y: 0 };
    private resizeObserver: ResizeObserver | null = null;
    private contentBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    private boundMove = (e: MouseEvent) => this.onWindowMove(e);
    private boundUp = () => { this.isPanning = false; };

    constructor(
        container: HTMLElement,
        characters: Character[],
        resolve: (name: string) => Character | undefined,
        onSelect: (filePath: string) => void,
        onOpen: (filePath: string) => void,
    ) {
        this.container = container;
        this.characters = characters;
        this.resolve = resolve;
        this.onSelect = onSelect;
        this.onOpen = onOpen;
    }

    // ── Public API ─────────────────────────────────────
    render(): void {
        this.container.empty();
        this.build();

        if (this.nodes.size === 0) {
            const empty = this.container.createDiv('sl-family-tree-empty');
            empty.createEl('p', { text: 'No characters found. Add characters (with parent/child or spouse relations) to see a family tree.' });
            return;
        }

        this.renderToolbar();

        const wrapper = this.container.createDiv('sl-family-tree-wrapper');
        this.wrapper = wrapper;
        const rect = wrapper.getBoundingClientRect();
        this.width = Math.max(700, rect.width || 900);
        this.height = Math.max(450, rect.height || 600);

        this.svg = activeDocument.createElementNS(svgNS, 'svg');
        this.svg.setAttribute('width', '100%');
        this.svg.setAttribute('height', '100%');
        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
        this.svg.classList.add('sl-family-tree-svg');
        wrapper.appendChild(this.svg);

        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const cr = entry.contentRect;
                if (cr.width > 0 && cr.height > 0) {
                    this.width = Math.max(700, cr.width);
                    this.height = Math.max(450, cr.height);
                    if (this.svg) this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
                    this.draw();
                }
            }
        });
        this.resizeObserver.observe(wrapper);

        // Pan (drag empty canvas)
        this.svg.addEventListener('mousedown', (e) => {
            if (e.target === this.svg || (e.target as Element).classList?.contains('sl-ft-bg')) {
                this.isPanning = true;
                this.panStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
            }
        });
        window.addEventListener('mousemove', this.boundMove);
        window.addEventListener('mouseup', this.boundUp);

        // Zoom (wheel, toward cursor)
        this.svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 0.9;
            const newZoom = Math.min(4, Math.max(0.05, this.zoom * factor));
            const svgRect = this.svg!.getBoundingClientRect();
            const mx = e.clientX - svgRect.left;
            const my = e.clientY - svgRect.top;
            this.panX = mx - (mx - this.panX) * (newZoom / this.zoom);
            this.panY = my - (my - this.panY) * (newZoom / this.zoom);
            this.zoom = newZoom;
            this.draw();
        }, { passive: false });

        this.fit();
        this.draw();
    }

    destroy(): void {
        if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
        window.removeEventListener('mousemove', this.boundMove);
        window.removeEventListener('mouseup', this.boundUp);
    }

    private onWindowMove(e: MouseEvent): void {
        if (!this.isPanning) return;
        this.panX = e.clientX - this.panStart.x;
        this.panY = e.clientY - this.panStart.y;
        this.draw();
    }

    // ── Graph construction ─────────────────────────────
    private build(): void {
        this.nodes.clear();
        this.units.clear();
        this.parentsOf.clear();
        this.childrenOf.clear();
        this.coupleEdges = [];
        this.isolates = [];

        // 1. Nodes
        for (const c of this.characters) {
            this.nodes.set(c.filePath, {
                id: c.filePath,
                char: c,
                label: c.name,
                birthMs: parseBirthday(c.birthday),
                gen: 0,
                unit: -1,
                x: 0,
                y: 0,
            });
            this.parentsOf.set(c.filePath, new Set());
            this.childrenOf.set(c.filePath, new Set());
        }

        // 2. Edges from relations
        const seenCouple = new Set<string>();
        for (const c of this.characters) {
            const rels = normalizeCharacterRelations(c.relations);
            for (const r of rels) {
                const target = this.resolveTarget(r.target);
                if (!target || target.filePath === c.filePath) continue;
                if (r.category === 'family' && r.type === 'parent') {
                    this.parentsOf.get(c.filePath)!.add(target.filePath);
                    this.childrenOf.get(target.filePath)!.add(c.filePath);
                } else if (r.category === 'family' && r.type === 'child') {
                    this.childrenOf.get(c.filePath)!.add(target.filePath);
                    this.parentsOf.get(target.filePath)!.add(c.filePath);
                } else if (r.category === 'romantic' && (r.type === 'spouse' || r.type === 'partner' || r.type === 'ex-partner')) {
                    const kind: CoupleKind = r.type === 'ex-partner' ? 'ex' : (r.type as CoupleKind);
                    const key = [c.filePath, target.filePath].sort().join('|') + '::' + kind;
                    if (seenCouple.has(key)) continue;
                    seenCouple.add(key);
                    this.coupleEdges.push({ a: c.filePath, b: target.filePath, kind });
                }
            }
        }

        // 3. Marriage units (union-find over spouse/partner — NOT ex)
        const uf = new UnionFind();
        for (const id of this.nodes.keys()) uf.add(id);
        for (const e of this.coupleEdges) {
            if (e.kind !== 'ex') uf.union(e.a, e.b);
        }
        const unitGroups = new Map<string, string[]>();
        for (const id of this.nodes.keys()) {
            const root = uf.find(id);
            if (!unitGroups.has(root)) unitGroups.set(root, []);
            unitGroups.get(root)!.push(id);
        }
        let unitId = 0;
        const unitOfNode = new Map<string, number>();
        for (const members of unitGroups.values()) {
            // order spouses oldest→left
            members.sort((a, b) => this.nodes.get(a)!.birthMs - this.nodes.get(b)!.birthMs);
            const u: FTUnit = { id: unitId, members, gen: 0, parentUnit: -1, childUnits: [], width: 0, centerX: 0 };
            this.units.set(unitId, u);
            for (const m of members) { this.nodes.get(m)!.unit = unitId; unitOfNode.set(m, unitId); }
            unitId++;
        }

        // 4. Generation assignment (iterate to fixed point, capped)
        this.assignGenerations();
        for (const u of this.units.values()) {
            u.gen = Math.min(...u.members.map(m => this.nodes.get(m)!.gen));
        }

        // 5. Attach each unit to a single parent-unit (build tree-of-units)
        for (const u of this.units.values()) {
            let chosenParent = -1;
            let chosenGen = Infinity;
            for (const m of u.members) {
                for (const p of this.parentsOf.get(m)!) {
                    const pu = unitOfNode.get(p);
                    if (pu == null || pu === u.id) continue;
                    const pg = this.units.get(pu)!.gen;
                    if (pg < chosenGen) { chosenGen = pg; chosenParent = pu; }
                }
            }
            u.parentUnit = chosenParent;
            if (chosenParent !== -1) this.units.get(chosenParent)!.childUnits.push(u.id);
        }
        // order child units oldest→left (by eldest bloodline child birthday)
        for (const u of this.units.values()) {
            u.childUnits.sort((a, b) => this.unitEldest(a) - this.unitEldest(b));
        }

        // 6. Split into components (over parent/child + all couple edges incl. ex)
        const cuf = new UnionFind();
        for (const id of this.nodes.keys()) cuf.add(id);
        for (const [child, parents] of this.parentsOf) for (const p of parents) cuf.union(child, p);
        for (const e of this.coupleEdges) cuf.union(e.a, e.b);

        // isolates = lone nodes with no edges at all
        for (const node of this.nodes.values()) {
            const hasEdge = this.parentsOf.get(node.id)!.size > 0
                || this.childrenOf.get(node.id)!.size > 0
                || this.coupleEdges.some(e => e.a === node.id || e.b === node.id);
            if (!hasEdge) this.isolates.push(node.id);
        }

        // 7. Lay out each connected component, then shelf-pack
        this.layoutAndPack(cuf);
    }

    private resolveTarget(raw: string): Character | undefined {
        if (!raw) return undefined;
        // strip [[ ]] and any |alias
        let name = raw.replace(/\[\[([^\]]+)\]\]/g, '$1').trim();
        const pipe = name.indexOf('|');
        if (pipe !== -1) name = name.slice(0, pipe).trim();
        // strip a path/heading suffix like Folder/Name#Heading
        const slash = name.lastIndexOf('/');
        if (slash !== -1) name = name.slice(slash + 1).trim();
        const hash = name.indexOf('#');
        if (hash !== -1) name = name.slice(0, hash).trim();
        return this.resolve(name);
    }

    private assignGenerations(): void {
        for (let iter = 0; iter < 60; iter++) {
            let changed = false;
            // children sit below their deepest parent
            for (const [child, parents] of this.parentsOf) {
                const cn = this.nodes.get(child)!;
                for (const p of parents) {
                    const pn = this.nodes.get(p);
                    if (!pn) continue;
                    if (cn.gen <= pn.gen) { cn.gen = pn.gen + 1; changed = true; }
                }
            }
            // spouses/partners share a generation
            for (const e of this.coupleEdges) {
                if (e.kind === 'ex') continue;
                const a = this.nodes.get(e.a)!, b = this.nodes.get(e.b)!;
                const m = Math.max(a.gen, b.gen);
                if (a.gen < m) { a.gen = m; changed = true; }
                if (b.gen < m) { b.gen = m; changed = true; }
            }
            if (!changed) break;
        }
    }

    /** Eldest bloodline-child birthday within a unit (for sibling ordering). */
    private unitEldest(unitId: number): number {
        const u = this.units.get(unitId)!;
        let best = Infinity;
        for (const m of u.members) {
            // only members who are actually a child of this unit's parent count,
            // but using all members is a fine approximation for ordering
            best = Math.min(best, this.nodes.get(m)!.birthMs);
        }
        return best;
    }

    // ── Layout ─────────────────────────────────────────
    private layoutAndPack(cuf: UnionFind): void {
        // Group root units (parentUnit === -1) by component, skipping isolates.
        const isolateSet = new Set(this.isolates);
        const compRoots = new Map<string, number[]>(); // component key → root unit ids
        for (const u of this.units.values()) {
            if (u.parentUnit !== -1) continue;
            // skip pure isolate units (single member, no edges)
            if (u.members.length === 1 && isolateSet.has(u.members[0])) continue;
            const key = cuf.find(u.members[0]);
            if (!compRoots.has(key)) compRoots.set(key, []);
            compRoots.get(key)!.push(u.id);
        }

        // Compute width for every unit (bottom-up).
        for (const u of this.units.values()) {
            if (u.parentUnit === -1 && !(u.members.length === 1 && isolateSet.has(u.members[0]))) {
                this.computeWidth(u.id);
            }
        }

        // Lay out each component into local coords, capture its bounds.
        interface Comp { roots: number[]; width: number; height: number; }
        const comps: Comp[] = [];
        for (const roots of compRoots.values()) {
            // place roots side by side from x=0
            let cursor = 0;
            let maxGen = 0;
            for (const rid of roots) {
                this.place(rid, cursor);
                cursor += this.units.get(rid)!.width + SIBLING_GAP;
                maxGen = Math.max(maxGen, this.componentMaxGen(rid));
            }
            const width = Math.max(0, cursor - SIBLING_GAP);
            const height = (maxGen + 1) * ROW_H;
            comps.push({ roots, width, height });
        }
        // larger trees first
        comps.sort((a, b) => b.width - a.width);

        // Shelf-pack components.
        let shelfX = 0, shelfY = 0, shelfH = 0;
        for (const comp of comps) {
            if (shelfX > 0 && shelfX + comp.width > MAX_ROW_WIDTH) {
                shelfY += shelfH + COMPONENT_GAP;
                shelfX = 0; shelfH = 0;
            }
            this.translateComponent(comp.roots, shelfX, shelfY);
            shelfX += comp.width + COMPONENT_GAP;
            shelfH = Math.max(shelfH, comp.height);
        }

        // Isolates band below the forest.
        let isoY = (comps.length ? shelfY + shelfH + COMPONENT_GAP : 0);
        if (this.isolates.length) {
            isoY += 40; // room for divider label
            const step = NODE_W + SIBLING_GAP;
            const perRow = Math.max(1, Math.floor(ISOLATE_COLS_WIDTH / step));
            this.isolates.sort((a, b) => this.nodes.get(a)!.label.localeCompare(this.nodes.get(b)!.label));
            this.isolatesBandY = isoY;
            this.isolatesBandHasItems = true;
            this.isolates.forEach((id, i) => {
                const col = i % perRow, row = Math.floor(i / perRow);
                const n = this.nodes.get(id)!;
                n.x = col * step + NODE_W / 2;
                n.y = isoY + row * (CIRCLE_R * 2 + 52) + CIRCLE_R + ROLE_GAP;
            });
        }

        this.computeBounds();
    }

    private isolatesBandY = 0;
    private isolatesBandHasItems = false;

    /** Bottom-up subtree width (px); centres a unit over the wider of its own
     *  member row or the span of its children. */
    private computeWidth(unitId: number): number {
        const u = this.units.get(unitId)!;
        const intrinsic = u.members.length * NODE_W + (u.members.length - 1) * MEMBER_GAP;
        if (u.childUnits.length === 0) { u.width = intrinsic; return intrinsic; }
        let span = 0;
        for (const cid of u.childUnits) span += this.computeWidth(cid);
        span += SIBLING_GAP * (u.childUnits.length - 1);
        u.width = Math.max(intrinsic, span);
        return u.width;
    }

    /** Top-down placement using pre-computed widths. */
    private place(unitId: number, leftX: number): void {
        const u = this.units.get(unitId)!;
        const center = leftX + u.width / 2;
        u.centerX = center;
        // members centred around `center`
        const m = u.members.length;
        const total = (m - 1) * MEMBER_STEP;
        const start = center - total / 2;
        // circle centre sits below the top of the row, leaving room for the
        // role badge above and name/birth-year labels below
        const y = u.gen * ROW_H + CIRCLE_R + ROLE_GAP + 8;
        u.members.forEach((id, i) => {
            const n = this.nodes.get(id)!;
            n.x = start + i * MEMBER_STEP;
            n.y = y;
        });
        if (u.childUnits.length) {
            let span = 0;
            for (const cid of u.childUnits) span += this.units.get(cid)!.width;
            span += SIBLING_GAP * (u.childUnits.length - 1);
            let cursor = center - span / 2;
            for (const cid of u.childUnits) {
                this.place(cid, cursor);
                cursor += this.units.get(cid)!.width + SIBLING_GAP;
            }
        }
    }

    private componentMaxGen(unitId: number, seen = new Set<number>()): number {
        if (seen.has(unitId)) return 0;
        seen.add(unitId);
        const u = this.units.get(unitId)!;
        let max = u.gen;
        for (const cid of u.childUnits) max = Math.max(max, this.componentMaxGen(cid, seen));
        return max;
    }

    private translateComponent(roots: number[], dx: number, dy: number): void {
        const seen = new Set<number>();
        const walk = (unitId: number) => {
            if (seen.has(unitId)) return;
            seen.add(unitId);
            const u = this.units.get(unitId)!;
            u.centerX += dx;
            for (const id of u.members) {
                const n = this.nodes.get(id)!;
                n.x += dx; n.y += dy;
            }
            for (const cid of u.childUnits) walk(cid);
        };
        for (const r of roots) walk(r);
    }

    private computeBounds(): void {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of this.nodes.values()) {
            minX = Math.min(minX, n.x - NODE_W / 2);
            maxX = Math.max(maxX, n.x + NODE_W / 2);
            minY = Math.min(minY, this.nodeTop(n));
            maxY = Math.max(maxY, this.nodeBottom(n));
        }
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
        this.contentBounds = { minX, minY, maxX, maxY };
    }

    private fit(): void {
        const b = this.contentBounds;
        const pad = 60;
        const cw = (b.maxX - b.minX) + pad * 2;
        const ch = (b.maxY - b.minY) + pad * 2;
        const z = Math.min(this.width / cw, this.height / ch, 1.2);
        this.zoom = Math.max(0.05, z);
        // centre content
        const contentCX = (b.minX + b.maxX) / 2;
        const contentCY = (b.minY + b.maxY) / 2;
        this.panX = this.width / 2 - contentCX * this.zoom;
        this.panY = this.height / 2 - contentCY * this.zoom;
    }

    // ── Toolbar ────────────────────────────────────────
    private renderToolbar(): void {
        const bar = this.container.createDiv('sl-family-tree-toolbar');
        const fitBtn = bar.createEl('button', { cls: 'sl-family-tree-btn' });
        obsidian.setIcon(fitBtn.createSpan(), 'maximize');
        fitBtn.createSpan({ text: ' Fit' });
        fitBtn.addEventListener('click', () => { this.fit(); this.draw(); });

        const zoomIn = bar.createEl('button', { cls: 'sl-family-tree-btn' });
        obsidian.setIcon(zoomIn.createSpan(), 'zoom-in');
        zoomIn.addEventListener('click', () => this.zoomBy(1.2));

        const zoomOut = bar.createEl('button', { cls: 'sl-family-tree-btn' });
        obsidian.setIcon(zoomOut.createSpan(), 'zoom-out');
        zoomOut.addEventListener('click', () => this.zoomBy(1 / 1.2));

        const hint = bar.createSpan({ cls: 'sl-family-tree-hint' });
        hint.textContent = 'Scroll to zoom · drag to pan · click a card to open · double-click for the file';
    }

    private zoomBy(factor: number): void {
        const newZoom = Math.min(4, Math.max(0.05, this.zoom * factor));
        const cx = this.width / 2, cy = this.height / 2;
        this.panX = cx - (cx - this.panX) * (newZoom / this.zoom);
        this.panY = cy - (cy - this.panY) * (newZoom / this.zoom);
        this.zoom = newZoom;
        this.draw();
    }

    // ── Rendering ──────────────────────────────────────
    private draw(): void {
        if (!this.svg) return;
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

        // transparent backdrop to catch pan drags
        const bg = activeDocument.createElementNS(svgNS, 'rect');
        bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
        bg.setAttribute('width', String(this.width));
        bg.setAttribute('height', String(this.height));
        bg.setAttribute('fill', 'transparent');
        bg.classList.add('sl-ft-bg');
        this.svg.appendChild(bg);

        const g = activeDocument.createElementNS(svgNS, 'g');
        g.setAttribute('transform', `translate(${this.panX},${this.panY}) scale(${this.zoom})`);
        this.svg.appendChild(g);

        const bloodColor = resolveColor('--sl-ft-blood', '#8a8f98');
        const marriageColor = resolveColor('--sl-ft-marriage', '#c77dff');

        // 1. Descent lines (parent unit → children), drawn first (behind nodes)
        for (const u of this.units.values()) {
            this.drawDescent(g, u, bloodColor);
        }

        // 2. Couple bars (spouse/partner solid, ex dashed)
        for (const e of this.coupleEdges) {
            const a = this.nodes.get(e.a), b = this.nodes.get(e.b);
            if (!a || !b) continue;
            const line = activeDocument.createElementNS(svgNS, 'line');
            line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y));
            line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
            line.setAttribute('stroke', marriageColor);
            if (e.kind === 'ex') {
                line.setAttribute('stroke-width', '1.5');
                line.setAttribute('stroke-opacity', '0.4');
                line.setAttribute('stroke-dasharray', '5,4');
            } else {
                line.setAttribute('stroke-width', '2.5');
                line.setAttribute('stroke-opacity', '0.85');
            }
            g.appendChild(line);
        }

        // 3. Nodes
        for (const node of this.nodes.values()) this.drawNode(g, node);

        // 4. Isolates band divider label
        if (this.isolatesBandHasItems) {
            const label = activeDocument.createElementNS(svgNS, 'text');
            label.setAttribute('x', String(this.contentBounds.minX + 4));
            label.setAttribute('y', String(this.isolatesBandY - 14));
            label.setAttribute('fill', 'var(--text-muted)');
            label.setAttribute('font-size', '15');
            label.setAttribute('font-weight', '600');
            label.textContent = 'Unconnected';
            g.appendChild(label);
        }
    }

    /** Visual top of a node (above the circle, allowing for the role badge). */
    private nodeTop(n: FTNode): number {
        return n.y - CIRCLE_R - ROLE_GAP - 6;
    }
    /** Visual bottom of a node (below the name / birth-year labels). */
    private nodeBottom(n: FTNode): number {
        return n.y + CIRCLE_R + NAME_GAP + (n.char.birthday ? SUB_GAP : 0) + 4;
    }

    /** Draw the orthogonal "bus" from a unit down to its bloodline children. */
    private drawDescent(g: SVGElement, u: FTUnit, color: string): void {
        if (u.childUnits.length === 0) return;
        // bloodline parents = members who actually have children
        const parentNodes: FTNode[] = [];
        for (const id of u.members) {
            if (this.childrenOf.get(id)!.size > 0) parentNodes.push(this.nodes.get(id)!);
        }
        if (parentNodes.length === 0) parentNodes.push(this.nodes.get(u.members[0])!);

        const midX = parentNodes.reduce((s, n) => s + n.x, 0) / parentNodes.length;
        const parentY = Math.max(...parentNodes.map(n => n.y));
        // a couple drop hangs from the bar between the circles (no label there);
        // a single parent's drop must clear its own name/birth-year labels.
        const dropStartY = parentNodes.length >= 2 ? parentY : this.nodeBottom(parentNodes[0]);

        // child connection points = each child unit's bloodline child circle-top
        const childPts: { x: number; topY: number }[] = [];
        for (const cid of u.childUnits) {
            const cu = this.units.get(cid)!;
            const childId = cu.members.find(m => {
                for (const p of this.parentsOf.get(m)!) if (this.nodes.get(p) && this.nodes.get(p)!.unit === u.id) return true;
                return false;
            }) || cu.members[0];
            const cn = this.nodes.get(childId)!;
            childPts.push({ x: cn.x, topY: cn.y - CIRCLE_R });
        }
        if (childPts.length === 0) return;
        const childTop = Math.min(...childPts.map(p => p.topY));
        const busY = Math.max(dropStartY + 12, childTop - 22);

        const mk = (x1: number, y1: number, x2: number, y2: number) => {
            const l = activeDocument.createElementNS(svgNS, 'line');
            l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
            l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
            l.setAttribute('stroke', color);
            l.setAttribute('stroke-width', '1.8');
            l.setAttribute('stroke-opacity', '0.7');
            g.appendChild(l);
        };

        // drop from parents to the bus
        mk(midX, dropStartY, midX, busY);
        // horizontal bus across all children (and the parent drop point)
        const minBx = Math.min(midX, ...childPts.map(p => p.x));
        const maxBx = Math.max(midX, ...childPts.map(p => p.x));
        mk(minBx, busY, maxBx, busY);
        // drop to each child
        for (const p of childPts) mk(p.x, busY, p.x, p.topY);
    }

    private drawNode(g: SVGElement, node: FTNode): void {
        const group = activeDocument.createElementNS(svgNS, 'g');
        group.classList.add('sl-ft-node');
        group.setCssStyles({ cursor: 'pointer' });

        // Accent circle — mirrors the Relationship Map's node styling
        const circle = activeDocument.createElementNS(svgNS, 'circle');
        circle.setAttribute('cx', String(node.x));
        circle.setAttribute('cy', String(node.y));
        circle.setAttribute('r', String(CIRCLE_R));
        circle.setAttribute('fill', resolveColor('--sl-ft-accent', 'var(--interactive-accent)'));
        circle.setAttribute('stroke', 'var(--background-primary)');
        circle.setAttribute('stroke-width', '2');
        group.appendChild(circle);

        // Role badge above the circle
        const role = getPrimaryRole(node.char);
        if (role) {
            const badge = activeDocument.createElementNS(svgNS, 'text');
            badge.setAttribute('x', String(node.x));
            badge.setAttribute('y', String(node.y - CIRCLE_R - ROLE_GAP));
            badge.setAttribute('text-anchor', 'middle');
            badge.setAttribute('fill', 'var(--text-muted)');
            badge.setAttribute('font-size', '9');
            badge.textContent = truncate(role, 22);
            group.appendChild(badge);
        }

        // Name below the circle
        const name = activeDocument.createElementNS(svgNS, 'text');
        name.setAttribute('x', String(node.x));
        name.setAttribute('y', String(node.y + CIRCLE_R + NAME_GAP));
        name.setAttribute('text-anchor', 'middle');
        name.setAttribute('fill', 'var(--text-normal)');
        name.setAttribute('font-size', '12');
        name.setAttribute('font-weight', '600');
        name.textContent = truncate(node.label, 20);
        group.appendChild(name);

        // Birth year under the name
        if (node.char.birthday) {
            const sub = activeDocument.createElementNS(svgNS, 'text');
            sub.setAttribute('x', String(node.x));
            sub.setAttribute('y', String(node.y + CIRCLE_R + NAME_GAP + SUB_GAP));
            sub.setAttribute('text-anchor', 'middle');
            sub.setAttribute('fill', 'var(--text-muted)');
            sub.setAttribute('font-size', '10');
            sub.textContent = `b. ${formatYear(node.char.birthday)}`;
            group.appendChild(sub);
        }

        let clickTimer: number | null = null;
        group.addEventListener('click', (e) => {
            e.stopPropagation();
            if (clickTimer) return;
            clickTimer = window.setTimeout(() => {
                clickTimer = null;
                this.onSelect(node.id);
            }, 220);
        });
        group.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            this.onOpen(node.id);
        });

        g.appendChild(group);
    }
}

// ── Helpers ───────────────────────────────────────────
class UnionFind {
    private parent = new Map<string, string>();
    add(x: string): void { if (!this.parent.has(x)) this.parent.set(x, x); }
    find(x: string): string {
        let root = x;
        while (this.parent.get(root) !== root) root = this.parent.get(root)!;
        // path compression
        let cur = x;
        while (this.parent.get(cur) !== root) { const next = this.parent.get(cur)!; this.parent.set(cur, root); cur = next; }
        return root;
    }
    union(a: string, b: string): void {
        this.add(a); this.add(b);
        const ra = this.find(a), rb = this.find(b);
        if (ra !== rb) this.parent.set(ra, rb);
    }
}

function parseBirthday(b?: string): number {
    if (!b) return Infinity;
    const t = Date.parse(b);
    if (!isNaN(t)) return t;
    const yr = /^(\d{3,4})/.exec(b.trim());
    if (yr) return Date.parse(`${yr[1]}-01-01`);
    return Infinity;
}

function formatYear(b: string): string {
    const m = /(\d{3,4})/.exec(b);
    return m ? m[1] : b;
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
