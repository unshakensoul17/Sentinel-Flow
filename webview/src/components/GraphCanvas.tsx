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

const GraphCanvas = memo(({ graphData, vscode, onNodeClick, searchQuery }: GraphCanvasProps) => {
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

    // Safety net: ensure codebase mode always starts expanded
    // (store's setViewMode clears collapsedNodes, but this catches edge cases like state restore)
    useEffect(() => {
        if (currentMode === 'codebase') {
            expandAll();
        }
    }, [currentMode, expandAll]);

    // Build all nodes and edges from graph data (only when data changes)
    useEffect(() => {
        const buildNodes = async () => {
            // Mode: Architecture (Macro View)
            if (currentMode === 'architecture' && architectureSkeleton) {
                const nodes: Node[] = [];
                const structureEdges: Edge[] = [];

                // Helper to sort nodes recursively
                const sortNodes = (nodes: SkeletonNodeData[]): SkeletonNodeData[] => {
                    return [...nodes].sort((a, b) => {
                        switch (sortBy) {
                            case 'complexity':
                                return (b.avgComplexity || 0) - (a.avgComplexity || 0);
                            case 'fragility':
                                return (b.avgFragility || 0) - (a.avgFragility || 0);
                            case 'blastRadius':
                                return (b.totalBlastRadius || 0) - (a.totalBlastRadius || 0);
                            case 'name':
                            default:
                                return a.name.localeCompare(b.name);
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
                        // Check for domain match or folder name match
                        const isMatch = node.domainName === selectedDomain || node.name === selectedDomain;

                        if (isMatch) {
                            // If this node matches, we keep it and its entire sub-hierarchy
                            acc.push(node);
                        } else if (node.children) {
                            // Otherwise, check if any of its children match
                            const filteredChildren = filterNodes(node.children);
                            if (filteredChildren.length > 0) {
                                // Keep this container node but with only matching children
                                acc.push({ ...node, children: filteredChildren });
                            }
                        }
                        return acc;
                    }, []);
                };

                // Apply Sorting & Filtering
                let processedSkeleton = sortNodes(architectureSkeleton!.nodes);
                processedSkeleton = filterNodes(processedSkeleton);

                // Helper to calculate health from node metrics
                const calculateNodeHealth = (n: SkeletonNodeData) => {
                    // 1. Complexity Score (Lower is better)
                    // limit 20 as "max reasonable average complexity"
                    const complexityScore = Math.max(0, 100 - (n.avgComplexity / 20) * 100);

                    // 2. Fragility/Coupling Score (Lower is better)
                    // limit 50 as "max reasonable average fragility"
                    const fragilityScore = Math.max(0, 100 - (n.avgFragility / 50) * 100);

                    // Weighted Average (60% Complexity, 40% Fragility)
                    const healthScore = Math.round(complexityScore * 0.6 + fragilityScore * 0.4);

                    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
                    if (healthScore < 60) status = 'critical';
                    else if (healthScore < 80) status = 'warning';

                    return {
                        healthScore,
                        status,
                        // Map fragility to a 0-1 scale for the "Coupling" display
                        coupling: Math.min(1, n.avgFragility / 50)
                    };
                };

                const processRecursiveNodes = (skeletonNodes: SkeletonNodeData[], parentId?: string, parentDomain?: string, depth = 0) => {
                    // Depth 0: Show only Top-Level Domains (recursion blocked below)
                    // Depth 1: Show Domains + Nested Folders (Files skipped)
                    // Depth 2: Show Everything

                    for (const n of skeletonNodes) {
                        // Filter Logic based on maxDepth
                        if (maxDepth === 0 && depth > 0) return; // Should not happen due to recursion guard, but safety
                        if (maxDepth === 1 && !n.isFolder) continue; // Skip files in Structure mode

                        const isCollapsed = collapsedNodes.has(n.id);

                        // Only use domainName if it's defined and NOT the same as the parent's domain
                        const effectiveDomain = (n.domainName && n.domainName !== parentDomain)
                            ? n.domainName
                            : n.name;

                        // Linked Hierarchy Logic:
                        // If it's a folder, it becomes a top-level node (no parentId) regardless of depth
                        // If it's a file, it stays inside its parent folder (parentId is preserved)
                        const nodeParentId = n.isFolder ? undefined : parentId;

                        nodes.push({
                            id: n.id,
                            type: n.isFolder ? 'domainNode' : 'fileNode',
                            position: { x: 0, y: 0 },
                            parentId: nodeParentId,
                            extent: n.isFolder ? undefined : 'parent',
                            data: n.isFolder ? {
                                domain: effectiveDomain,
                                health: {
                                    domain: effectiveDomain,
                                    status: calculateNodeHealth(n).status,
                                    healthScore: calculateNodeHealth(n).healthScore,
                                    avgComplexity: n.avgComplexity,
                                    coupling: calculateNodeHealth(n).coupling,
                                    symbolCount: n.symbolCount,
                                    avgFragility: n.avgFragility,
                                    totalBlastRadius: n.totalBlastRadius
                                },
                                collapsed: isCollapsed,
                                onToggleCollapse: () => toggleNodeCollapse(n.id),
                            } as DomainNodeData : {
                                filePath: n.id,
                                symbolCount: n.symbolCount,
                                avgCoupling: 0,
                                avgFragility: n.avgFragility,
                                totalBlastRadius: n.totalBlastRadius,
                                collapsed: false,
                                onToggleCollapse: undefined,
                                label: n.name,
                                domainName: n.domainName
                            } as FileNodeData,
                        });

                        // If parent exists and this is a folder, create a structural edge
                        if (parentId && n.isFolder) {
                            structureEdges.push({
                                id: `struct-${parentId}-${n.id}`,
                                source: parentId,
                                target: n.id,
                                type: 'smoothstep',
                                animated: false,
                                style: {
                                    stroke: '#6b7280',
                                    strokeWidth: 2,
                                    strokeDasharray: '5,5',
                                    opacity: 0.5
                                },
                                label: 'contains'
                            });
                        }

                        // Recursion Logic
                        // If maxDepth is 0, we do NOT recurse (showing only top level)
                        const shouldRecurse = maxDepth > 0 && !isCollapsed && n.children && n.children.length > 0;

                        if (shouldRecurse) {
                            processRecursiveNodes(n.children!, n.id, n.domainName || parentDomain, depth + 1);
                        }
                    }
                };

                processRecursiveNodes(processedSkeleton);

                const dependencyEdges: Edge[] = architectureSkeleton!.edges.map((e, i) => ({
                    id: `skel-edge-${i}`,
                    source: e.source,
                    target: e.target,
                    type: 'default',
                    label: e.weight > 1 ? e.weight.toString() : undefined,
                    style: { strokeWidth: Math.min(e.weight, 5) }
                }));

                setAllNodes(nodes);
                setAllEdges([...structureEdges, ...dependencyEdges]);
                return;
            }

            // Mode: Codebase (Detailed Symbol-Level Graph)
            // Like Architecture but drills down to individual symbols with real call/import edges.
            if (currentMode === 'codebase' && graphData) {
                const codebaseNodes: Node[] = [];
                const codebaseEdges: Edge[] = [];

                // Calculate coupling metrics for color coding
                const metrics = calculateCouplingMetrics(graphData);

                // Domain filtering
                const filteredSymbols = selectedDomain === 'All'
                    ? (graphData.symbols ?? [])
                    : (graphData.symbols ?? []).filter(s => (s.domain || 'unknown') === selectedDomain);

                // Group by domain → file → symbols
                const domainFileMap = new Map<string, Map<string, typeof graphData.symbols>>();
                for (const sym of filteredSymbols) {
                    const domain = sym.domain || 'unknown';
                    if (!domainFileMap.has(domain)) domainFileMap.set(domain, new Map());
                    const fMap = domainFileMap.get(domain)!;
                    if (!fMap.has(sym.filePath)) fMap.set(sym.filePath, []);
                    fMap.get(sym.filePath)!.push(sym);
                }

                // Sort symbols within each file
                const sortSymbols = (syms: typeof graphData.symbols) => {
                    return [...syms].sort((a, b) => {
                        switch (sortBy) {
                            case 'complexity': return (b.complexity || 0) - (a.complexity || 0);
                            case 'fragility': return 0; // symbols don't have fragility directly
                            case 'blastRadius': return 0;
                            case 'name':
                            default: return a.name.localeCompare(b.name);
                        }
                    });
                };

                // Build hierarchy
                for (const [domain, fileMap] of domainFileMap) {
                    const domainNodeId = `domain:${domain}`;
                    const isDomainCollapsed = collapsedNodes.has(domainNodeId);

                    // Create domain node
                    const domainSymbols = Array.from(fileMap.values()).flat();
                    const avgComplexity = domainSymbols.length > 0
                        ? domainSymbols.reduce((s, sym) => s + (sym.complexity || 0), 0) / domainSymbols.length
                        : 0;

                    codebaseNodes.push({
                        id: domainNodeId,
                        type: 'domainNode',
                        position: { x: 0, y: 0 },
                        data: {
                            domain,
                            health: {
                                domain,
                                symbolCount: domainSymbols.length,
                                avgComplexity,
                                coupling: 0,
                                healthScore: Math.max(0, 100 - avgComplexity * 5),
                                status: avgComplexity > 15 ? 'critical' : avgComplexity > 8 ? 'warning' : 'healthy',
                            },
                            collapsed: isDomainCollapsed,
                            onToggleCollapse: () => toggleNodeCollapse(domainNodeId),
                        } as DomainNodeData,
                    });

                    if (isDomainCollapsed || maxDepth === 0) continue;

                    for (const [filePath, fileSymbols] of fileMap) {
                        const fileNodeId = `${domain}:${filePath}`;
                        const isFileCollapsed = collapsedNodes.has(fileNodeId);

                        const fileCouplings = fileSymbols
                            .map(s => {
                                const key = `${s.filePath}:${s.name}:${s.range.startLine}`;
                                return metrics.get(key)?.normalizedScore || 0;
                            })
                            .filter(score => score > 0);
                        const avgCoupling = fileCouplings.length > 0
                            ? fileCouplings.reduce((a, b) => a + b, 0) / fileCouplings.length
                            : 0;

                        codebaseNodes.push({
                            id: fileNodeId,
                            type: 'fileNode',
                            position: { x: 0, y: 0 },
                            parentId: domainNodeId,
                            extent: 'parent',
                            data: {
                                filePath,
                                symbolCount: fileSymbols.length,
                                avgCoupling,
                                collapsed: isFileCollapsed,
                                onToggleCollapse: () => toggleNodeCollapse(fileNodeId),
                                label: filePath.split('/').pop() || filePath,
                            } as FileNodeData,
                        });

                        // Skip symbols if file is collapsed or depth <= 1
                        if (isFileCollapsed || maxDepth <= 1) continue;

                        // Create symbol nodes
                        const sorted = sortSymbols(fileSymbols);
                        for (const sym of sorted) {
                            const symKey = `${sym.filePath}:${sym.name}:${sym.range.startLine}`;
                            const coupling = metrics.get(symKey) || {
                                nodeId: symKey,
                                inDegree: 0,
                                outDegree: 0,
                                cbo: 0,
                                normalizedScore: 0,
                                color: '#3b82f6',
                            };

                            codebaseNodes.push({
                                id: symKey,
                                type: 'symbolNode',
                                position: { x: 0, y: 0 },
                                parentId: fileNodeId,
                                extent: 'parent',
                                data: {
                                    label: sym.name,
                                    symbolType: sym.type,
                                    complexity: sym.complexity,
                                    coupling,
                                    filePath: sym.filePath,
                                    line: sym.range.startLine,
                                } as SymbolNodeData,
                            });
                        }
                    }
                }

                // Build edges — redirect collapsed nodes
                const visibleNodeIds = new Set(codebaseNodes.map(n => n.id));
                const nodeRedirection = new Map<string, string>();

                (graphData.symbols ?? []).forEach(sym => {
                    const symbolId = `${sym.filePath}:${sym.name}:${sym.range.startLine}`;
                    const domainId = `domain:${sym.domain || 'unknown'}`;
                    const fileId = `${sym.domain || 'unknown'}:${sym.filePath}`;

                    if (collapsedNodes.has(domainId) || maxDepth === 0) {
                        nodeRedirection.set(symbolId, domainId);
                    } else if (collapsedNodes.has(fileId) || maxDepth <= 1) {
                        nodeRedirection.set(symbolId, fileId);
                    }
                });

                const uniqueEdgeKeys = new Set<string>();
                (graphData.edges ?? []).forEach((edge, index) => {
                    let source = edge.source;
                    let target = edge.target;

                    if (nodeRedirection.has(source)) source = nodeRedirection.get(source)!;
                    if (nodeRedirection.has(target)) target = nodeRedirection.get(target)!;

                    if (source !== target && visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
                        const key = `${source}-${target}-${edge.type}`;
                        if (!uniqueEdgeKeys.has(key)) {
                            uniqueEdgeKeys.add(key);
                            codebaseEdges.push({
                                id: `cb-edge-${index}`,
                                source,
                                target,
                                type: 'smoothstep',
                                animated: edge.type === 'call',
                                style: {
                                    stroke: edge.type === 'call' ? '#3b82f6' : edge.type === 'import' ? '#10b981' : '#6b7280',
                                    strokeWidth: 1.5,
                                },
                            });
                        }
                    }
                });

                const optimized = optimizeEdges(codebaseEdges, 10000);
                setAllNodes(codebaseNodes);
                setAllEdges(optimized);
                return;
            }


            if (currentMode === 'trace' && functionTrace) {
                const nodes: Node[] = functionTrace.nodes.map(n => ({
                    id: n.id,
                    type: 'symbolNode',
                    position: { x: 0, y: 0 }, // Let layout engine handle it
                    data: {
                        label: n.label,
                        symbolType: n.type as any,
                        complexity: n.complexity,
                        blastRadius: n.blastRadius,
                        filePath: n.filePath,
                        line: n.line,
                        isSink: n.isSink,
                        coupling: { color: n.isSink ? '#ef4444' : '#3b82f6' } as any
                    } as SymbolNodeData,
                }));

                const edges: Edge[] = functionTrace.edges.map((e, i) => {
                    const targetNode = functionTrace.nodes.find(n => n.id === e.target);
                    const isTargetComplex = targetNode ? targetNode.complexity > 10 : false;

                    return {
                        id: `trace-edge-${i}`,
                        source: e.source,
                        target: e.target,
                        type: 'smoothstep',
                        animated: true,
                        style: { stroke: isTargetComplex ? '#ef4444' : '#3b82f6' }
                    };
                });

                setAllNodes(nodes);
                setAllEdges(edges);
                return;
            }

            // Default Mode: Full Graph
            if (!graphData) {
                setAllNodes([]);
                setAllEdges([]);
                clearLayoutCache();
                clearRelationshipCache();
                return;
            }

            // Calculate coupling metrics
            const metrics = calculateCouplingMetrics(graphData);

            // Create domain nodes (top level)
            const domainNodes: Node[] = (graphData.domains ?? []).map((domainData) => {
                const nodeId = `domain:${domainData.domain}`;
                const isCollapsed = collapsedNodes.has(nodeId);

                return {
                    id: nodeId,
                    type: 'domainNode',
                    position: { x: 0, y: 0 },
                    data: {
                        domain: domainData.domain,
                        health: domainData.health,
                        collapsed: isCollapsed,
                        onToggleCollapse: () => toggleNodeCollapse(nodeId),
                    } as DomainNodeData,
                };
            });

            // Group symbols by domain and file
            const symbolsByDomain = new Map<string, Map<string, typeof graphData.symbols>>();
            (graphData.symbols ?? []).forEach((symbol) => {
                const domain = symbol.domain || 'unknown';
                if (!symbolsByDomain.has(domain)) {
                    symbolsByDomain.set(domain, new Map());
                }
                const fileMap = symbolsByDomain.get(domain)!;
                if (!fileMap.has(symbol.filePath)) {
                    fileMap.set(symbol.filePath, []);
                }
                fileMap.get(symbol.filePath)!.push(symbol);
            });

            // Create file and symbol nodes grouped by domain
            const fileNodes: Node[] = [];
            const symbolNodes: Node[] = [];

            for (const [domain, fileMap] of symbolsByDomain) {
                const domainNodeId = `domain:${domain}`;
                if (collapsedNodes.has(domainNodeId)) continue; // Optimization: Don't create children if collapsed

                for (const [filePath, symbols] of fileMap) {
                    const fileCouplings = symbols
                        .map((s) => {
                            const key = `${s.filePath}:${s.name}:${s.range.startLine}`;
                            return metrics.get(key)?.normalizedScore || 0;
                        })
                        .filter((score) => score > 0);

                    const avgCoupling =
                        fileCouplings.length > 0
                            ? fileCouplings.reduce((a, b) => a + b, 0) / fileCouplings.length
                            : 0;

                    // Create file node as child of domain
                    const fileNodeId = `${domain}:${filePath}`;
                    const isFileCollapsed = collapsedNodes.has(fileNodeId);

                    fileNodes.push({
                        id: fileNodeId,
                        type: 'fileNode',
                        position: { x: 0, y: 0 },
                        data: {
                            filePath,
                            symbolCount: symbols.length,
                            avgCoupling,
                            collapsed: isFileCollapsed,
                            onToggleCollapse: () => toggleNodeCollapse(fileNodeId),
                        } as FileNodeData,
                        parentId: domainNodeId,
                        extent: 'parent',
                    });

                    // If file is collapsed, skip symbols
                    if (isFileCollapsed) continue;

                    // Create symbol nodes as children of file nodes
                    symbols.forEach((symbol) => {
                        const key = `${symbol.filePath}:${symbol.name}:${symbol.range.startLine}`;
                        const coupling = metrics.get(key) || {
                            nodeId: key,
                            inDegree: 0,
                            outDegree: 0,
                            cbo: 0,
                            normalizedScore: 0,
                            color: '#3b82f6',
                        };

                        symbolNodes.push({
                            id: key,
                            type: 'symbolNode',
                            position: { x: 0, y: 0 },
                            data: {
                                label: symbol.name,
                                symbolType: symbol.type,
                                complexity: symbol.complexity,
                                coupling,
                                filePath: symbol.filePath,
                                line: symbol.range.startLine,
                            } as SymbolNodeData,
                            parentId: fileNodeId,
                            extent: 'parent',
                        });
                    });
                }
            }

            // Edge Redirection Logic for Full Graph
            const visibleNodeIds = new Set([
                ...domainNodes.map(n => n.id),
                ...fileNodes.map(n => n.id),
                ...symbolNodes.map(n => n.id)
            ]);

            const nodeRedirection = new Map<string, string>();
            (graphData.symbols ?? []).forEach(symbol => {
                const symbolId = `${symbol.filePath}:${symbol.name}:${symbol.range.startLine}`;
                const domainId = `domain:${symbol.domain || 'unknown'}`;
                const fileId = `${symbol.domain || 'unknown'}:${symbol.filePath}`;

                if (collapsedNodes.has(domainId)) {
                    nodeRedirection.set(symbolId, domainId);
                } else if (collapsedNodes.has(fileId)) {
                    nodeRedirection.set(symbolId, fileId);
                }
            });

            const processedEdges: Edge[] = [];
            const uniqueEdges = new Set<string>();

            (graphData.edges ?? []).forEach((edge, index) => {
                let source = edge.source;
                let target = edge.target;

                if (nodeRedirection.has(source)) source = nodeRedirection.get(source)!;
                if (nodeRedirection.has(target)) target = nodeRedirection.get(target)!;

                if (source !== target && visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
                    const key = `${source}-${target}-${edge.type}`;
                    if (!uniqueEdges.has(key)) {
                        uniqueEdges.add(key);
                        processedEdges.push({
                            id: `edge-${index}`,
                            source,
                            target,
                            type: 'smoothstep',
                            animated: edge.type === 'call',
                            style: {
                                stroke: edge.type === 'call' ? '#3b82f6' : edge.type === 'import' ? '#10b981' : '#6b7280',
                                strokeWidth: 1.5,
                            },
                        });
                    }
                }
            });

            const optimizedEdges = optimizeEdges(processedEdges, 10000);
            setAllNodes([...domainNodes, ...fileNodes, ...symbolNodes]);
            setAllEdges(optimizedEdges);


        };

        buildNodes();
        setHasInitialFit(false);
    }, [graphData, currentMode, collapsedNodes, toggleNodeCollapse, architectureSkeleton, functionTrace, selectedDomain, sortBy, maxDepth]);



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

                    setNodes(layoutedNodes);
                    setEdges(layoutedEdges);

                    perfMonitor.endTimer('layout');
                } catch (error) {
                    console.error('Layout failed:', error);
                    // Fallback: use nodes without layout
                    setNodes(visibleNodes);
                    setEdges(visibleEdges);
                    perfMonitor.endTimer('layout');
                } finally {
                    setIsLayouting(false);
                }
            };

            runLayout();
        }, 150); // 150ms debounce

        return () => clearTimeout(layoutTimer);
    }, [visibleNodes, visibleEdges, currentMode, setNodes, setEdges]);

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

    // Memoize interactive nodes with styles
    const interactiveNodes = useMemo(() => {
        const result = nodes.map(node => {
            const isHovered = node.id === hoveredNodeId;
            const isConnected = activeId ? connectedNodeIds.has(node.id) : false;

            // Highlight Logic:
            // 1. If NO node is hovered, ALL are active (default state).
            // 2. If a node IS hovered, only IT and its CONNECTED neighbors are active.
            // 3. Everything else is dimmed.
            const isDimmed = activeId !== null && !isHovered && !isConnected;
            const isActive = activeId === null || isHovered || isConnected;

            return {
                ...node,
                className: isHovered || isConnected ? 'highlighted' : '',
                data: {
                    ...node.data,
                    isDimmed,
                    isActive,
                    isClickable: true,
                },
                // Z-Index Management:
                // Hovered/Connected nodes pop to front (zIndex 1000+)
                // FileNodes generally above DomainNodes (zIndex 10 vs 1)
                zIndex: isHovered ? 2000 : (isConnected ? 1500 : (node.type === 'fileNode' ? 10 : 1)),
            };
        });

        // SORTING: Render DomainNodes FIRST (bottom), then FileNodes (top)
        // This ensures FileNodes are physically later in DOM, appearing on top of Domains even without z-index
        return result.sort((a, b) => {
            if (a.type === 'domainNode' && b.type !== 'domainNode') return -1;
            if (a.type !== 'domainNode' && b.type === 'domainNode') return 1;
            return 0;
        });
    }, [nodes, hoveredNodeId, activeId, connectedNodeIds]);

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

        const clientX = event.clientX;
        const clientY = event.clientY;
        const nodeData = node.data as any;

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
    }, [currentMode]);

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

    // Zoom Tier State for Progressive Disclosure (Throttled re-renders)
    const [zoomTier, setZoomTier] = useState<'low' | 'medium' | 'high'>('medium');

    // Zoom Level Classes matched to Tiers
    // < 0.6: Zoom Low (Icon + Name)
    // 0.6 - 1.2: Zoom Medium (Icon + Name + Symbol Count)
    // > 1.2: Zoom High (Icon + Name + Symbol Count (+ Ext details?))
    const zoomClass = `zoom-${zoomTier}`;

    const onMove = useCallback((_event: any, viewport: { x: number; y: number; zoom: number }) => {
        const z = viewport.zoom;
        let newTier: 'low' | 'medium' | 'high' = 'medium';

        if (z < 0.6) newTier = 'low';
        else if (z >= 0.6 && z < 1.2) newTier = 'medium';
        else newTier = 'high';

        setZoomTier(prev => prev !== newTier ? newTier : prev);
    }, []);

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

    // Memoize MiniMap nodeColor to prevent re-renders
    const miniMapNodeColor = useCallback((node: Node) => {
        if (node.type === 'domainNode') {
            const data = node.data as DomainNodeData;
            const status = data.health?.status || 'healthy';
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

    let renderEmptyState = null;

    const isTraceModeEmpty = currentMode === 'trace' && !functionTrace;
    const isArchitectureModeEmpty = currentMode === 'architecture' && !architectureSkeleton;
    const isCodebaseModeEmpty = currentMode === 'codebase' && !graphData;

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
        // CASE 1: Filtered results are empty (Only if a specific domain is selected)
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
            // CASE 2: Still Processing / Calculating Layout
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

    if (renderEmptyState) {
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
                    {renderEmptyState}
                </div>
            </div>
        );
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
                        pointerEvents: 'none' // Let clicks pass through if needed, but usually legend is just visual
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
});

GraphCanvas.displayName = 'GraphCanvas';

export default GraphCanvas;
