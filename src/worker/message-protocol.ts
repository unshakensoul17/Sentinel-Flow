// Purpose: Typed message protocol for worker communication
// Ensures strict contracts between extension host and worker thread
// Prevents malformed requests and simplifies debugging

import { GraphExport, ArchitectureSkeleton, FunctionTrace } from '../db/database';

/**
 * Messages sent from extension host to worker
 */
export type WorkerRequest =
    | {
        type: 'parse';
        id: string;
        filePath: string;
        content: string;
        language: 'typescript' | 'python' | 'c';
    }
    | {
        type: 'initialize';
        id: string;
        storagePath: string;
    }
    | {
        type: 'parse-batch';
        id: string;
        files: { filePath: string; content: string; language: 'typescript' | 'python' | 'c' }[];
    }
    | {
        type: 'query-symbols';
        id: string;
        query: string;
    }
    | {
        type: 'query-file';
        id: string;
        filePath: string;
    }
    | {
        type: 'check-file-hash';
        id: string;
        filePath: string;
        content: string;
    }
    | {
        // Batch version: send all hashes in one round-trip, get back only paths that changed
        type: 'check-file-hash-batch';
        id: string;
        files: { filePath: string; contentHash: string }[];
    }
    | {
        // Delete all symbols for a file (used when file-watcher detects deletion)
        type: 'delete-file-symbols';
        id: string;
        filePath: string;
    }
    | {
        type: 'export-graph';
        id: string;
    }
    | {
        type: 'clear';
        id: string;
    }
    | {
        type: 'stats';
        id: string;
    }
    | {
        type: 'shutdown';
        id: string;
    }
    // AI Orchestrator message types
    | {
        type: 'ai-query';
        id: string;
        query: string;
        symbolId?: number;
        symbolName?: string;
        analysisType?: 'security' | 'refactor' | 'dependencies' | 'general';
    }
    | {
        type: 'ai-classify-intent';
        id: string;
        query: string;
    }
    | {
        type: 'configure-ai';
        id: string;
        config: {

            groqApiKey?: string;
            geminiApiKey?: string;
            awsRegion?: string;
            bedrockModelId?: string;
            awsAccessKeyId?: string;
            awsSecretAccessKey?: string;
            aiProvider?: 'gemini' | 'bedrock';
        };
    }
    | {
        type: 'mcp-tool-call';
        id: string;
        toolName: string;
        arguments: Record<string, unknown>;
    }
    | {
        type: 'get-context';
        id: string;
        symbolId: number;
    }
    // Inspector Panel message types
    | {
        type: 'inspector-overview';
        id: string;
        requestId: string;
        nodeId: string;
        nodeType: 'domain' | 'file' | 'symbol';
    }
    | {
        type: 'inspector-dependencies';
        id: string;
        requestId: string;
        nodeId: string;
        nodeType: 'domain' | 'file' | 'symbol';
    }
    | {
        type: 'inspector-risks';
        id: string;
        requestId: string;
        nodeId: string;
        nodeType: 'domain' | 'file' | 'symbol';
    }
    | {
        type: 'inspector-ai-action';
        id: string;
        requestId: string;
        nodeId: string;
        action: 'explain' | 'audit' | 'refactor' | 'optimize';
    }
    | {
        type: 'inspector-ai-why';
        id: string;
        requestId: string;
        nodeId: string;
        metric: string;
    }
    | {
        // Batched request: fetches overview + deps + risks in a single round-trip
        type: 'inspector-batch';
        id: string;
        requestId: string;
        nodeId: string;
        nodeType: 'domain' | 'file' | 'symbol';
    }
    | {
        // Signals that the index was refreshed — caches should be invalidated
        type: 'inspector-invalidate-cache';
        id: string;
    }
    | {
        type: 'refine-graph';
        id: string;
    }
    | {
        type: 'analyze-impact';
        id: string;
        nodeId: string;
    }
    | {
        type: 'refine-incremental';
        id: string;
        changedFiles: string[];  // File paths that were just re-indexed
    }
    | {
        type: 'get-architecture-skeleton';
        id: string;
        refine?: boolean;
    }
    | {
        type: 'trace-function';
        id: string;
        symbolId?: number;
        nodeId?: string;
    };

/**
 * Messages sent from worker to extension host
 */
