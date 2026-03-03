import { memo, useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    useReactFlow,
    type Node,
    type Edge,
    type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import FileNode from './FileNode';
import SymbolNode from './SymbolNode';
import DomainNode from './DomainNode';
import ViewModeBar from './ViewModeBar';
import type { GraphData, DomainNodeData, FileNodeData, SymbolNodeData, SkeletonNodeData, VSCodeAPI } from '../types';
import type { ViewMode, FilterContext } from '../types/viewMode';
import { DEFAULT_RISK_THRESHOLDS } from '../types/viewMode';
import { useViewMode } from '../hooks/useViewMode';
import { useGraphStore } from '../stores/useGraphStore';
import { useFocusEngine } from '../hooks/useFocusEngine';
import { calculateCouplingMetrics } from '../utils/metrics';
import { applyElkLayout, clearLayoutCache } from '../utils/elk-layout';
import { optimizeEdges } from '../utils/performance';
import { applyViewMode as applyGraphFilter } from '../utils/graphFilter';
import { getRelatedNodes, clearRelationshipCache } from '../utils/relationshipDetector';

import { perfMonitor } from '../utils/performance-monitor';
import { applyBFSLayout } from '../utils/bfs-layout';
import { getDataProvider } from '../panel/dataProvider';

interface GraphCanvasProps {
    graphData: GraphData | null;
    vscode: VSCodeAPI;
    onNodeClick?: (nodeId: string) => void;
    searchQuery?: string;
}

const nodeTypes: NodeTypes = {
    fileNode: FileNode,
    symbolNode: SymbolNode,
    domainNode: DomainNode,
};

const GraphCanvas = ({ graphData, vscode, onNodeClick, searchQuery }: GraphCanvasProps) => {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [lockedNodeId, setLockedNodeId] = useState<string | null>(null); // For persistent highlighting
    const lastRightClick = useRef<number>(0);
    const [allNodes, setAllNodes] = useState<Node[]>([]);
    const [allEdges, setAllEdges] = useState<Edge[]>([]);
    const [isLayouting, setIsLayouting] = useState(false);



    // View mode state
    const {
        currentMode,
        switchMode,
        focusedNodeId,
        setFocusedNodeId,
        relatedNodeIds,
        setRelatedNodeIds,
        impactStats,
        setImpactStats,
    } = useViewMode(vscode, searchQuery);

    // Graph Store
    const { collapsedNodes, toggleNodeCollapse, architectureSkeleton, functionTrace, expandAll, collapseAll } = useGraphStore();

    // React Flow instance for focus engine
    const reactFlowInstance = useReactFlow();
    const { focusNode, clearFocus } = useFocusEngine(reactFlowInstance);


    // Track if we've done the initial fitView to prevent blinking
    const [miniMapVisible, setMiniMapVisible] = useState(true);
    const [hasInitialFit, setHasInitialFit] = useState(false);

    // Architecture Filtering & Sorting State
    const [selectedDomain, setSelectedDomain] = useState<string>('All');
    const [sortBy, setSortBy] = useState<'name' | 'complexity' | 'fragility' | 'blastRadius'>('name');

    const [wantsDefaultDomain, setWantsDefaultDomain] = useState(false);

    // Extract available domains from architecture skeleton and graph data
    const availableDomains = useMemo(() => {
        const domains = new Set<string>();

        if (currentMode === 'codebase' && graphData) {
            if (graphData.domains) {
                graphData.domains.forEach(d => domains.add(d.domain));
            }
            (graphData.symbols ?? []).forEach(s => {
                if (s.domain) domains.add(s.domain);
            });
        } else if (architectureSkeleton) {
            const traverse = (nodes: SkeletonNodeData[]) => {
                for (const n of nodes) {
                    // Priority 1: Explicitly classified domains
                    if (n.domainName) {
                        domains.add(n.domainName);
                    }

                    // Priority 2: Folder names (at depth 0 or 1) as proxy domains
                    // This handles projects without AI analysis gracefully.
                    if (n.isFolder && n.depth <= 1) {
                        domains.add(n.name);
                    }

                    if (n.children) traverse(n.children);
                }
            };

            traverse(architectureSkeleton.nodes);
        }

        return Array.from(domains).sort();
    }, [architectureSkeleton, graphData, currentMode]);

    // Default domain selection effect for codebase mode
    useEffect(() => {
        if (wantsDefaultDomain && currentMode === 'codebase' && availableDomains.length > 0) {
            setSelectedDomain(availableDomains[0]);
            setWantsDefaultDomain(false);
        }
    }, [wantsDefaultDomain, currentMode, availableDomains]);

    const [pendingMode, setPendingMode] = useState<ViewMode | null>(null);

    // BFS Tree Depth control (0: Domain, 1: File, 2: Symbol)
    const [maxDepth, setMaxDepth] = useState(1);

    // Zoom tier for progressive disclosure
    const [zoomTier, setZoomTier] = useState<'low' | 'medium' | 'high'>('medium');
    const zoomClass = `zoom-${zoomTier}`;

    // ── PERFORMANCE OPTIMIZATION UTILS ───────────────────────────────────────

    // Derive a stable key for collapsed nodes to prevent full topology rebuilds
    // on every toggle. Sets are compared by reference, so we use a string key.
    const collapsedKey = useMemo(
        () => Array.from(collapsedNodes).sort().join('|'),
        [collapsedNodes]
    );

    // Persistent mouse position for precise tooltip placement without re-renders
    const mousePos = useRef({ x: 0, y: 0 });
    useEffect(() => {
        const track = (e: MouseEvent) => {
            mousePos.current = { x: e.clientX, y: e.clientY };
        };
        window.addEventListener('mousemove', track, { passive: true });
        return () => window.removeEventListener('mousemove', track);
    }, []);

    // Throttle move events to reduce React re-renders during active pan/zoom
    const lastMoveTime = useRef(0);
    const onMove = useCallback((_e: any, viewport: any) => {
        const now = Date.now();
        if (now - lastMoveTime.current < 100) return;
        lastMoveTime.current = now;

        const z = viewport.zoom;
        const tier = z < 0.6 ? 'low' : z < 1.2 ? 'medium' : 'high';
        if (tier !== zoomTier) {
            setZoomTier(tier);
        }
    }, [zoomTier]);

    // Safety net: ensure codebase mode always starts expanded
    // (store's setViewMode clears collapsedNodes, but this catches edge cases like state restore)
    useEffect(() => {
        if (currentMode === 'codebase') {
            expandAll();
        }
    }, [currentMode, expandAll]);

    // ── STABLE ACTIONS ───────────────────────────────────────────────────────
    // These actions are stable references and won't cause child re-renders
    const handleToggleCollapse = useCallback((nodeId: string) => {
        toggleNodeCollapse(nodeId);
    }, [toggleNodeCollapse]);

    // ── DATA PREPARATION ──────────────────────────────────────────────────────

    // Memoized metrics - computation is stable for same graphData
    const couplingMetrics = useMemo(() => {
        if (!graphData) return new Map();
        return calculateCouplingMetrics(graphData);
    }, [graphData]);

    // 1. Architecture Mode Nodes/Edges
    const architectureTopology = useMemo(() => {
        if (currentMode !== 'architecture' || !architectureSkeleton) {
            return { nodes: [], edges: [] };
        }

        const nodes: Node[] = [];
        const structureEdges: Edge[] = [];

        // Helper to sort nodes recursively
        const sortNodes = (nodes: SkeletonNodeData[]): SkeletonNodeData[] => {
            return [...nodes].sort((a, b) => {
                switch (sortBy) {
                    case 'complexity': return (b.avgComplexity || 0) - (a.avgComplexity || 0);
                    case 'fragility': return (b.avgFragility || 0) - (a.avgFragility || 0);
                    case 'blastRadius': return (b.totalBlastRadius || 0) - (a.totalBlastRadius || 0);
                    case 'name':
                    default: return a.name.localeCompare(b.name);
                }
            }).map(node => ({
                ...node,
                children: node.children ? sortNodes(node.children) : undefined
            }));
        };

        // Helper to filter nodes recursively
        const filterNodes = (nodes: SkeletonNodeData[]): SkeletonNodeData[] => {
            if (selectedDomain === 'All') return nodes;
            return nodes.reduce<SkeletonNodeData[]>((acc, node) => {
                const isMatch = node.domainName === selectedDomain || node.name === selectedDomain;
                if (isMatch) acc.push(node);
                else if (node.children) {
                    const filteredChildren = filterNodes(node.children);
                    if (filteredChildren.length > 0) acc.push({ ...node, children: filteredChildren });
                }
                return acc;
            }, []);
        };

        const processedSkeleton = filterNodes(sortNodes(architectureSkeleton.nodes));

        const calculateNodeHealth = (n: SkeletonNodeData) => {
            const complexityScore = Math.max(0, 100 - (n.avgComplexity / 20) * 100);
            const fragilityScore = Math.max(0, 100 - (n.avgFragility / 50) * 100);
            const healthScore = Math.round(complexityScore * 0.6 + fragilityScore * 0.4);
            let status: 'healthy' | 'warning' | 'critical' = 'healthy';
            if (healthScore < 60) status = 'critical';
            else if (healthScore < 80) status = 'warning';
            return { healthScore, status, coupling: Math.min(1, n.avgFragility / 50) };
        };

        const processRecursiveNodes = (skeletonNodes: SkeletonNodeData[], parentId?: string, parentDomain?: string, depth = 0) => {
            for (const n of skeletonNodes) {
                if (maxDepth === 0 && depth > 0) continue;
                if (maxDepth === 1 && !n.isFolder) continue;

                const isCollapsed = collapsedNodes.has(n.id);
                const effectiveDomain = (n.domainName && n.domainName !== parentDomain) ? n.domainName : n.name;
                const nodeParentId = n.isFolder ? undefined : parentId;

                const healthInfo = calculateNodeHealth(n);

                nodes.push({
                    id: n.id,
                    type: n.isFolder ? 'domainNode' : 'fileNode',
                    position: { x: 0, y: 0 },
                    parentId: nodeParentId,
                    data: n.isFolder ? {
                        nodeId: n.id,
                        domain: effectiveDomain,
                        health: {
                            domain: effectiveDomain,
                            status: healthInfo.status,
                            healthScore: healthInfo.healthScore,
                            avgComplexity: n.avgComplexity,
                            coupling: healthInfo.coupling,
                            symbolCount: n.symbolCount,
                            avgFragility: n.avgFragility,
                            totalBlastRadius: n.totalBlastRadius
                        },
                        collapsed: isCollapsed,
                        onToggleCollapse: toggleNodeCollapse,
                    } as DomainNodeData : {
                        nodeId: n.id,
                        filePath: n.id,
                        symbolCount: n.symbolCount,
                        avgCoupling: 0,
                        avgFragility: n.avgFragility,
                        totalBlastRadius: n.totalBlastRadius,
                        collapsed: false,
                        label: n.name,
                        domainName: n.domainName
                    } as FileNodeData,
                });

                if (parentId && n.isFolder) {
                    structureEdges.push({
                        id: `struct-${parentId}-${n.id}`,
                        source: parentId,
                        target: n.id,
                        type: 'smoothstep',
                        style: { stroke: '#6b7280', strokeWidth: 2, strokeDasharray: '5,5', opacity: 0.5 },
                        label: 'contains'
                    });
                }

                if (maxDepth > 0 && !isCollapsed && n.children?.length) {
                    processRecursiveNodes(n.children, n.id, n.domainName || parentDomain, depth + 1);
                }
            }
        };

        processRecursiveNodes(processedSkeleton);

        const dependencyEdges: Edge[] = architectureSkeleton.edges.map((e, i) => ({
            id: `skel-edge-${i}`,
            source: e.source,
            target: e.target,
            style: { strokeWidth: Math.min(e.weight, 5) },
            label: e.weight > 1 ? e.weight.toString() : undefined
        }));

        return { nodes, edges: [...structureEdges, ...dependencyEdges] };
    }, [currentMode, architectureSkeleton, sortBy, selectedDomain, maxDepth, collapsedKey, toggleNodeCollapse]);

    // 2. Codebase Mode Nodes/Edges
    const codebaseTopology = useMemo(() => {
        if (currentMode !== 'codebase' || !graphData) {
            return { nodes: [], edges: [] };
        }

        const nodes: Node[] = [];
        const edges: Edge[] = [];

        const filteredSymbols = selectedDomain === 'All'
            ? (graphData.symbols ?? [])
            : (graphData.symbols ?? []).filter(s => (s.domain || 'unknown') === selectedDomain);

        const domainFileMap = new Map<string, Map<string, typeof graphData.symbols>>();
        for (const sym of filteredSymbols) {
            const domain = sym.domain || 'unknown';
            if (!domainFileMap.has(domain)) domainFileMap.set(domain, new Map());
            const fMap = domainFileMap.get(domain)!;
            if (!fMap.has(sym.filePath)) fMap.set(sym.filePath, []);
            fMap.get(sym.filePath)!.push(sym);
        }

        const sortSymbols = (syms: typeof graphData.symbols) => {
            return [...syms].sort((a, b) => {
                switch (sortBy) {
                    case 'complexity': return (b.complexity || 0) - (a.complexity || 0);
                    case 'name':
                    default: return a.name.localeCompare(b.name);
                }
            });
        };

        for (const [domain, fileMap] of domainFileMap) {
            const domainNodeId = `domain:${domain}`;
            const isDomainCollapsed = collapsedNodes.has(domainNodeId);
            const domainSymbols = Array.from(fileMap.values()).flat();
            const avgComplexity = domainSymbols.length > 0
                ? domainSymbols.reduce((s, sym) => s + (sym.complexity || 0), 0) / domainSymbols.length
                : 0;

            nodes.push({
                id: domainNodeId,
                type: 'domainNode',
                position: { x: 0, y: 0 },
                data: {
                    nodeId: domainNodeId,
                    domain,
                    health: {
                        domain, status: avgComplexity > 15 ? 'critical' : avgComplexity > 8 ? 'warning' : 'healthy',
                        healthScore: Math.max(0, 100 - avgComplexity * 5),
                        symbolCount: domainSymbols.length, avgComplexity, coupling: 0
                    },
                    collapsed: isDomainCollapsed,
                    onToggleCollapse: toggleNodeCollapse,
                } as DomainNodeData,
            });

            if (isDomainCollapsed || maxDepth === 0) continue;

            for (const [filePath, fileSymbols] of fileMap) {
                const fileNodeId = `${domain}:${filePath}`;
                const isFileCollapsed = collapsedNodes.has(fileNodeId);
                const fileCouplings = fileSymbols
                    .map(s => {
                        const key = `${s.filePath}:${s.name}:${s.range.startLine}`;
                        return couplingMetrics.get(key)?.normalizedScore || 0;
                    })
                    .filter(score => score > 0);
                const avgCoupling = fileCouplings.length > 0 ? fileCouplings.reduce((a, b) => a + b, 0) / fileCouplings.length : 0;

                nodes.push({
                    id: fileNodeId,
                    type: 'fileNode',
                    position: { x: 0, y: 0 },
                    parentId: domainNodeId,
                    extent: 'parent',
                    data: {
                        nodeId: fileNodeId,
                        filePath, symbolCount: fileSymbols.length, avgCoupling,
                        collapsed: isFileCollapsed,
                        onToggleCollapse: toggleNodeCollapse,
                        label: filePath.split('/').pop() || filePath,
                    } as FileNodeData,
                });

                if (isFileCollapsed || maxDepth <= 1) continue;

                const sorted = sortSymbols(fileSymbols);
                for (const sym of sorted) {
                    const symKey = `${sym.filePath}:${sym.name}:${sym.range.startLine}`;
                    nodes.push({
                        id: symKey,
                        type: 'symbolNode',
                        position: { x: 0, y: 0 },
                        parentId: fileNodeId,
                        extent: 'parent',
                        data: {
                            label: sym.name, symbolType: sym.type, complexity: sym.complexity,
                            coupling: couplingMetrics.get(symKey),
                            filePath: sym.filePath, line: sym.range.startLine,
                        } as SymbolNodeData,
                    });
                }
            }
        }

        // Edges for codebase
        const visibleNodeIds = new Set(nodes.map(n => n.id));
        const nodeRedirection = new Map<string, string>();
        (graphData.symbols ?? []).forEach(sym => {
            const symId = `${sym.filePath}:${sym.name}:${sym.range.startLine}`;
            const domId = `domain:${sym.domain || 'unknown'}`;
            const filId = `${sym.domain || 'unknown'}:${sym.filePath}`;
            if (collapsedNodes.has(domId) || maxDepth === 0) nodeRedirection.set(symId, domId);
            else if (collapsedNodes.has(filId) || maxDepth <= 1) nodeRedirection.set(symId, filId);
        });

        const uniqueEdgeKeys = new Set<string>();
        (graphData.edges ?? []).forEach((edge, index) => {
            let s = edge.source; let t = edge.target;
            if (nodeRedirection.has(s)) s = nodeRedirection.get(s)!;
            if (nodeRedirection.has(t)) t = nodeRedirection.get(t)!;
            if (s !== t && visibleNodeIds.has(s) && visibleNodeIds.has(t)) {
                const key = `${s}-${t}-${edge.type}`;
                if (!uniqueEdgeKeys.has(key)) {
                    uniqueEdgeKeys.add(key);
                    edges.push({
                        id: `cb-edge-${index}`, source: s, target: t, type: 'smoothstep',
                        animated: edge.type === 'call',
                        style: { stroke: edge.type === 'call' ? '#3b82f6' : edge.type === 'import' ? '#10b981' : '#6b7280', strokeWidth: 1.5 },
                    });
                }
            }
        });

        return { nodes, edges: optimizeEdges(edges, 10000) };
    }, [currentMode, graphData, couplingMetrics, sortBy, selectedDomain, maxDepth, collapsedKey, toggleNodeCollapse]);

    // 3. Trace Mode Nodes/Edges
    const traceTopology = useMemo(() => {
        if (currentMode !== 'trace' || !functionTrace) return { nodes: [], edges: [] };

        const nodes: Node[] = functionTrace.nodes.map(n => ({
            id: n.id, type: 'symbolNode', position: { x: 0, y: 0 },
            data: {
                label: n.label, symbolType: n.type as any, complexity: n.complexity,
                blastRadius: n.blastRadius, filePath: n.filePath, line: n.line, isSink: n.isSink,
                coupling: { color: n.isSink ? '#ef4444' : '#3b82f6' } as any
            } as SymbolNodeData,
        }));

        const edges: Edge[] = functionTrace.edges.map((e, i) => {
            const targetNode = functionTrace.nodes.find(node => node.id === e.target);
            const complexity = targetNode?.complexity ?? 0;
            return {
                id: `trace-edge-${i}`, source: e.source, target: e.target, type: 'smoothstep', animated: true,
                style: { stroke: complexity > 10 ? '#ef4444' : '#3b82f6' }
            };
        });

        return { nodes, edges };
    }, [currentMode, functionTrace]);

    // Combined topology state - changes ONLY when relevant mode data changes
    useEffect(() => {
        let currentTopology = { nodes: [] as Node[], edges: [] as Edge[] };
        if (currentMode === 'architecture') currentTopology = architectureTopology;
        else if (currentMode === 'codebase') currentTopology = codebaseTopology;
        else if (currentMode === 'trace') currentTopology = traceTopology;

        setAllNodes(currentTopology.nodes);
        setAllEdges(currentTopology.edges);
        setHasInitialFit(false);
    }, [currentMode, architectureTopology, codebaseTopology, traceTopology]);




    // Create stable dependency for relatedNodeIds (Set creates new reference each time)
    const relatedNodeIdsKey = useMemo(
        () => Array.from(relatedNodeIds).sort().join(','),
        [relatedNodeIds]
    );

    // Apply filtering based on view mode
    const { visibleNodes, visibleEdges } = useMemo(() => {
        perfMonitor.startTimer('filter');

        if (allNodes.length === 0) {
            return { visibleNodes: [], visibleEdges: [] };
        }

        // P4: Reconstruct the Set from the stable key string (same content, stable reference)
        // This prevents applyGraphFilter from re-running due to a new Set object every render.
        const stableRelatedNodeIds = relatedNodeIdsKey
            ? new Set(relatedNodeIdsKey.split(',').filter(Boolean))
            : new Set<string>();

        const context: FilterContext = {
            mode: currentMode,
            focusedNodeId,
            relatedNodeIds: stableRelatedNodeIds,
            riskThresholds: DEFAULT_RISK_THRESHOLDS,
            searchQuery: searchQuery || '',
        };

        const result = applyGraphFilter(allNodes, allEdges, context);

        // Deduplicate nodes by ID (Prevents the "stacking" ghost nodes seen in the UI)
        const uniqueNodesMap = new Map<string, Node>();
        result.visibleNodes.forEach(node => {
            if (!uniqueNodesMap.has(node.id)) {
                uniqueNodesMap.set(node.id, node);
            }
        });
        const finalNodes = Array.from(uniqueNodesMap.values());

        // Additionally filter by depth in codebase mode and prepare final sets
        let nodesToReturn = finalNodes;
        let edgesToReturn = result.visibleEdges;

        if (currentMode === 'codebase') {
            const depthFilteredNodes = finalNodes.filter(node => {
                if (maxDepth === 0) return node.type === 'domainNode';
                if (maxDepth === 1) return node.type === 'domainNode' || node.type === 'fileNode';
                return true; // maxDepth 2: All nodes
            });

            const depthFilteredNodeIds = new Set(depthFilteredNodes.map(n => n.id));
            const depthFilteredEdges = result.visibleEdges.filter(edge =>
                depthFilteredNodeIds.has(edge.source) && depthFilteredNodeIds.has(edge.target)
            );

            nodesToReturn = depthFilteredNodes;
            edgesToReturn = depthFilteredEdges;
        }

        // DEDUPLICATION: Combine overlapping edges for cleaner Trace/Codebase view
        if (currentMode === 'trace' || currentMode === 'codebase') {
            const uniqueEdgeMap = new Map<string, Edge>();
            edgesToReturn.forEach(edge => {
                const key = `${edge.source}->${edge.target}`;
                // Keep the first edge found (or prioritize one with specific properties if needed)
                if (!uniqueEdgeMap.has(key)) {
                    uniqueEdgeMap.set(key, edge);
                }
            });
            edgesToReturn = Array.from(uniqueEdgeMap.values());
        }

        const filterTime = perfMonitor.endTimer('filter');
        perfMonitor.recordMetrics({
            filterTime,
            nodeCount: nodesToReturn.length,
            edgeCount: edgesToReturn.length,
        });

        return { visibleNodes: nodesToReturn, visibleEdges: edgesToReturn };
    }, [allNodes, allEdges, currentMode, focusedNodeId, relatedNodeIdsKey, searchQuery, maxDepth]);

    // Handle search-driven focus (Only happens when searchQuery changes)
    useEffect(() => {
        if (searchQuery && searchQuery.length > 2 && visibleNodes.length > 0) {
            // Find first node that matches search
            const match = visibleNodes.find(n =>
                (n.data as any).name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                (n.data as any).label?.toLowerCase().includes(searchQuery.toLowerCase())
            );
            if (match) {
                focusNode(match.id);
            }
        }
    }, [searchQuery, focusNode]); // Only depend on searchQuery change

    // Apply layout when visible nodes change (debounced to prevent rapid re-layouts)
    useEffect(() => {
        if (visibleNodes.length === 0) {
            setNodes([]);
            setEdges([]);
            return;
        }

        // Debounce layout to prevent rapid re-calculations
        const layoutTimer = setTimeout(() => {
            let cancelled = false;

            const runLayout = async () => {
                setIsLayouting(true);
                perfMonitor.startTimer('layout');

                try {
                    let layoutedNodes: Node[];
                    let layoutedEdges: Edge[];

                    if (currentMode === 'trace') {
                        // Use BFS layout for trace mode
                        const rootNodeId = visibleNodes[0]?.id;
                        const result = applyBFSLayout(
                            visibleNodes,
                            visibleEdges,
                            rootNodeId,
                            'RIGHT',
                            true // forceGrid for trace
                        );
                        layoutedNodes = result.nodes;
                        layoutedEdges = result.edges;
                    } else {
                        const result = await applyElkLayout(
                            visibleNodes,
                            visibleEdges,
                            { viewMode: currentMode }
                        );
                        layoutedNodes = result.nodes;
                        layoutedEdges = result.edges;
                    }

                    if (cancelled) return; // Abort stale layout update

                    setNodes(layoutedNodes);
                    setEdges(layoutedEdges);

                    perfMonitor.endTimer('layout');
                } catch (error) {
                    if (cancelled) return;
                    console.error('Layout failed:', error);
                    // Fallback: use nodes without layout
                    setNodes(visibleNodes);
                    setEdges(visibleEdges);
                    perfMonitor.endTimer('layout');
                } finally {
                    if (!cancelled) {
                        setIsLayouting(false);
                    }
                }
            };

            runLayout();

            return () => {
                cancelled = true;
            };
        }, 150); // 150ms debounce

        return () => clearTimeout(layoutTimer);
    }, [visibleNodes, visibleEdges, currentMode, setNodes, setEdges]);

    // ⚡ BACKGROUND WARM: After graph settles, silently prefetch inspector data for
    // all visible domain + file nodes (capped at 20). These are the most-clicked nodes,
    // so they'll already be cached by the time the user clicks them.
    useEffect(() => {
        if (nodes.length === 0 || isLayouting) return;

        const warmTimer = setTimeout(async () => {
            const provider = getDataProvider(vscode);
            const topNodes = nodes
                .filter(n => n.type === 'domainNode' || n.type === 'fileNode')
                .slice(0, 10); // reduced cap to avoid flooding

            let alive = true;

            for (const node of topNodes) {
                if (!alive) break;
                const nodeType = node.type === 'domainNode' ? 'domain' : 'file';
                // Sequential fire-and-forget with yield behavior
                await provider.getAll(node.id, nodeType as any).catch(() => { });
                // Small gap to avoid starving the IPC/message bus
                await new Promise(r => setTimeout(r, 100));
            }

            return () => { alive = false; };
        }, 2000); // 2s after graph settles so layout isn't competing

        return () => clearTimeout(warmTimer);
    }, [nodes, isLayouting, vscode]);

    // Handle Right Click (Context Menu) for locking/unlocking highlights
    const handleNodeContextMenu = useCallback(
        (event: React.MouseEvent, node: Node) => {
            event.preventDefault(); // Prevent default browser context menu
            const now = Date.now();

            if (now - lastRightClick.current < 300) {
                // Double Right Click detected -> Lock Highlight
                setLockedNodeId(node.id);
            } else {
                // Single Right Click detected -> Unlock/Clear
                setLockedNodeId(null);
            }
            lastRightClick.current = now;
        },
        []
    );

    // Highlight nodes and edges on hover with rich aesthetics
    // Highlight nodes and edges on hover with rich aesthetics
    // OPTIMIZATION: Use CSS classes for highlighting to preserve reference equality for unconnected nodes

    // Ensure active/locked node actually exists in current view (prevents stale locks from dimming everything)
    const activeId = useMemo(() => {
        const candidateId = lockedNodeId || hoveredNodeId;
        if (!candidateId) return null;
        // Verify existence in current nodes list (O(n) but safe, or O(1) if map used - but nodes length is small enough usually)
        return nodes.some(n => n.id === candidateId) ? candidateId : null;
    }, [lockedNodeId, hoveredNodeId, nodes]);

    const hasActiveHighlight = !!activeId;

    // Identify connected nodes (Memoized)
    const connectedNodeIds = useMemo(() => {
        const ids = new Set<string>();
        if (activeId) {
            ids.add(activeId);
            edges.forEach(edge => {
                if (edge.source === activeId) ids.add(edge.target);
                if (edge.target === activeId) ids.add(edge.source);
            });
        }
        return ids;
    }, [activeId, edges]);

    const sortedNodes = useMemo(() => {
        return [...nodes].sort((a, b) => {
            if (a.type === 'domainNode' && b.type !== 'domainNode') return -1;
            if (a.type !== 'domainNode' && b.type === 'domainNode') return 1;
            return 0;
        });
    }, [nodes]);

    // Memoize interactive nodes with styles
    const interactiveNodes = useMemo(() => {
        if (!activeId) return sortedNodes;

        return sortedNodes.map(node => {
            const isHovered = node.id === hoveredNodeId;
            const isConnected = activeId ? connectedNodeIds.has(node.id) : false;

            // Highlight Logic:
            // Unconnected nodes return the same reference → React.memo prevents their re-render
            if (!isHovered && !isConnected) {
                return {
                    ...node,
                    className: '',
                    data: { ...node.data, isDimmed: true, isActive: false },
                    zIndex: node.type === 'fileNode' ? 10 : 1
                };
            }

            return {
                ...node,
                className: 'highlighted',
                data: {
                    ...node.data,
                    isDimmed: false,
                    isActive: true,
                    isClickable: true,
                },
                zIndex: isHovered ? 2000 : 1500,
            };
        });
    }, [sortedNodes, hoveredNodeId, activeId, connectedNodeIds]);

    const interactiveEdges = useMemo(() => {
        if (!activeId) return edges;

        const mappedEdges = edges.map((edge) => {
            const isOutgoing = edge.source === activeId;
            const isIncoming = edge.target === activeId;
            const isConnected = isOutgoing || isIncoming;
            const isStructural = edge.id.startsWith('struct-');

            // Pause animation for all edges when hovering (as requested)
            const baseEdge = { ...edge, animated: false };

            if (isConnected) {
                const highlightColor = isOutgoing ? '#38bdf8' : '#f59e0b'; // Light Blue or Amber

                return {
                    ...baseEdge,
                    className: 'highlighted',
                    type: 'default', // Bezier curves
                    style: {
                        ...edge.style,
                        stroke: isStructural ? '#ffffff' : highlightColor,
                        strokeWidth: 4,
                        strokeDasharray: '0',
                        opacity: 1, // Ensure visible
                        zIndex: 1000,
                    },
                };
            }

            return baseEdge;
        });

        // Sort: Non-highlighted first, Highlighted last (on top)
        return mappedEdges.sort((a, b) => {
            const aHighlight = a.className === 'highlighted';
            const bHighlight = b.className === 'highlighted';
            if (aHighlight && !bHighlight) return 1;
            if (!aHighlight && bHighlight) return -1;
            return 0;
        });
    }, [edges, activeId]);

    // Fit view only once when nodes first load (prevents blinking)
    useEffect(() => {
        if (nodes.length > 0 && !hasInitialFit && !isLayouting) {
            // Small delay to ensure layout is complete
            const fitTimer = setTimeout(() => {
                reactFlowInstance.fitView({ padding: 0.1, duration: 200 });
                setHasInitialFit(true);
            }, 100);
            return () => clearTimeout(fitTimer);
        }
    }, [nodes, hasInitialFit, isLayouting, reactFlowInstance]);



    // Tooltip State
    const [tooltipData, setTooltipData] = useState<{ x: number, y: number, content: any, type: string } | null>(null);
    const hoverTimer = useRef<NodeJS.Timeout | null>(null);

    // Handle node hover
    const handleNodeMouseEnter = useCallback((event: React.MouseEvent, node: Node) => {
        // Clear any pending hover triggers (debouncing)
        if (hoverTimer.current) clearTimeout(hoverTimer.current);

        const clientX = mousePos.current.x;
        const clientY = mousePos.current.y;
        const nodeData = node.data as any;

        // In codebase detailed mode (maxDepth === 2), disable hover highlight for domain and file
        // nodes — they cover large areas and cause frustrating accidental dimming of everything else.
        // Only symbol/function nodes trigger highlighting in this mode.
        const isDetailedCodebase = currentMode === 'codebase' && maxDepth === 2;
        const isContainerNode = node.type === 'domainNode' || node.type === 'fileNode';
        if (isDetailedCodebase && isContainerNode) {
            return;
        }

        // ⚡ HOVER PREFETCH: Start loading inspector data immediately on hover — no delay.
        // By the time the user clicks, the data is already cached → instant display.
        // Fire-and-forget: errors are silently ignored, they don't affect hover UX.
        const hoverNodeType = node.type === 'domainNode' ? 'domain'
            : node.type === 'fileNode' ? 'file'
                : 'symbol';
        getDataProvider(vscode).getAll(node.id, hoverNodeType as any).catch(() => { });

        // Determine hover delay based on node type and view mode
        // Domains in architecture/codebase mode get a longer delay to prevent unintentional highlighting when panning/sliding
        let delay = 150;
        if (node.type === 'domainNode' && (currentMode === 'architecture' || currentMode === 'codebase')) {
            delay = 600;
        }

        // Add delay before triggering highlight/tooltip to prevent flickering during mouse movement
        hoverTimer.current = setTimeout(() => {
            setHoveredNodeId(node.id);

            // Tooltip Logic
            const content: any = {};
            let hasContent = false;

            if (nodeData.complexity !== undefined || nodeData.avgComplexity !== undefined) {
                content.complexity = nodeData.complexity ?? nodeData.avgComplexity;
                hasContent = true;
            }
            if (nodeData.blastRadius !== undefined || nodeData.totalBlastRadius !== undefined) {
                content.blastRadius = nodeData.blastRadius ?? nodeData.totalBlastRadius;
                hasContent = true;
            }

            if (hasContent) {
                setTooltipData({
                    x: clientX,
                    y: clientY,
                    content,
                    type: node.type || 'node'
                });
            }
        }, delay);
    }, [currentMode, maxDepth]);

    const handleNodeMouseLeave = useCallback(() => {
        // Immediate clear on leave for responsiveness
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        setHoveredNodeId(null);
        setTooltipData(null);
    }, []);

    // Handle node click based on view mode
    const handleNodeClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            // Set local focus
            setFocusedNodeId(node.id);
            focusNode(node.id);

            // Also notify parent
            if (onNodeClick) {
                onNodeClick(node.id);
            }
        },
        [onNodeClick, setFocusedNodeId, focusNode]
    );



    // Handle node double click to open file
    const handleNodeDoubleClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            if (node.type === 'symbolNode' || node.type === 'fileNode' || node.type === 'file') {
                // Verify data exists
                const data = node.data as any;
                if (data.filePath) {
                    vscode.postMessage({
                        type: 'open-file',
                        filePath: data.filePath,
                        line: data.line || 0
                    });
                }
            }
        },
        [vscode]
    );

    // Handle mode change
    const handleModeChange = useCallback(
        (mode: ViewMode) => {
            if (mode === 'codebase' && currentMode !== 'codebase') {
                setPendingMode('codebase');
                return;
            } else if (mode === 'architecture' && currentMode !== 'architecture') {
                setSelectedDomain('All');
            }

            switchMode(mode);
            setFocusedNodeId(null);
            clearFocus();
        },
        [switchMode, setFocusedNodeId, clearFocus, currentMode]
    );

    const handleConfirmPendingMode = useCallback(() => {
        if (pendingMode === 'codebase') {
            // Set wantsDefaultDomain to true so the effect picks the first domain AFTER availableDomains updates for codebase mode
            setWantsDefaultDomain(true);
            switchMode('codebase');
            setFocusedNodeId(null);
            clearFocus();
        }
        setPendingMode(null);
    }, [pendingMode, switchMode, setFocusedNodeId, clearFocus]);

    const handleCancelPendingMode = useCallback(() => {
        setPendingMode(null);
    }, []);

    const miniMapNodeColor = useCallback((node: Node) => {
        if (node.type === 'domainNode') {
            const status = (node.data as DomainNodeData).health?.status;
            return status === 'healthy'
                ? '#10b981'
                : status === 'warning'
                    ? '#fbbf24'
                    : '#ef4444';
        }
        if (node.type === 'fileNode') {
            return '#3b82f6';
        }
        return (node.data as any).coupling?.color || '#6b7280';
    }, []);

    const isTraceModeEmpty = currentMode === 'trace' && !functionTrace;
    const isArchitectureModeEmpty = currentMode === 'architecture' && !architectureSkeleton;
    const isCodebaseModeEmpty = currentMode === 'codebase' && !graphData;

    let renderEmptyState = null;
    if (isTraceModeEmpty || isArchitectureModeEmpty || isCodebaseModeEmpty) {
        if (currentMode === 'trace') {
            renderEmptyState = (
                <div className="flex items-center justify-center w-full h-full">
                    <div className="text-center p-8 border-2 border-dashed border-white border-opacity-10 rounded-xl bg-black bg-opacity-20 max-w-md">
                        <div className="text-5xl mb-6">🔍</div>
                        <h2 className="text-xl font-bold mb-3 text-white">No Active Function Trace</h2>
                        <p className="text-sm opacity-70 mb-6 leading-relaxed">
                            To visualize a micro-trace, open a source file in the editor and click the
                            <span className="mx-1 px-1.5 py-0.5 rounded bg-blue-500 bg-opacity-20 text-blue-400 font-mono text-xs border border-blue-500 border-opacity-30">Trace</span>
                            CodeLens above any function definition.
                        </p>
                        <div className="text-xs opacity-50 italic">
                            Micro-traces help you navigate deep execution paths and identify sinks.
                        </div>
                    </div>
                </div>
            );
        } else {
            renderEmptyState = (
                <div className="flex items-center justify-center w-full h-full">
                    <div className="text-center">
                        <div className="text-lg font-semibold mb-2">No Graph Data</div>
                        <div className="text-sm opacity-70">
                            Index your workspace to visualize the code graph
                        </div>
                    </div>
                </div>
            );
        }
    } else if (nodes.length === 0 && !isLayouting) {
        if (selectedDomain !== 'All' &&
            ((currentMode === 'architecture' && architectureSkeleton) || (currentMode === 'codebase' && graphData))) {
            renderEmptyState = (
                <div className="flex items-center justify-center w-full h-full">
                    <div className="text-center">
                        <div className="text-lg font-semibold mb-2">No Matching Nodes</div>
                        <div className="text-sm opacity-70 mb-4">
                            The current filter (Domain: {selectedDomain}) matches no files in this view.
                        </div>
                        <button
                            onClick={() => setSelectedDomain('All')}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm transition-colors"
                        >
                            Reset Filter
                        </button>
                    </div>
                </div>
            );
        } else {
            renderEmptyState = (
                <div className="flex items-center justify-center w-full h-full">
                    <div className="text-center">
                        <div style={{ fontSize: '24px', marginBottom: '16px', color: 'var(--vscode-textLink-foreground)' }}>⟳</div>
                        <div className="text-sm opacity-70">Preparing Graph Visualization...</div>
                    </div>
                </div>
            );
        }
    }

    return (
        <div
            className={`w-full h-full relative flex flex-col graph-wrapper ${zoomClass} ${hasActiveHighlight ? 'has-highlight' : ''}`}
            style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            {/* View Mode Bar */}
            <ViewModeBar
                currentMode={currentMode}
                onModeChange={handleModeChange}
                maxDepth={maxDepth}
                onDepthChange={setMaxDepth}
                availableDomains={availableDomains}
                selectedDomain={selectedDomain}
                onSelectDomain={setSelectedDomain}
                sortBy={sortBy}
                onSortChange={setSortBy as any}
            />

            <div style={{ flex: 1, position: 'relative' }}>
                {renderEmptyState ? renderEmptyState : (
                    <ReactFlow
                        nodes={interactiveNodes}
                        edges={interactiveEdges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onNodeClick={handleNodeClick}
                        onNodeDoubleClick={handleNodeDoubleClick}
                        onNodeMouseEnter={handleNodeMouseEnter}
                        onNodeMouseLeave={handleNodeMouseLeave}
                        onNodeContextMenu={handleNodeContextMenu}
                        onPaneContextMenu={(e) => { e.preventDefault(); setLockedNodeId(null); }}
                        nodeTypes={nodeTypes}
                        minZoom={0.1}
                        maxZoom={2}
                        nodesDraggable={false}
                        nodesConnectable={false}
                        elementsSelectable={true}
                        onlyRenderVisibleElements={true}
                        elevateEdgesOnSelect={false}
                        zoomOnDoubleClick={false}
                        defaultEdgeOptions={{
                            type: 'default',
                        }}
                        onMove={onMove}
                    >
                        <Background gap={20} />
                        <Controls />
                        <MiniMap
                            nodeColor={miniMapNodeColor}
                            maskColor="rgba(0, 0, 0, 0.5)"
                            pannable={false}
                            zoomable={false}
                        />

                        {/* Legend */}
                        <div style={{
                            position: 'absolute',
                            bottom: '20px',
                            left: '20px',
                            backgroundColor: 'var(--vscode-editor-background)',
                            border: '1px solid var(--vscode-widget-border)',
                            padding: '12px',
                            borderRadius: '8px',
                            fontSize: '11px',
                            boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                            zIndex: 10,
                            opacity: 0.9,
                            color: 'var(--vscode-editor-foreground)',
                            pointerEvents: 'none'
                        }}>
                            <div style={{ fontWeight: 600, marginBottom: '8px', opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Relationships</div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                <div style={{ width: '24px', height: '2px', backgroundColor: '#6b7280', borderTop: '2px dashed #6b7280' }}></div>
                                <span>Hierarchy (Contains)</span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                <div style={{ width: '24px', height: '3px', backgroundColor: '#38bdf8' }}></div>
                                <span>Calls / Dependencies</span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div style={{ width: '24px', height: '3px', backgroundColor: '#f59e0b', boxShadow: '0 0 4px #f59e0b' }}></div>
                                <span>Active Path / Selection</span>
                            </div>
                        </div>
                    </ReactFlow>
                )}
            </div>

            {/* Layout Loading State */}
            {isLayouting && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-50 pointer-events-none">
                    <div className="text-white text-lg font-bold animate-pulse">
                        Calculating Layout...
                    </div>
                </div>
            )}

            {/* Pending Mode Modal */}
            {pendingMode === 'codebase' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-[9999]" style={{ zIndex: 9999 }}>
                    <div
                        className="p-6 rounded-xl max-w-sm text-center shadow-2xl backdrop-blur-sm shadow-black/50"
                        style={{
                            backgroundColor: 'var(--vscode-editor-background)',
                            border: '1px solid var(--vscode-widget-border)',
                            color: 'var(--vscode-editor-foreground)'
                        }}
                    >
                        <div className="text-3xl mb-3">⚠️</div>
                        <div className="text-lg font-bold mb-2">Computational Warning</div>
                        <p className="mb-6 opacity-80 text-sm leading-relaxed">
                            The Codebase view mode renders a highly detailed symbol-level graph.
                            If your project is large, this may take a while to process. Do you want to continue?
                        </p>
                        <div className="flex justify-center gap-3">
                            <button
                                onClick={handleCancelPendingMode}
                                className="px-5 py-2 rounded text-sm font-medium transition-all hover:opacity-80 border"
                                style={{
                                    backgroundColor: 'var(--vscode-button-secondaryBackground)',
                                    color: 'var(--vscode-button-secondaryForeground)',
                                    borderColor: 'var(--vscode-button-secondaryHoverBackground)'
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmPendingMode}
                                className="px-5 py-2 rounded text-sm font-medium transition-all hover:opacity-80"
                                style={{
                                    backgroundColor: 'var(--vscode-button-background)',
                                    color: 'var(--vscode-button-foreground)'
                                }}
                            >
                                Continue
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Global Tooltip */}
            {tooltipData && (
                <div
                    style={{
                        position: 'fixed',
                        top: tooltipData.y + 10,
                        left: tooltipData.x + 10,
                        backgroundColor: 'var(--vscode-editor-background)',
                        border: '1px solid var(--vscode-widget-border)',
                        borderRadius: '6px',
                        padding: '8px 12px',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
                        zIndex: 9999,
                        color: 'var(--vscode-editor-foreground)',
                        fontSize: '11px',
                        pointerEvents: 'none',
                    }}
                >
                    {tooltipData.content.complexity !== undefined && (
                        <div className="flex items-center gap-2 mb-1">
                            <span className="opacity-70">Complexity:</span>
                            <span className="font-bold">{tooltipData.content.complexity.toFixed(1)}</span>
                        </div>
                    )}
                    {tooltipData.content.blastRadius !== undefined && (
                        <div className="flex items-center gap-2">
                            <span className="opacity-70">Blast Radius:</span>
                            <span className="font-bold text-red-500">{tooltipData.content.blastRadius}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Global Styles for Zoom Levels (injected here) */}
            <style>{`
                /* Progressive Disclosure Logic */
                
                /* Low Zoom (< 0.6): Hide metadata, minimal view */
                .graph-wrapper.zoom-low .file-node-container .node-meta,
                .graph-wrapper.zoom-low .domain-node-container .node-meta,
                .graph-wrapper.zoom-low .symbol-node-container .node-label { 
                    display: none; 
                }
                
                /* Hover Dimming Logic */
                .graph-wrapper.has-highlight .react-flow__node:not(.highlighted) {
                    opacity: 0.55;
                    transition: opacity 0.2s ease;
                }
                
                .graph-wrapper.has-highlight .react-flow__edge:not(.highlighted) {
                    opacity: 0.35;
                    transition: opacity 0.2s ease;
                }
                
                .react-flow__node.highlighted {
                    filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.5));
                    transition: filter 0.2s ease;
                }
            `}</style>
        </div>
    );
};

GraphCanvas.displayName = 'GraphCanvas';

export default memo(GraphCanvas);
