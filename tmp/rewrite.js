const fs = require('fs');

const path = '/home/unshakensoul/Documents/Projects and Notes/Projects/Architect AI/code-indexer-extension/webview/src/components/GraphCanvas.tsx';
let content = fs.readFileSync(path, 'utf8');

const targetStartText = '    // Build all nodes and edges from graph data (only when data changes)';
const targetStart = content.indexOf(targetStartText);

const targetEndText = '    }, [graphData, currentMode, collapsedNodes, toggleNodeCollapse, architectureSkeleton, functionTrace, selectedDomain, sortBy, maxDepth]);';
const targetEnd = content.indexOf(targetEndText, targetStart) + targetEndText.length;

if (targetStart === -1 || targetEnd < targetStart) {
    console.log("Could not find target range.");
    process.exit(1);
}

const originalBlock = content.substring(targetStart, targetEnd);

const replacement = `    // Stable callback ref to avoid re-running memo when function changes
    const toggleCollapseRef = useRef(toggleNodeCollapse);
    useEffect(() => {
        toggleCollapseRef.current = toggleNodeCollapse;
    }, [toggleNodeCollapse]);

    const handleToggleCollapse = useCallback((id: string) => {
        if (toggleCollapseRef.current) toggleCollapseRef.current(id);
    }, []);

    // 1. Expensive Part: Generate all base nodes and edges without taking collapsed state into account
    const { rawNodes, rawEdges, rawRedirections } = useMemo(() => {
        if (currentMode === 'architecture' && architectureSkeleton) {
            const nodes: Node[] = [];
            const structureEdges: Edge[] = [];

            const sortNodes = (nodes: SkeletonNodeData[]): SkeletonNodeData[] => {
                return [...nodes].sort((a, b) => {
                    switch (sortBy) {
                        case 'complexity': return (b.avgComplexity || 0) - (a.avgComplexity || 0);
                        case 'fragility': return (b.avgFragility || 0) - (a.avgFragility || 0);
                        case 'blastRadius': return (b.totalBlastRadius || 0) - (a.totalBlastRadius || 0);
                        case 'name': default: return a.name.localeCompare(b.name);
                    }
                }).map(node => ({ ...node, children: node.children ? sortNodes(node.children) : undefined }));
            };

            const filterNodes = (nodes: SkeletonNodeData[]): SkeletonNodeData[] => {
                if (selectedDomain === 'All') return nodes;
                return nodes.reduce<SkeletonNodeData[]>((acc, node) => {
                    if (node.domainName === selectedDomain || node.name === selectedDomain) {
                        acc.push(node);
                    } else if (node.children) {
                        const filteredChildren = filterNodes(node.children);
                        if (filteredChildren.length > 0) acc.push({ ...node, children: filteredChildren });
                    }
                    return acc;
                }, []);
            };

            let processedSkeleton = filterNodes(sortNodes(architectureSkeleton!.nodes));

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
                    if (maxDepth === 0 && depth > 0) return;
                    if (maxDepth === 1 && !n.isFolder) continue;

                    const effectiveDomain = (n.domainName && n.domainName !== parentDomain) ? n.domainName : n.name;
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
                                domain: effectiveDomain, status: calculateNodeHealth(n).status,
                                healthScore: calculateNodeHealth(n).healthScore, avgComplexity: n.avgComplexity,
                                coupling: calculateNodeHealth(n).coupling, symbolCount: n.symbolCount,
                                avgFragility: n.avgFragility, totalBlastRadius: n.totalBlastRadius
                            }
                        } as Partial<DomainNodeData> : {
                            filePath: n.id, symbolCount: n.symbolCount,
                            avgCoupling: 0, avgFragility: n.avgFragility,
                            totalBlastRadius: n.totalBlastRadius, label: n.name, domainName: n.domainName
                        } as Partial<FileNodeData>,
                    });

                    if (parentId && n.isFolder) {
                        structureEdges.push({
                            id: \`struct-\${parentId}-\${n.id}\`, source: parentId, target: n.id, type: 'smoothstep',
                            animated: false, style: { stroke: '#6b7280', strokeWidth: 2, strokeDasharray: '5,5', opacity: 0.5 }, label: 'contains'
                        });
                    }

                    if (maxDepth > 0 && n.children && n.children.length > 0) {
                        processRecursiveNodes(n.children!, n.id, n.domainName || parentDomain, depth + 1);
                    }
                }
            };
            processRecursiveNodes(processedSkeleton);

            const dependencyEdges: Edge[] = architectureSkeleton!.edges.map((e, i) => ({
                id: \`skel-edge-\${i}\`, source: e.source, target: e.target, type: 'default',
                label: e.weight > 1 ? e.weight.toString() : undefined, style: { strokeWidth: Math.min(e.weight, 5) }
            }));

            return { rawNodes: nodes, rawEdges: [...structureEdges, ...dependencyEdges], rawRedirections: [] };
        }

        if (currentMode === 'codebase' && graphData) {
            const codebaseNodes: Node[] = [];
            let unoptEdges: Edge[] = [];
            const metrics = calculateCouplingMetrics(graphData);
            const filteredSymbols = selectedDomain === 'All' ? (graphData.symbols ?? []) : (graphData.symbols ?? []).filter(s => (s.domain || 'unknown') === selectedDomain);
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
                        case 'fragility': return 0;
                        case 'blastRadius': return 0;
                        case 'name': default: return a.name.localeCompare(b.name);
                    }
                });
            };

            const rawRedirections: { symId: string; domId: string; fileId: string }[] = [];

            for (const [domain, fileMap] of domainFileMap) {
                const domainNodeId = \`domain:\${domain}\`;
                const domainSymbols = Array.from(fileMap.values()).flat();
                const avgComplexity = domainSymbols.length > 0 ? domainSymbols.reduce((s, sym) => s + (sym.complexity || 0), 0) / domainSymbols.length : 0;

                codebaseNodes.push({
                    id: domainNodeId, type: 'domainNode', position: { x: 0, y: 0 },
                    data: {
                        domain, health: {
                            domain, symbolCount: domainSymbols.length, avgComplexity, coupling: 0,
                            healthScore: Math.max(0, 100 - avgComplexity * 5),
                            status: avgComplexity > 15 ? 'critical' : avgComplexity > 8 ? 'warning' : 'healthy',
                        }
                    } as Partial<DomainNodeData>,
                });

                if (maxDepth === 0) continue;

                for (const [filePath, fileSymbols] of fileMap) {
                    const fileNodeId = \`${domain}:\${filePath}\`;
                    const fileCouplings = fileSymbols.map(s => metrics.get(\`\${s.filePath}:\${s.name}:\${s.range.startLine}\`)?.normalizedScore || 0).filter(score => score > 0);
                    const avgCoupling = fileCouplings.length > 0 ? fileCouplings.reduce((a, b) => a + b, 0) / fileCouplings.length : 0;

                    codebaseNodes.push({
                        id: fileNodeId, type: 'fileNode', position: { x: 0, y: 0 }, parentId: domainNodeId, extent: 'parent',
                        data: {
                            filePath, symbolCount: fileSymbols.length, avgCoupling,
                            label: filePath.split('/').pop() || filePath,
                        } as Partial<FileNodeData>,
                    });

                    const sorted = sortSymbols(fileSymbols);
                    for (const sym of sorted) {
                        const symId = \`\${sym.filePath}:\${sym.name}:\${sym.range.startLine}\`;
                        rawRedirections.push({ symId, domId: domainNodeId, fileId: fileNodeId });
                        if (maxDepth <= 1) continue;

                        const coupling = metrics.get(symId) || { nodeId: symId, inDegree: 0, outDegree: 0, cbo: 0, normalizedScore: 0, color: '#3b82f6' };
                        codebaseNodes.push({
                            id: symId, type: 'symbolNode', position: { x: 0, y: 0 }, parentId: fileNodeId, extent: 'parent',
                            data: { label: sym.name, symbolType: sym.type, complexity: sym.complexity, coupling, filePath: sym.filePath, line: sym.range.startLine } as SymbolNodeData,
                        });
                    }
                }
            }

            (graphData.edges ?? []).forEach((edge, index) => {
                unoptEdges.push({
                    id: \`cb-edge-\${index}\`, source: edge.source, target: edge.target, originalSource: edge.source, originalTarget: edge.target,
                    type: 'smoothstep', animated: edge.type === 'call',
                    style: { stroke: edge.type === 'call' ? '#3b82f6' : edge.type === 'import' ? '#10b981' : '#6b7280', strokeWidth: 1.5 }, edgeType: edge.type
                } as any);
            });

            return { rawNodes: codebaseNodes, rawEdges: unoptEdges, rawRedirections };
        }

        if (currentMode === 'trace' && functionTrace) {
            const nodes: Node[] = functionTrace.nodes.map(n => ({
                id: n.id, type: 'symbolNode', position: { x: 0, y: 0 },
                data: {
                    label: n.label, symbolType: n.type as any, complexity: n.complexity, blastRadius: n.blastRadius,
                    filePath: n.filePath, line: n.line, isSink: n.isSink, coupling: { color: n.isSink ? '#ef4444' : '#3b82f6' } as any
                } as SymbolNodeData,
            }));
            const edges: Edge[] = functionTrace.edges.map((e, i) => {
                const targetNode = functionTrace.nodes.find(n => n.id === e.target);
                const isTargetComplex = targetNode ? targetNode.complexity > 10 : false;
                return { id: \`trace-edge-\${i}\`, source: e.source, target: e.target, type: 'smoothstep', animated: true, style: { stroke: isTargetComplex ? '#ef4444' : '#3b82f6' } };
            });
            return { rawNodes: nodes, rawEdges: edges, rawRedirections: [] };
        }

        if (!graphData && currentMode !== 'codebase' && currentMode !== 'architecture') {
            return { rawNodes: [], rawEdges: [], rawRedirections: [] };
        }

        // Default Full Graph
        const metrics = calculateCouplingMetrics(graphData!);
        const domainNodes: Node[] = (graphData!.domains ?? []).map(d => ({
            id: \`domain:\${d.domain}\`, type: 'domainNode', position: { x: 0, y: 0 },
            data: { domain: d.domain, health: d.health } as Partial<DomainNodeData>,
        }));
        
        const fileNodes: Node[] = [];
        const symbolNodes: Node[] = [];
        const rawRedirections: { symId: string; domId: string; fileId: string }[] = [];
        const symbolsByDomain = new Map<string, Map<string, typeof graphData.symbols>>();
        
        (graphData!.symbols ?? []).forEach(s => {
            const domain = s.domain || 'unknown';
            if (!symbolsByDomain.has(domain)) symbolsByDomain.set(domain, new Map());
            const fileMap = symbolsByDomain.get(domain)!;
            if (!fileMap.has(s.filePath)) fileMap.set(s.filePath, []);
            fileMap.get(s.filePath)!.push(s);
        });

        for (const [domain, fileMap] of symbolsByDomain) {
            const domId = \`domain:\${domain}\`;
            for (const [filePath, symbols] of fileMap) {
                const fileId = \`\${domain}:\${filePath}\`;
                const avgCoupling = symbols.reduce((acc, s) => acc + (metrics.get(\`\${s.filePath}:\${s.name}:\${s.range.startLine}\`)?.normalizedScore || 0), 0) / (symbols.length || 1);
                fileNodes.push({ id: fileId, type: 'fileNode', position: { x: 0, y: 0 }, parentId: domId, extent: 'parent', data: { filePath, symbolCount: symbols.length, avgCoupling } as Partial<FileNodeData> });
                
                symbols.forEach(s => {
                    const symId = \`\${s.filePath}:\${s.name}:\${s.range.startLine}\`;
                    rawRedirections.push({ symId, domId, fileId });
                    symbolNodes.push({
                        id: symId, type: 'symbolNode', position: { x: 0, y: 0 }, parentId: fileId, extent: 'parent',
                        data: { label: s.name, symbolType: s.type, complexity: s.complexity, filePath: s.filePath, line: s.range.startLine, coupling: metrics.get(symId) || { color: '#3b82f6' } } as Partial<SymbolNodeData>
                    });
                });
            }
        }

        const unoptEdges: Edge[] = (graphData!.edges ?? []).map((e, index) => ({
            id: \`edge-\${index}\`, source: e.source, target: e.target, originalSource: e.source, originalTarget: e.target, type: 'smoothstep', animated: e.type === 'call', edgeType: e.type, style: { strokeWidth: 1.5 }
        } as any));

        return { rawNodes: [...domainNodes, ...fileNodes, ...symbolNodes], rawEdges: unoptEdges, rawRedirections };

    }, [graphData, currentMode, architectureSkeleton, functionTrace, selectedDomain, sortBy, maxDepth]);

    // 2. Cheap Part: Apply collars to generated nodes/edges and optimize only when needed
    const { collapsedNodesList, collapsedEdgesList } = useMemo(() => {
        const nodeRedirection = new Map<string, string>();
        if (rawRedirections) {
            rawRedirections.forEach(({ symId, domId, fileId }) => {
                if (collapsedNodes.has(domId)) nodeRedirection.set(symId, domId);
                else if (collapsedNodes.has(fileId)) nodeRedirection.set(symId, fileId);
            });
        }

        const processedNodes: Node[] = [];
        const visibleNodeIds = new Set<string>();

        rawNodes.forEach(node => {
            let isHidden = false;
            let currentParent = node.parentId;
            while (currentParent) {
                if (collapsedNodes.has(currentParent)) {
                    isHidden = true;
                    break;
                }
                const p = rawNodes.find(n => n.id === currentParent);
                currentParent = p?.parentId;
            }

            if (!isHidden) {
                const isCollapsed = collapsedNodes.has(node.id);
                processedNodes.push({
                    ...node,
                    data: {
                        ...node.data,
                        collapsed: isCollapsed,
                        onToggleCollapse: node.type !== 'symbolNode' ? () => handleToggleCollapse(node.id) : undefined
                    }
                });
                visibleNodeIds.add(node.id);
            }
        });

        const activeEdges: Edge[] = [];
        const uniqueEdges = new Set<string>();

        rawEdges.forEach(edge => {
            let src = (edge as any).originalSource ?? edge.source;
            let tgt = (edge as any).originalTarget ?? edge.target;

            if (nodeRedirection.has(src)) src = nodeRedirection.get(src)!;
            if (nodeRedirection.has(tgt)) tgt = nodeRedirection.get(tgt)!;

            if (src !== tgt && visibleNodeIds.has(src) && visibleNodeIds.has(tgt)) {
                const typeSuffix = (edge as any).edgeType ?? edge.type ?? 'default';
                const key = \`\${src}-\${tgt}-\${typeSuffix}\`;
                if (!uniqueEdges.has(key)) {
                    uniqueEdges.add(key);
                    activeEdges.push({ ...edge, source: src, target: tgt });
                }
            }
        });

        return {
            collapsedNodesList: processedNodes,
            collapsedEdgesList: (currentMode === 'codebase' || currentMode === 'full') ? optimizeEdges(activeEdges, 10000) : activeEdges
        };
    }, [rawNodes, rawEdges, rawRedirections, collapsedNodes, currentMode, handleToggleCollapse]);

    useEffect(() => {
        setAllNodes(collapsedNodesList);
        setAllEdges(collapsedEdgesList);
        setHasInitialFit(false);
    }, [collapsedNodesList, collapsedEdgesList]);`;

content = content.replace(originalBlock, replacement);
fs.writeFileSync(path, content, 'utf8');
console.log("Successfully rewrote component logic in GraphCanvas!");
