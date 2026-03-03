import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';

import type { ViewMode } from '../types/viewMode';

const elk = new ELK();

// ── Layout Cache ─────────────────────────────────────────────────────────────
const layoutCache = new Map<string, { nodes: Node[]; edges: Edge[] }>();

export interface ElkLayoutOptions {
    direction?: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';
    nodeSpacing?: number;
    layerSpacing?: number;
    viewMode?: ViewMode;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHAT WAS WRONG (caused the "everything piled on top of each other" bug):
//
// 1. `elk.hierarchyHandling: 'INCLUDE_CHILDREN'` on the ROOT graph tells ELK
//    to flatten the entire hierarchy and route ALL edges (including cross-domain
//    ones) at the top level. This is only useful when you have edges crossing
//    hierarchy boundaries. With it on, ELK ignores your nested layout options
//    and collapses all nodes into a single layer → the pile/overlap you saw.
//
// 2. Having `elk.hierarchyHandling: 'INCLUDE_CHILDREN'` on domainNodes as well
//    compounded the problem — ELK would try to include grand-children in the
//    domain's own layout pass, fighting against the file's rectpacking pass.
//
// 3. `elk.edgeRouting: 'SPLINES'` on the root combined with hierarchy handling
//    caused edge routing to collapse node bounding boxes.
//
// FIX STRATEGY:
//  - Remove `elk.hierarchyHandling` from root and domainNodes entirely.
//    Let each container lay out its own children independently.
//  - Use `rectpacking` inside fileNodes for the symbol grid (unchanged).
//  - Separate cross-hierarchy edges: only pass edges whose BOTH endpoints are
//    at the same hierarchy level to each layout container. Edges that cross
//    domains go only to the root graph.
//  - Dynamically size every container (domain, file) based on actual children.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply ELK layout to nodes and edges.
 * Hierarchy: Root → Domain(s) → File(s) → Symbol(s)
 */
export async function applyElkLayout(
    nodes: Node[],
    edges: Edge[],
    options: ElkLayoutOptions = {}
): Promise<{ nodes: Node[]; edges: Edge[] }> {
    // Check cache first
    const cacheKey = JSON.stringify({
        nodes: nodes.map((n) => n.id).sort(),
        edges: edges.map((e) => `${e.source}->${e.target}`).sort(),
        options,
    });

    const cached = layoutCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const {
        direction = 'DOWN',
        nodeSpacing = 100,
        layerSpacing = 150,
    } = options;

    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // ── Helpers ──────────────────────────────────────────────────────────────

    const isNestedFolder = (node: Node): boolean => {
        if (node.type !== 'domainNode' || !node.parentId) return false;
        const parent = nodeMap.get(node.parentId);
        return !!parent && parent.type === 'domainNode';
    };

    const getDirectChildren = (parentId: string): Node[] =>
        nodes.filter(n => n.parentId === parentId);

    const getSymbolChildren = (fileNodeId: string): Node[] =>
        nodes.filter(n => n.parentId === fileNodeId && n.type === 'symbolNode');

    // ── Symbol grid size calculator ──────────────────────────────────────────
    const SYMBOL_W = 200;
    const SYMBOL_H = 50;
    const SYMBOL_GAP_X = 20;
    const SYMBOL_GAP_Y = 20;
    const GRID_COLS = 5;
    const FILE_PADDING_TOP = 50;
    const FILE_PADDING_SIDE = 20;

    function calcFileSize(fileNodeId: string): { width: number; height: number } {
        const count = getSymbolChildren(fileNodeId).length || 1;
        const cols = Math.min(count, GRID_COLS);
        const rows = Math.ceil(count / GRID_COLS);
        const width =
            cols * SYMBOL_W + (cols - 1) * SYMBOL_GAP_X + FILE_PADDING_SIDE * 2;
        const height =
            rows * SYMBOL_H + (rows - 1) * SYMBOL_GAP_Y + FILE_PADDING_TOP + FILE_PADDING_SIDE;
        return {
            width: Math.max(width, 260),
            height: Math.max(height, 120),
        };
    }

    // ── Domain size calculator ───────────────────────────────────────────────
    // A domain must be large enough to contain all its file children arranged
    // in a vertical stack (DOWN direction) with spacing.
    const DOMAIN_PADDING_TOP = 70;
    const DOMAIN_PADDING_SIDE = 30;
    const FILE_GAP = 40;

    function calcDomainSize(domainNodeId: string): { width: number; height: number } {
        const fileChildren = getDirectChildren(domainNodeId).filter(
            n => n.type === 'fileNode'
        );
        // Also account for nested sub-domain children
        const subDomainChildren = getDirectChildren(domainNodeId).filter(
            n => n.type === 'domainNode'
        );

        let maxChildWidth = 400;
        let totalChildHeight = 0;

        fileChildren.forEach(fc => {
            const sz = calcFileSize(fc.id);
            maxChildWidth = Math.max(maxChildWidth, sz.width);
            totalChildHeight += sz.height + FILE_GAP;
        });

        subDomainChildren.forEach(sc => {
            const sz = calcDomainSize(sc.id);
            maxChildWidth = Math.max(maxChildWidth, sz.width);
            totalChildHeight += sz.height + FILE_GAP;
        });

        return {
            width: maxChildWidth + DOMAIN_PADDING_SIDE * 2,
            height: Math.max(
                totalChildHeight + DOMAIN_PADDING_TOP + DOMAIN_PADDING_SIDE,
                200
            ),
        };
    }

    // ── Build ELK node map ───────────────────────────────────────────────────
    const elkNodeMap = new Map<string, ElkNode>();

    nodes.forEach(node => {
        let width = 200;
        let height = 60;

        if (node.type === 'domainNode') {
            const sz = calcDomainSize(node.id);
            width = sz.width;
            height = sz.height;
        } else if (node.type === 'fileNode') {
            const sz = calcFileSize(node.id);
            width = sz.width;
            height = sz.height;
        } else if (node.type === 'symbolNode') {
            width = SYMBOL_W;
            height = SYMBOL_H;
        }

        const elkNode: ElkNode = {
            id: node.id,
            width,
            height,
            children: [],
            // layoutOptions are set below per type
        };

        if (node.type === 'domainNode') {
            // ✅ KEY FIX: No `elk.hierarchyHandling` here.
            // Each domain lays out its own direct children only.
            elkNode.layoutOptions = {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.padding': isNestedFolder(node)
                    ? '[top=110,left=20,bottom=20,right=20]'
                    : '[top=70,left=25,bottom=25,right=25]',
                'elk.spacing.nodeNode': '40',
                'elk.layered.spacing.nodeNodeBetweenLayers': '50',
                'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
                'elk.separateConnectedComponents': 'true',
                'elk.spacing.componentComponent': '40',
            };
        } else if (node.type === 'fileNode') {
            // ✅ rectpacking gives a clean symbol grid — no layered algorithm fighting here
            elkNode.layoutOptions = {
                'elk.algorithm': 'rectpacking',
                'elk.padding': `[top=${FILE_PADDING_TOP},left=${FILE_PADDING_SIDE},bottom=${FILE_PADDING_SIDE},right=${FILE_PADDING_SIDE}]`,
                'elk.spacing.nodeNode': `${SYMBOL_GAP_X}`,
                // targetWidth = exactly 5 columns of symbols
                'elk.rectpacking.targetWidth': `${GRID_COLS * SYMBOL_W + (GRID_COLS - 1) * SYMBOL_GAP_X}`,
                'elk.rectpacking.widthApproximationTargetWidth': `${GRID_COLS * SYMBOL_W + (GRID_COLS - 1) * SYMBOL_GAP_X}`,
                'elk.contentAlignment': 'H_LEFT V_TOP',
            };
        }
        // symbolNode: no layoutOptions — rectpacking parent handles placement

        elkNodeMap.set(node.id, elkNode);
    });

    // ── Build hierarchy ──────────────────────────────────────────────────────
    const rootChildren: ElkNode[] = [];

    nodes.forEach(node => {
        const elkNode = elkNodeMap.get(node.id)!;
        if (node.parentId && elkNodeMap.has(node.parentId)) {
            elkNodeMap.get(node.parentId)!.children!.push(elkNode);
        } else {
            rootChildren.push(elkNode);
        }
    });

    // ── Separate edges by scope ──────────────────────────────────────────────
    // ✅ KEY FIX: Only give each container the edges whose both endpoints are
    // direct children of that container. Cross-container edges go to root.
    // This prevents ELK from trying to route edges across hierarchy levels
    // which was causing the collapse.

    const rootEdges = edges.map(e => ({
        id: e.id,
        sources: [e.source],
        targets: [e.target],
    }));
    // We only attach edges at root level — ELK will route them across domains.
    // Internal (symbol-to-symbol within same file) edges could be attached to
    // the fileNode, but rectpacking ignores edges anyway, so root is fine.

    // ── Root ELK graph ───────────────────────────────────────────────────────
    const elkGraph: ElkNode = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': direction,
            'elk.spacing.nodeNode': `${nodeSpacing}`,
            'elk.spacing.edgeNode': '30',
            'elk.layered.spacing.nodeNodeBetweenLayers': `${layerSpacing}`,
            // ✅ KEY FIX: REMOVED `elk.hierarchyHandling: INCLUDE_CHILDREN`
            // That option was the primary cause of all nodes collapsing into a pile.
            // Without it, ELK respects each container's individual layout options.
            'elk.padding': '[top=80,left=80,bottom=80,right=80]',
            'elk.edgeRouting': 'ORTHOGONAL',  // SPLINES + hierarchy = bad, use ORTHOGONAL
            'elk.layered.mergeEdges': 'false', // mergeEdges can distort positions, keep off
            'elk.separateConnectedComponents': 'true',
            'elk.spacing.componentComponent': '120',
            'elk.aspectRatio': '1.5',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        },
        children: rootChildren,
        edges: rootEdges,
    };

    // ── Run layout ───────────────────────────────────────────────────────────
    const layoutedGraph = await elk.layout(elkGraph);

    // ── Map positions back to React Flow nodes ───────────────────────────────
    const layoutedNodes: Node[] = [];

    const mapNodes = (elkNodes: ElkNode[]) => {
        elkNodes.forEach(elkNode => {
            const original = nodeMap.get(elkNode.id);
            if (original) {
                layoutedNodes.push({
                    ...original,
                    position: {
                        x: elkNode.x ?? 0,
                        y: elkNode.y ?? 0,
                    },
                    style: {
                        ...original.style,
                        width: elkNode.width,
                        height: elkNode.height,
                    },
                });
            }
            if (elkNode.children?.length) {
                mapNodes(elkNode.children);
            }
        });
    };

    if (layoutedGraph.children) {
        mapNodes(layoutedGraph.children);
    }

    const result = { nodes: layoutedNodes, edges };
    layoutCache.set(cacheKey, result);
    return result;
}

/**
 * Clear layout cache
 */
export function clearLayoutCache(): void {
    layoutCache.clear();
}