export type WorkerResponse =
    | {
        type: 'parse-complete';
        id: string;
        symbolCount: number;
        edgeCount: number;
    }
    | {
        type: 'initialize-complete';
        id: string;
    }
    | {
        type: 'parse-batch-complete';
        id: string;
        totalSymbols: number;
        totalEdges: number;
        filesProcessed: number;
    }
    | {
        type: 'query-result';
        id: string;
        symbols: SymbolResult[];
    }
    | {
        type: 'file-hash-result';
        id: string;
        needsReindex: boolean;
        storedHash: string | null;
        currentHash: string;
    }
    | {
        // Returns only the file paths that need reindexing
        type: 'file-hash-batch-result';
        id: string;
        pathsNeedingReindex: string[];
    }
    | {
        type: 'delete-file-symbols-complete';
        id: string;
    }
    | {
        type: 'graph-export';
        id: string;
        graph: GraphExport;
    }
    | {
        type: 'stats-result';
        id: string;
        stats: IndexStats;
    }
    | {
        type: 'clear-complete';
        id: string;
    }
    | {
        type: 'error';
        id: string;
        error: string;
        stack?: string;
    }
    | {
        type: 'ready';
    }
    | {
        type: 'configure-ai-complete';
        id: string;
    }
    // AI Orchestrator response types
    | {
        type: 'ai-query-result';
        id: string;
        content: string;
        model: string;
        intent: {
            type: 'reflex' | 'strategic';
            confidence: number;
        };
        latencyMs: number;
        contextIncluded: boolean;
        neighborCount?: number;
    }
    | {
        type: 'ai-intent-result';
        id: string;
        intentType: 'reflex' | 'strategic';
        confidence: number;
        matchedPattern?: string;
    }
    | {
        type: 'mcp-tool-result';
        id: string;
        success: boolean;
        toolName: string;
        result?: unknown;
        error?: string;
    }
    | {
        type: 'context-result';
        id: string;
        symbol: SymbolResult | null;
        neighbors: SymbolResult[];
        incomingEdgeCount: number;
        outgoingEdgeCount: number;
    }
    // Inspector Panel response types
    | {
        type: 'inspector-overview-result';
        id: string;
        requestId: string;
        data: InspectorOverviewData;
    }
    | {
        type: 'inspector-dependencies-result';
        id: string;
        requestId: string;
        data: InspectorDependencyData;
    }
    | {
        type: 'inspector-risks-result';
        id: string;
        requestId: string;
        data: InspectorRiskData;
    }
    | {
        type: 'inspector-ai-result';
        id: string;
        requestId: string;
        data: InspectorAIResult;
    }
    | {
        type: 'inspector-ai-why-result';
        id: string;
        requestId: string;
        content: string;
        model: string;
    }
    | {
        // Batched response: all three data types in one message
        type: 'inspector-batch-result';
        id: string;
        requestId: string;
        data: {
            overview: InspectorOverviewData;
            deps: InspectorDependencyData;
            risks: InspectorRiskData;
        };
    }
    | {
        type: 'refine-graph-complete';
        id: string;
        refinedNodeCount: number;
        implicitLinkCount: number;
    }
    | {
        type: 'impact-result';
        id: string;
        sourceNodeId: string;
        affected: { nodeId: string; depth: number; impactType: string }[];
        totalAffected: number;
        riskLevel: 'low' | 'medium' | 'high';
    }
    | {
        type: 'refine-incremental-complete';
        id: string;
        refinedNodeCount: number;
        filesProcessed: number;
    }
    | {
        type: 'architecture-skeleton';
        id: string;
        skeleton: ArchitectureSkeleton;
    }
    | {
        type: 'function-trace';
        id: string;
        trace: FunctionTrace;
    };

/**
 * Symbol result structure
 */
export interface SymbolResult {
    id: number;
    name: string;
    type: string;
    filePath: string;
    range: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    };
    complexity: number;
}

/**
 * Index statistics
 */
export interface IndexStats {
    symbolCount: number;
    edgeCount: number;
    fileCount: number;
    lastIndexTime?: string;
}

/**
 * Inspector Panel data types
 */
export interface InspectorOverviewData {
    nodeType: 'domain' | 'file' | 'symbol';
    name: string;
    path: string;
    lastModified?: string;
    // Domain metrics
    healthPercent?: number;
    fileCount?: number;
    functionCount?: number;
    coupling?: number;
    // File metrics
    symbolCount?: number;
    importCount?: number;
    exportCount?: number;
    avgComplexity?: number;
    // Symbol metrics
    lines?: number;
    complexity?: number;
    fanIn?: number;
    fanOut?: number;
}

export interface InspectorDependencyItem {
    id: string;
    name: string;
    type: string;
    filePath: string;
}

export interface InspectorDependencyData {
    calls: InspectorDependencyItem[];
    calledBy: InspectorDependencyItem[];
    imports: InspectorDependencyItem[];
    usedBy: InspectorDependencyItem[];
}

export interface InspectorRiskData {
    level: 'low' | 'medium' | 'high';
    heatScore: number;
    warnings: string[];
}

export interface InspectorAIResult {
    action: string;
    content: string;
    model: string;  // Flexible to support various model names
    cached: boolean;
    loading: boolean;
    error?: string;
    patch?: {
        summary: string;
        impactedNodeCount: number;
        diff: string;
    };
}


/**
 * Type guard to check if message is a WorkerRequest
 */
export function isWorkerRequest(msg: unknown): msg is WorkerRequest {
    return (
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        'id' in msg &&
        typeof (msg as any).type === 'string'
    );
}

/**
 * Type guard to check if message is a WorkerResponse
 */
export function isWorkerResponse(msg: unknown): msg is WorkerResponse {
    return (
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        typeof (msg as any).type === 'string'
    );
}
