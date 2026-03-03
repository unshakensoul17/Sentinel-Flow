// Types for graph data from extension
export interface GraphSymbol {
    id: number;
    name: string;
    type: 'function' | 'method' | 'class' | 'interface' | 'enum' | 'variable' | 'type';
    filePath: string;
    range: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    };
    complexity: number;
    domain?: string | null;
    // AI Metadata
    purpose?: string;
    impactDepth?: number;
    searchTags?: string[];
    fragility?: string;
}

export interface GraphEdge {
    id: number;
    source: string; // Format: "filePath:symbolName:line"
    target: string;
    type: 'call' | 'import' | 'extends' | 'implements';
    reason?: string;
}

export interface GraphFile {
    filePath: string;
    contentHash: string;
    lastIndexedAt: string;
}



// VS Code API for webview
export interface VSCodeAPI {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

declare global {
    interface Window {
        acquireVsCodeApi(): VSCodeAPI;
    }
}

// Message types between extension and webview
export type ExtensionMessage =
    | { type: 'graph-data'; data: GraphData }
    | { type: 'architecture-skeleton'; data: ArchitectureSkeleton }
    | { type: 'function-trace'; data: FunctionTrace }
    | { type: 'theme-changed'; theme: 'light' | 'dark' }
    | { type: 'filter-by-directory'; path: string }
    | { type: 'cache-invalidate' }
    | { type: 'error'; message: string };

export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'request-graph' }
    | { type: 'request-architecture-skeleton' }
    | { type: 'request-function-trace'; symbolId?: number; nodeId?: string }
    | { type: 'node-selected'; nodeId: string }
    | { type: 'export-image'; format: 'png' | 'svg' };

// Coupling metrics
export interface CouplingMetrics {
    nodeId: string;
    inDegree: number;
    outDegree: number;
    cbo: number; // Coupling Between Objects
    normalizedScore: number; // 0-1 range for color mapping
    color: string; // Hex color from gradient
}

// React Flow node data
export interface FileNodeData extends Record<string, unknown> {
    label?: string;
    filePath: string;
    symbolCount: number;
    avgCoupling: number;
    avgFragility?: number;
    totalBlastRadius?: number;
    collapsed: boolean;
    domainName?: string;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
    onToggleCollapse?: (nodeId: string) => void;
}

export interface FolderNodeData extends Record<string, unknown> {
    label: string;
    path: string;
    symbolCount: number;
    avgComplexity: number;
    avgFragility: number;
    totalBlastRadius: number;
    collapsed: boolean;
    domainName?: string;
    depth: number;
    onToggleCollapse: (nodeId: string) => void;
}

export interface SymbolNodeData extends Record<string, unknown> {
    label: string;
    symbolType: GraphSymbol['type'];
    complexity: number;
    blastRadius?: number;
    coupling?: CouplingMetrics;
    filePath: string;
    line: number;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
    isHighlighted?: boolean;
}

// Domain health metrics
export interface DomainHealth {
    domain: string;
    symbolCount: number;
    avgComplexity: number;
    coupling: number;
    healthScore: number;
    status: 'healthy' | 'warning' | 'critical';
}

// Domain node data
export interface DomainNodeData extends Record<string, unknown> {
    domain: string;
    health: DomainHealth;
    collapsed: boolean;
    onToggleCollapse?: (nodeId: string) => void;
}

// Updated graph data with domains
export interface GraphData {
    symbols: GraphSymbol[];
    edges: GraphEdge[];
    files: GraphFile[];
    domains: { domain: string; symbolCount: number; health: DomainHealth }[];
}

// Architecture Skeleton
export interface ArchitectureSkeleton {
    nodes: SkeletonNodeData[];
    edges: SkeletonEdge[];
}

export interface SkeletonNodeData {
    id: string; // Relative path
    name: string; // Basename or Semantic Domain Name
    type: 'file' | 'folder';
    symbolCount: number;
    avgComplexity: number;
    avgFragility: number;
    totalBlastRadius: number;
    isFolder: boolean;
    depth: number;
    domainName?: string;
    children?: SkeletonNodeData[];
    importPaths?: string[]; // Used for AI semantic pass
}

export interface SkeletonEdge {
    source: string; // path
    target: string; // path
    weight: number; // import/call count
}

// Function Trace
export interface FunctionTrace {
    symbolId: number;
    nodes: TraceNode[];
    edges: TraceEdge[];
}

export interface TraceNode {
    id: string; // "filePath:name:line" or similar
    label: string;
    type: string; // function, class, etc.
    filePath: string;
    line: number;
    isSink: boolean; // DB or API call
    depth: number; // relative to target
    blastRadius?: number;
    complexity: number;
}

export interface TraceEdge {
    source: string;
    target: string;
    type: 'call' | 'import';
}
