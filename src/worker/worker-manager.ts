// Purpose: Worker manager for extension host
// Handles worker lifecycle, message routing, and timeout control
// Prevents runaway workers and resource exhaustion

import { Worker } from 'worker_threads';
import {
    WorkerRequest,
    WorkerResponse,
    isWorkerResponse,
    SymbolResult,
    IndexStats,
} from './message-protocol';
import { GraphExport, ArchitectureSkeleton, FunctionTrace } from '../db/database';

interface PendingRequest {
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

export class WorkerManager {
    private worker: Worker | null = null;
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private requestIdCounter: number = 0;
    private isReady: boolean = false;
    private readonly REQUEST_TIMEOUT = 30000; // 30 seconds
    private restartCallback: (() => void) | null = null;
    private workerPath: string | null = null;
    private storagePath: string | null = null;

    constructor(onRestart?: () => void) {
        this.restartCallback = onRestart || null;
    }

    /**
     * Start the worker
     */
    async start(workerPath: string, storagePath: string): Promise<void> {
        if (this.worker) {
            throw new Error('Worker already started');
        }

        this.workerPath = workerPath;
        this.storagePath = storagePath;
        this.worker = new Worker(workerPath);

        // Set up message handler
        this.worker.on('message', (message: unknown) => {
            this.handleMessage(message);
        });

        // Set up error handler
        this.worker.on('error', (error) => {
            console.error('Worker error:', error);
            // We don't verify here, let exit handler take care of restart
        });

        // Set up exit handler
        this.worker.on('exit', async (code) => {
            this.isReady = false;
            this.worker = null;

            if (code !== 0) {
                console.error(`Worker exited with code ${code}. Restarting...`);
                // Reject all pending requests
                this.rejectAllPending(new Error(`Worker exited with code ${code}`));

                // Attempt restart
                if (this.workerPath && this.storagePath) {
                    try {
                        console.log('Attempting to restart worker...');
                        await this.start(this.workerPath, this.storagePath);
                        console.log('Worker restarted successfully');

                        // Notify extension
                        if (this.restartCallback) {
                            this.restartCallback();
                        }
                    } catch (error) {
                        console.error('Failed to restart worker:', error);
                    }
                }
            } else {
                console.log('Worker exited cleanly');
            }
        });

        // Initialize the worker with storage path
        const response = await this.sendRequest({
            type: 'initialize',
            id: this.generateId(),
            storagePath
        }, 15000);

        if (response.type !== 'initialize-complete') {
            throw new Error('Worker initialization failed');
        }

        this.isReady = true;
    }

    /**
     * Handle incoming messages from worker
     */
    private handleMessage(message: unknown): void {
        if (!isWorkerResponse(message)) {
            console.error('Invalid worker response:', message);
            return;
        }

        // Handle ready message
        if (message.type === 'ready') {
            this.isReady = true;
            return;
        }

        // Find and resolve pending request
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(message.id);

            if (message.type === 'error') {
                pending.reject(new Error(message.error));
            } else {
                pending.resolve(message);
            }
        }
    }

    /**
     * Send request to worker
     */
    private sendRequest(request: WorkerRequest, timeoutMs?: number): Promise<WorkerResponse> {
        if (!this.worker || (!this.isReady && request.type !== 'initialize')) {
            return Promise.reject(new Error('Worker not ready'));
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(request.id);
                reject(new Error(`Request ${request.type} timed out`));
            }, timeoutMs || this.REQUEST_TIMEOUT);

