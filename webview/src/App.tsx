import { useState, useEffect, useCallback, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import GraphCanvas from './components/GraphCanvas';
import { InspectorPanel } from './components/inspector';
import { useInspectorStore } from './stores/useInspectorStore';
import { useGraphStore } from './stores/useGraphStore';
import type { GraphData, VSCodeAPI, ExtensionMessage, WebviewMessage } from './types';
import type { NodeType } from './types/inspector';
import { PerformanceMonitor } from './utils/performance';

// Get VS Code API
const vscode: VSCodeAPI = window.acquireVsCodeApi();

function App() {
    const {
        displayedGraphData,
        originalGraphData,
        isLoading,
        setGraphData,
        setArchitectureSkeleton,
        setFunctionTrace,
        setViewMode,
        filterByDirectory,
        viewMode,
        functionTrace,
        architectureSkeleton
    } = useGraphStore();

    // Local loading state for initial load or refresh
    const [isRefreshing, setIsRefreshing] = useState(false);

    const [showInspector, setShowInspector] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const fpsRef = useRef<HTMLDivElement>(null);

    // Get stable action references from store
    const selectNode = useInspectorStore((s) => s.selectNode);

    // Ref to track last clicked node to prevent duplicate updates
    const lastClickedNodeRef = useRef<string | null>(null);

    // Performance monitoring — use direct DOM mutation to avoid React re-renders
    useEffect(() => {
        const monitor = new PerformanceMonitor();
        monitor.start((currentFps) => {
            if (fpsRef.current) {
                fpsRef.current.textContent = `${currentFps} FPS`;
                fpsRef.current.style.backgroundColor =
                    currentFps >= 55 ? '#10b98150' : currentFps >= 30 ? '#fbbf2450' : '#ef444450';
                fpsRef.current.style.color =
                    currentFps >= 55 ? '#10b981' : currentFps >= 30 ? '#fbbf24' : '#ef4444';
            }
        });
        return () => monitor.stop();
    }, []);

    // Timeout state
    const [isTimeout, setIsTimeout] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Message handler from extension
    useEffect(() => {
        const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
            const message = event.data;

            if (message.type === 'error') {
                setErrorMessage(message.message);
                setIsRefreshing(false);
                setIsTimeout(false);
                return;
            }

            switch (message.type) {
                case 'graph-data':
                    if (message.data) {
                        setGraphData(message.data);
                        (window as any).graphData = message.data;
                        setIsRefreshing(false);
                        setIsTimeout(false); // Reset timeout on successful data load
                        setErrorMessage(null);
                    }
                    break;

                case 'architecture-skeleton':
                    if (message.data) {
                        setArchitectureSkeleton(message.data);
                        setErrorMessage(null);
                    }
                    break;

                case 'function-trace':
                    if (message.data) {
                        setFunctionTrace(message.data);
                        setViewMode('trace');
                        setErrorMessage(null);
                    }
                    break;

                case 'filter-by-directory':
                    if (message.path) {
                        filterByDirectory(message.path);
                    }
                    break;

                case 'theme-changed':
                    // Theme changes are handled by CSS variables
                    break;
            }
        };

        window.addEventListener('message', handleMessage);

        // Request graph data on mount
        const readyMessage: WebviewMessage = { type: 'ready' };
        vscode.postMessage(readyMessage);

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [setGraphData, setArchitectureSkeleton, setFunctionTrace, filterByDirectory, setViewMode]);

    // Load full graph data when switching to complex views if not already loaded
    useEffect(() => {
        // Prevent infinite loop by checking !isTimeout
        if ((viewMode === 'codebase') && !originalGraphData && !isRefreshing && !isTimeout && !errorMessage) {
            setIsRefreshing(true);
            setIsTimeout(false);
            setErrorMessage(null);
            vscode.postMessage({ type: 'request-graph' });
        }
    }, [viewMode, originalGraphData, isRefreshing, isTimeout, errorMessage]);

    // Determine node type from node ID and current state
    const getNodeType = useCallback((nodeId: string): NodeType => {
        if (nodeId.startsWith('domain:')) {
            return 'domain';
        }

        // Accurately resolve folder vs file in Architecture mode
        if (viewMode === 'architecture' && architectureSkeleton) {
            let foundFolder = false;
            let foundFile = false;
            const traverse = (nodes: any[]) => {
                for (const node of nodes) {
                    if (node.id === nodeId) {
                        if (node.isFolder) foundFolder = true;
                        else foundFile = true;
                        return;
                    }
                    if (node.children) traverse(node.children);
                }
            };
            traverse(architectureSkeleton.nodes);

            if (foundFolder) return 'domain';
            if (foundFile) return 'file';
        }

        // File nodes in codebase have format: domain:filePath (no symbol/line at end)
        // Symbol nodes have format: filePath:symbolName:line
        const parts = nodeId.split(':');
        if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
            return 'symbol';
        }
        return 'file';
    }, [viewMode, architectureSkeleton]);

    const handleNodeClick = useCallback(
        (nodeId: string) => {
            // Determine node type and update inspector store
            const nodeType = getNodeType(nodeId);
            selectNode(nodeId, nodeType);

            // Show inspector panel if hidden
            setShowInspector(true);

            // Notify extension
            vscode.postMessage({ type: 'node-selected', nodeId });
        },
        [selectNode, getNodeType]
    );

    const handleExport = useCallback((format: 'png' | 'svg') => {
        const message: WebviewMessage = {
            type: 'export-image',
            format,
        };
        vscode.postMessage(message);
    }, []);

    const handleRefresh = useCallback(() => {
        setIsRefreshing(true);
        setIsTimeout(false);
        setErrorMessage(null);
        // Request both graph data and skeleton to be safe
        vscode.postMessage({ type: 'request-graph' });
        vscode.postMessage({ type: 'request-architecture-skeleton' });
    }, []);

    const handleCloseInspector = useCallback(() => {
        setShowInspector(false);
    }, []);

    const handleFocusNode = useCallback(
        (nodeId: string) => {
            // Update inspector selection
            const nodeType = getNodeType(nodeId);
            selectNode(nodeId, nodeType);

            // Also trigger a click to focus the graph
            // The GraphCanvas should handle the actual focusing
            handleNodeClick(nodeId);
        },
        [getNodeType, selectNode, handleNodeClick]
    );

    const handleToggleInspector = useCallback(() => {
        setShowInspector((prev) => !prev);
    }, []);

    // Explicitly check if the required data for the current view mode is missing
    const isDataMissing = (() => {
        if (viewMode === 'architecture') return !architectureSkeleton;
        if (viewMode === 'trace') return false; // It's completely valid and expected for Trace to be empty initially
        // For codebase mode, we need the main graph data
        return !originalGraphData && !displayedGraphData;
    })();

    const showLoading = (isLoading || isRefreshing || isDataMissing) && !errorMessage && !isTimeout;

    // Timeout logic
    useEffect(() => {
        let timer: NodeJS.Timeout;
        if (showLoading) {
            timer = setTimeout(() => {
                console.log('Timeout triggered');
                setIsTimeout(true);
                setIsRefreshing(false); // Stop loading spinner
            }, 8000); // Reduced to 8 seconds
        }
        return () => clearTimeout(timer);
    }, [showLoading, isTimeout, errorMessage]);

    // Graph Empty Check
    const isGraphEmpty = !showLoading && !isTimeout && !errorMessage && (() => {
        if (viewMode === 'architecture') {
            return architectureSkeleton && architectureSkeleton.nodes.length === 0;
        }
        if (viewMode === 'trace') {
            return functionTrace && functionTrace.nodes.length === 0;
        }
        return displayedGraphData &&
            displayedGraphData.symbols.length === 0 &&
            displayedGraphData.files.length === 0 &&
            displayedGraphData.domains.length === 0;
    })();

    return (
        <div className="w-full h-full flex flex-col">
            {/* Toolbar */}
            <div
                className="flex items-center justify-between px-4 py-2 border-b"
                style={{
                    backgroundColor: 'var(--vscode-sideBar-background)',
                    borderColor: 'var(--vscode-panel-border)',
                }}
            >
                <div className="flex items-center gap-4">
                    <h1 className="text-lg font-bold">Code Graph Visualization</h1>
                    <input
                        type="text"
                        placeholder="Search symbols or AI tags..."
                        className="px-2 py-1 text-sm rounded ml-4"
                        style={{
                            background: 'var(--vscode-input-background)',
                            color: 'var(--vscode-input-foreground)',
                            border: '1px solid var(--vscode-input-border)',
                            minWidth: '250px',
                        }}
                        title="Type at least 3 characters to filter the graph"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery.length > 0 && searchQuery.length < 3 && (
                        <span style={{ fontSize: '11px', opacity: 0.6, marginLeft: '4px' }}>
                            {3 - searchQuery.length} more char{searchQuery.length === 2 ? '' : 's'}…
                        </span>
                    )}
                    {displayedGraphData && (
                        <div className="text-xs opacity-70">
                            {displayedGraphData.domains?.length || 0} domains · {displayedGraphData.symbols.length} symbols ·{' '}
                            {displayedGraphData.edges.length} edges
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {/* FPS Counter — uses ref for direct DOM updates */}
                    <div
                        ref={fpsRef}
                        className="text-xs px-2 py-1 rounded"
                        style={{
                            backgroundColor: '#10b98150',
                            color: '#10b981',
                        }}
                        title="Frames per second"
                    >
                        60 FPS
                    </div>

                    {/* Inspector Toggle */}
                    <button
                        onClick={handleToggleInspector}
                        className="px-3 py-1 text-xs rounded hover:bg-opacity-80"
                        style={{
                            backgroundColor: showInspector
                                ? 'var(--vscode-button-background)'
                                : 'var(--vscode-button-secondaryBackground)',
                            color: showInspector
                                ? 'var(--vscode-button-foreground)'
                                : 'var(--vscode-button-secondaryForeground)',
                        }}
                        title={showInspector ? 'Hide Inspector' : 'Show Inspector'}
                    >
                        📋
                    </button>

                    {/* Refresh Button */}
                    <button
                        onClick={handleRefresh}
                        className="px-3 py-1 text-xs rounded hover:bg-opacity-80"
                        style={{
                            backgroundColor: 'var(--vscode-button-background)',
                            color: 'var(--vscode-button-foreground)',
                        }}
                        disabled={isRefreshing}
                    >
                        {isRefreshing ? 'Loading...' : 'Refresh'}
                    </button>

                    {/* Export Button */}
                    <button
                        onClick={() => handleExport('png')}
                        className="px-3 py-1 text-xs rounded hover:bg-opacity-80"
                        style={{
                            backgroundColor: 'var(--vscode-button-secondaryBackground)',
                            color: 'var(--vscode-button-secondaryForeground)',
                        }}
                        disabled={!displayedGraphData}
                    >
                        Export PNG
                    </button>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">
                {/* Graph Canvas */}
                <div className="flex-1 overflow-hidden relative">
                    {errorMessage ? (
                        <div className="flex items-center justify-center w-full h-full">
                            <div className="text-center">
                                <div className="text-lg font-semibold mb-2 text-red-500">Error Loading Graph</div>
                                <div className="text-sm opacity-70 mb-4 text-red-400">
                                    {errorMessage}
                                </div>
                                <button
                                    onClick={handleRefresh}
                                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                                >
                                    Retry
                                </button>
                            </div>
                        </div>
                    ) : isTimeout ? (
                        <div className="flex items-center justify-center w-full h-full">
                            <div className="text-center">
                                <div className="text-lg font-semibold mb-2 text-yellow-500">Request Timed Out</div>
                                <div className="text-sm opacity-70 mb-4">
                                    The graph data took too long to load.
                                </div>
                                <button
                                    onClick={handleRefresh}
                                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                                >
                                    Retry
                                </button>
                            </div>
                        </div>
                    ) : showLoading ? (
                        <div className="flex items-center justify-center w-full h-full">
                            <div className="text-center">
                                <div className="text-lg font-semibold mb-2">Initializing Visualization...</div>
                                <div className="text-sm opacity-70">
                                    Loading graph data from workspace...
                                </div>
                            </div>
                        </div>
                    ) : isGraphEmpty ? (
                        <div className="flex items-center justify-center w-full h-full">
                            <div className="text-center max-w-md p-6 border border-dashed border-gray-500 rounded-lg">
                                <div className="text-lg font-semibold mb-2">No nodes to display</div>
                                <div className="text-sm opacity-70 mb-4">
                                    The workspace appears to be empty or not yet indexed.
                                    Please ensure you have indexed the workspace.
                                </div>
                                <button
                                    onClick={() => vscode.postMessage({ type: 'index-workspace' })}
                                    className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                                >
                                    Index Workspace
                                </button>
                            </div>
                        </div>
                    ) : (
                        <ReactFlowProvider>
                            <GraphCanvas
                                graphData={displayedGraphData}
                                vscode={vscode}
                                onNodeClick={handleNodeClick}
                                searchQuery={searchQuery}
                            />
                        </ReactFlowProvider>
                    )}
                </div>

                {/* Inspector Panel */}
                {showInspector && (
                    <InspectorPanel
                        vscode={vscode}
                        onClose={handleCloseInspector}
                        onFocusNode={handleFocusNode}
                    />
                )}
            </div>
        </div>
    );
}

export default App;
