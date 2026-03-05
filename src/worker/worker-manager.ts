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

/** Requests queued before the worker has finished initializing */
interface QueuedRequest {
    request: WorkerRequest;
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
    timeoutMs?: number;
    startedAt: number;
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

    // READY handshake — resolves when initialize-complete arrives
    private readyPromise: Promise<void>;
    private readyResolve!: () => void;
    private readyReject!: (e: Error) => void;

    // Requests sent before the worker is ready are queued here
    private preReadyQueue: QueuedRequest[] = [];

    constructor(onRestart?: () => void) {
        this.restartCallback = onRestart || null;
        this.readyPromise = new Promise<void>((res, rej) => {
            this.readyResolve = res;
            this.readyReject = rej;
        });
    }

    /**
     * Start the worker.
     * Resolves once the worker signals initialize-complete.
     * No arbitrary timeout — we wait as long as the WASM/DB hydration needs.
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
            // Propagate startup error to readyPromise so callers don't hang
            this.readyReject(error);
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
                        // Reset the ready handshake for the new worker instance
                        this.readyPromise = new Promise<void>((res, rej) => {
                            this.readyResolve = res;
                            this.readyReject = rej;
                        });
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

        // Send initialize and wait for the ready handshake (no timeout — WASM can be slow)
        this.worker.postMessage({
            type: 'initialize',
            id: this.generateId(),
            storagePath
        });

        await this.readyPromise;
    }

    /**
     * Handle incoming messages from worker
     */
    private handleMessage(message: unknown): void {
        if (!isWorkerResponse(message)) {
            console.error('Invalid worker response:', message);
            return;
        }

        // Handle initialize-complete: mark ready, resolve the handshake, drain the queue
        if (message.type === 'initialize-complete' || message.type === 'ready') {
            if (!this.isReady) {
                this.isReady = true;
                this.readyResolve();
                console.log(`Worker ready. Draining ${this.preReadyQueue.length} queued request(s).`);
                this.drainPreReadyQueue();
            }
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
     * Flush all requests that arrived before the worker was ready
     */
    private drainPreReadyQueue(): void {
        const queued = this.preReadyQueue.splice(0);
        for (const item of queued) {
            // Adjust the timeout to account for the time already spent waiting
            const elapsedMs = Date.now() - item.startedAt;
            const remaining = (item.timeoutMs ?? this.REQUEST_TIMEOUT) - elapsedMs;
            if (remaining <= 0) {
                item.reject(new Error(`Request ${item.request.type} timed out while waiting for worker to become ready`));
                continue;
            }
            this.dispatchRequest(item.request, item.resolve, item.reject, remaining);
        }
    }

    /**
     * Send request to worker (public API)
     * If the worker isn't ready yet, the request is queued until it is.
     */
    private sendRequest(request: WorkerRequest, timeoutMs?: number): Promise<WorkerResponse> {
        if (!this.worker) {
            return Promise.reject(new Error('Worker not started'));
        }

        return new Promise<WorkerResponse>((resolve, reject) => {
            if (!this.isReady && request.type !== 'initialize') {
                // Queue request — will be dispatched once initialize-complete arrives
                this.preReadyQueue.push({
                    request,
                    resolve,
                    reject,
                    timeoutMs,
                    startedAt: Date.now(),
                });
                return;
            }
            this.dispatchRequest(request, resolve, reject, timeoutMs);
        });
    }

    /**
     * Actually wire the request into the worker and start its timeout clock
     */
    private dispatchRequest(
        request: WorkerRequest,
        resolve: (r: WorkerResponse) => void,
        reject: (e: Error) => void,
        timeoutMs?: number
    ): void {
        const timeout = setTimeout(() => {
            this.pendingRequests.delete(request.id);
            reject(new Error(`Request ${request.type} timed out`));
        }, timeoutMs ?? this.REQUEST_TIMEOUT);

        this.pendingRequests.set(request.id, { resolve, reject, timeout });
        this.worker!.postMessage(request);
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
    async configureAI(config: { groqApiKey?: string; geminiApiKey?: string; awsRegion?: string; bedrockModelId?: string; awsAccessKeyId?: string; awsSecretAccessKey?: string; aiProvider?: 'gemini' | 'bedrock' }): Promise<void> {
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