            this.pendingRequests.set(request.id, { resolve, reject, timeout });
            this.worker!.postMessage(request);
        });
    }

    /**
     * Generate unique request ID
     */
    private generateId(): string {
        return `${Date.now()}-${this.requestIdCounter++}`;
    }

    /**
     * Parse a file
     */
    async parseFile(
        filePath: string,
        content: string,
        language: 'typescript' | 'python' | 'c'
    ): Promise<{ symbolCount: number; edgeCount: number }> {
        const response = await this.sendRequest({
            type: 'parse',
            id: this.generateId(),
            filePath,
            content,
            language,
        });

        if (response.type !== 'parse-complete') {
            throw new Error('Unexpected response type');
        }

        return {
            symbolCount: response.symbolCount,
            edgeCount: response.edgeCount,
        };
    }

    /**
     * Parse multiple files in batch for better cross-file edge resolution
     */
    async parseBatch(
        files: { filePath: string; content: string; language: 'typescript' | 'python' | 'c' }[]
    ): Promise<{ totalSymbols: number; totalEdges: number; filesProcessed: number }> {
        // Massive workspaces can take several minutes to parse and index initially.
        // We give this 10 minutes (600,000ms) to ensure it doesn't kill long-running jobs.
        const response = await this.sendRequest({
            type: 'parse-batch',
            id: this.generateId(),
            files,
        }, 600000);

        if (response.type !== 'parse-batch-complete') {
            throw new Error('Unexpected response type');
        }

        return {
            totalSymbols: response.totalSymbols,
            totalEdges: response.totalEdges,
            filesProcessed: response.filesProcessed,
        };
    }

    /**
     * Check if file needs re-indexing based on content hash
     */
    async checkFileHash(filePath: string, content: string): Promise<boolean> {
        const response = await this.sendRequest({
            type: 'check-file-hash',
            id: this.generateId(),
            filePath,
            content,
        });

        if (response.type !== 'file-hash-result') {
            throw new Error('Unexpected response type');
        }

        return response.needsReindex;
    }

    /**
     * Check multiple file hashes in batch
     */
    async checkFileHashBatch(files: { filePath: string; contentHash: string }[]): Promise<string[]> {
        const response = await this.sendRequest({
            type: 'check-file-hash-batch',
            id: this.generateId(),
            files,
        });

        if (response.type !== 'file-hash-batch-result') {
            throw new Error('Unexpected response type');
        }

        return response.pathsNeedingReindex;
    }

    /**
     * Delete symbols for a file
     */
    async deleteFileSymbols(filePath: string): Promise<void> {
        const response = await this.sendRequest({
            type: 'delete-file-symbols',
            id: this.generateId(),
            filePath,
        });

        if (response.type !== 'delete-file-symbols-complete') {
            throw new Error('Unexpected response type');
        }
    }

    /**
     * Export entire graph as JSON
     */
    async exportGraph(): Promise<GraphExport> {
        const response = await this.sendRequest({
            type: 'export-graph',
            id: this.generateId(),
        });

        if (response.type !== 'graph-export') {
            throw new Error('Unexpected response type');
        }

        return response.graph;
    }

    /**
     * Query symbols by name
     */
    async querySymbols(query: string): Promise<SymbolResult[]> {
        const response = await this.sendRequest({
            type: 'query-symbols',
            id: this.generateId(),
            query,
        });

        if (response.type !== 'query-result') {
            throw new Error('Unexpected response type');
        }

        return response.symbols;
    }

    /**
     * Query symbols by file
     */
    async queryFile(filePath: string): Promise<SymbolResult[]> {
        const response = await this.sendRequest({
            type: 'query-file',
            id: this.generateId(),
            filePath,
        });

        if (response.type !== 'query-result') {
            throw new Error('Unexpected response type');
        }

        return response.symbols;
    }

    /**
     * Clear index
     */
    async clearIndex(): Promise<void> {
        await this.sendRequest({
            type: 'clear',
            id: this.generateId(),
        });
    }

    /**
     * Send inspector request
     */
    async sendInspectorRequest(request: {
        type: any;
        id: string;
        requestId: string;
        nodeId: string;
        nodeType?: 'domain' | 'file' | 'symbol';
        action?: string;
        metric?: string;
    }): Promise<{
        type: string;
        data?: any;
        content?: string;
        model?: string;
        error?: string;
    }> {
        // AI actions need a much longer timeout — Gemini can take 120-180s
        // for complex symbols with large dependency graphs.
        const isAIRequest =
            request.type === 'inspector-ai-action' ||
            request.type === 'inspector-ai-why';
        const timeoutMs = isAIRequest ? 200000 : undefined; // 200s for AI, default for data

        const response = await this.sendRequest(request as any, timeoutMs);

        // Map worker response to simpler object for webview
        if (response.type === 'inspector-overview-result') {
            return { type: response.type, data: response.data };
        } else if (response.type === 'inspector-dependencies-result') {
            return { type: response.type, data: response.data };
        } else if (response.type === 'inspector-risks-result') {
            return { type: response.type, data: response.data };
        } else if (response.type === 'inspector-batch-result') {
            return { type: response.type, data: response.data };
        } else if (response.type === 'inspector-ai-result') {
            return { type: response.type, data: response.data };
        } else if (response.type === 'inspector-ai-why-result') {
            // Handle AI why result
            return {
                type: 'inspector-ai-why-result',
                data: response.content,
                model: response.model
            };
        } else if (response.type === 'error') {
            return { type: 'error', error: response.error };
        }

        throw new Error(`Unexpected inspector response: ${response.type}`);
    }

    /**
     * Refine graph with AI (Architect Pass)
     */
    async refineGraph(): Promise<{ refinedNodeCount: number; implicitLinkCount: number }> {
        const response = await this.sendRequest({
            type: 'refine-graph',
            id: this.generateId(),
        }, 120000); // 2 minute timeout for AI pass

        if (response.type !== 'refine-graph-complete') {
            throw new Error('Unexpected response type');
        }

        return {
            refinedNodeCount: response.refinedNodeCount,
            implicitLinkCount: response.implicitLinkCount,
        };
    }

    /**
     * Configure AI settings
     */
    async configureAI(config: { vertexProject?: string; groqApiKey?: string; geminiApiKey?: string; awsRegion?: string; bedrockModelId?: string; awsAccessKeyId?: string; awsSecretAccessKey?: string; aiProvider?: 'gemini' | 'bedrock' }): Promise<void> {
        const response = await this.sendRequest({
            type: 'configure-ai',
            id: this.generateId(),
            config
        });

        if (response.type !== 'configure-ai-complete') {
            throw new Error('Unexpected response type');
        }
    }

    /**
     * Get statistics
     */
    async getStats(): Promise<IndexStats> {
        const response = await this.sendRequest({
            type: 'stats',
            id: this.generateId(),
        });

        if (response.type !== 'stats-result') {
            throw new Error('Unexpected response type');
        }

        return response.stats;
    }

    /**
     * Shutdown worker
     */
    async shutdown(): Promise<void> {
        if (!this.worker) {
            return;
        }

        this.sendRequest({
            type: 'shutdown',
            id: this.generateId(),
        }).catch(() => {
            // Ignore errors during shutdown
        });

        // Force terminate after timeout
        setTimeout(() => {
            if (this.worker) {
                this.worker.terminate();
            }
        }, 1000);
    }

    /**
     * Get architecture skeleton (Macro View)
     */
    async getArchitectureSkeleton(refine: boolean = false): Promise<ArchitectureSkeleton> {
        const response = await this.sendRequest({
            type: 'get-architecture-skeleton',
            id: this.generateId(),
            refine,
        }, refine ? 120000 : undefined); // Longer timeout if refining with AI

        if (response.type !== 'architecture-skeleton') {
            throw new Error('Unexpected response type');
        }

        return response.skeleton;
    }

    /**
     * Trace function (Micro View)
     */
    async traceFunction(symbolId?: number, nodeId?: string): Promise<FunctionTrace> {
        const response = await this.sendRequest({
            type: 'trace-function',
            id: this.generateId(),
            symbolId,
            nodeId
        });

        if (response.type !== 'function-trace') {
            throw new Error('Unexpected response type');
        }

        return response.trace;
    }

    /**
     * Reject all pending requests
     */
    private rejectAllPending(error: Error): void {
        for (const [_id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
}
