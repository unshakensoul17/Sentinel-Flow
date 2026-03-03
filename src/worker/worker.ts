// Purpose: Background worker for CPU-intensive tasks
// ALL parsing and database operations happen here
// Prevents VS Code UI freezing

import { parentPort } from 'worker_threads';
import { CodeIndexDatabase } from '../db/database';
import { TreeSitterParser } from './parser';
import { SymbolExtractor, ImportInfo, CallInfo } from './symbol-extractor';
import {
    WorkerRequest,
    WorkerResponse,
    isWorkerRequest,
    SymbolResult,
} from './message-protocol';
import { AIOrchestrator, createOrchestrator } from '../ai';
import { InspectorService } from './inspector-service';
import { ImpactAnalyzer } from './impact-analyzer';
import { StringRegistry } from './string-registry';
import { CompositeIndex, resolvePendingCalls, resolvePendingImports, PendingCall, PendingImport } from './composite-index';
import { NewSymbol } from '../db/schema';
import * as path from 'path';

class IndexWorker {
    private db: CodeIndexDatabase | null = null;
    private parser: TreeSitterParser;
    private extractor: SymbolExtractor;
    private isReady: boolean = false;
    private orchestrator: AIOrchestrator | null = null;
    private inspector: InspectorService | null = null;

    // Global symbol map for cross-file resolution
    private globalSymbolMap: Map<string, number> = new Map();

    constructor() {
        this.parser = new TreeSitterParser();
        this.extractor = new SymbolExtractor();
    }

    private resolvePath(p: string): string {
        if (!this.db) return p;
        const root = this.db.getWorkspaceRootHeuristic();
        if (p.startsWith(root)) return p;

        // Handle both "src/app..." and "/src/app..."
        const relativePath = p.startsWith('/') ? p.substring(1) : p;
        return path.join(root, relativePath);
    }

    /**
     * Initialize worker resources
     */
    async initialize(storagePath: string): Promise<void> {
        try {
            // Start memory monitoring
            this.startMemoryMonitor();

            // Initialize database in provided directory
            const dbPath = path.join(storagePath, 'index.db');
            this.db = await CodeIndexDatabase.create(dbPath);

            // Initialize tree-sitter parser
            await this.parser.initialize();

            // Initialize AI Orchestrator
            this.orchestrator = createOrchestrator(this.db);

            // Initialize Inspector Service
            this.inspector = new InspectorService(this.db, this.orchestrator);

            this.isReady = true;
            console.log('Worker: ready signal sent');

            // Send ready signal
            this.sendMessage({
                type: 'ready',
            });
        } catch (error) {
            console.error('Worker initialization failed:', error);
            if (error instanceof Error) {
                console.error('Stack:', error.stack);
            }
            throw error;
        }
    }

    /**
     * Start periodic memory monitoring
     */
    private startMemoryMonitor(): void {
        setInterval(() => {
            this.checkMemoryUsage();
        }, 5000); // Check every 5 seconds
    }

    /**
     * Check memory usage and exit if limit exceeded
     */
    private checkMemoryUsage(): void {
        const usage = process.memoryUsage();
        const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);

        // 1000MB limit
        if (heapUsedMB > 1000) {
            const error = `Memory limit exceeded: ${heapUsedMB}MB (limit: 1000MB)`;
            console.error(error);
            // Send explicit error message before exiting to ensure manager knows why
            this.sendMessage({
                type: 'error',
                id: 'system',
                error: error,
            });
            // Allow time for message to flush
            setTimeout(() => {
                process.exit(137); // Standard OOM exit code
            }, 100);
        }
    }

    /**
     * Handle incoming messages
     */
    handleMessage(request: WorkerRequest): void {
        if (request.type === 'initialize') {
            this.initialize(request.storagePath)
                .then(() => {
                    this.sendMessage({
                        type: 'initialize-complete',
                        id: request.id
                    });
                })
                .catch((error: Error) => {
                    this.sendError(request.id, `Initialization failed: ${error.message}`);
                });
            return;
        }

        if (!this.isReady) {
            this.sendError(request.id, 'Worker not initialized');
            return;
        }

        try {
            switch (request.type) {
                case 'parse':
                    this.handleParse(request.id, request.filePath, request.content, request.language);
                    break;

                case 'parse-batch':
                    this.handleParseBatch(request.id, request.files);
                    break;

                case 'query-symbols':
                    this.handleQuerySymbols(request.id, request.query);
                    break;

                case 'query-file':
                    this.handleQueryFile(request.id, request.filePath);
                    break;

                case 'check-file-hash':
                    this.handleCheckFileHash(request.id, request.filePath, request.content);
                    break;

                case 'check-file-hash-batch':
                    this.handleCheckFileHashBatch(request.id, request.files);
                    break;

                case 'delete-file-symbols':
                    this.handleDeleteFileSymbols(request.id, request.filePath);
                    break;

                case 'export-graph':
                    this.handleExportGraph(request.id);
                    break;

                case 'clear':
                    this.handleClear(request.id);
                    break;

                case 'stats':
                    this.handleStats(request.id);
                    break;

                case 'shutdown':
                    this.handleShutdown();
                    break;

                case 'ai-query':
                    this.handleAIQuery(request);
                    break;

                case 'ai-classify-intent':
                    this.handleAIClassifyIntent(request);
                    break;



                case 'get-context':
                    this.handleGetContext(request);
                    break;

                case 'configure-ai':
                    this.handleConfigureAI(request);
                    break;

                // Inspector Panel Handlers
                case 'inspector-overview':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.getOverview(request.nodeId, request.nodeType)
                        .then(data => this.sendMessage({
                            type: 'inspector-overview-result',
                            id: request.id,
                            requestId: request.requestId,
                            data
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-dependencies':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.getDependencies(request.nodeId, request.nodeType)
                        .then(data => this.sendMessage({
                            type: 'inspector-dependencies-result',
                            id: request.id,
                            requestId: request.requestId,
                            data
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-risks':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.getRisks(request.nodeId, request.nodeType)
                        .then(data => this.sendMessage({
                            type: 'inspector-risks-result',
                            id: request.id,
                            requestId: request.requestId,
                            data
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-ai-action':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.executeAIAction(request.nodeId, request.action)
                        .then(data => this.sendMessage({
                            type: 'inspector-ai-result',
                            id: request.id,
                            requestId: request.requestId,
                            data
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-ai-why':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.explainRisk(request.nodeId, request.metric)
                        .then(content => this.sendMessage({
                            type: 'inspector-ai-why-result',
                            id: request.id,
                            requestId: request.requestId,
                            content,
                            model: 'groq'
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                // Batched inspector request: overview + deps + risks in one round-trip
                case 'inspector-batch':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    Promise.all([
                        this.inspector.getOverview(request.nodeId, request.nodeType),
                        this.inspector.getDependencies(request.nodeId, request.nodeType),
                        this.inspector.getRisks(request.nodeId, request.nodeType),
                    ]).then(([overview, deps, risks]) => this.sendMessage({
                        type: 'inspector-batch-result',
                        id: request.id,
                        requestId: request.requestId,
                        data: { overview, deps, risks },
                    })).catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-invalidate-cache':
                    // No-op on worker side — cache lives in webview only
                    this.sendMessage({ type: 'clear-complete', id: request.id });
                    break;

                case 'refine-graph':
                    this.handleRefineGraph(request.id);
                    break;

                case 'analyze-impact':
                    this.handleAnalyzeImpact(request.id, request.nodeId);
                    break;

                case 'refine-incremental':
                    this.handleRefineIncremental(request.id, request.changedFiles);
                    break;

                case 'get-architecture-skeleton':
                    this.handleGetArchitectureSkeleton(request.id, request.refine);
                    break;

                case 'trace-function':
                    this.handleTraceFunction(request.id, request.symbolId, request.nodeId);
                    break;

                default:
                    this.sendError((request as any).id, `Unknown request type: ${(request as any).type}`);
            }
        } catch (error) {
            this.sendError(
                request.id,
                error instanceof Error ? error.message : String(error),
                error instanceof Error ? error.stack : undefined
            );
        }
    }

    /**
     * Parse a single file and store symbols + edges.
     * Uses the binary pipeline (StringRegistry + CompositeIndex) for O(1) edge resolution.
     */
    private handleParse(
        id: string,
        filePath: string,
        content: string,
        language: 'typescript' | 'python' | 'c'
    ): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        // ── Extract: new binary pipeline API ──────────────────────────────
        const tree = this.parser.parse(content, language);
        const registry = new StringRegistry();
        const result = this.extractor.extract(tree, filePath, language, registry);

        // ── Persist symbols ───────────────────────────────────────────────
        this.db.deleteSymbolsByFile(filePath);
        const symbolIds = this.db.insertSymbols(result.symbols);

        // Build CompositeIndex from inserted symbols so we can do O(1) edge resolution
        const index = new CompositeIndex();
        for (let i = 0; i < result.symbols.length; i++) {
            const sym = result.symbols[i];
            const dbId = symbolIds[i];
            if (!dbId) continue;
            index.register({
                dbId,
                nameId: registry.intern(sym.name),
                pathId: registry.intern(sym.filePath),
                typeId: registry.intern(sym.type),
                line: sym.rangeStartLine,
            });
            // Keep globalSymbolMap in sync for any legacy code still reading it
            const key = `${sym.filePath}:${sym.name}:${sym.rangeStartLine - 1}`;
            this.globalSymbolMap.set(key, dbId);
        }

        // ── Fix up provisional caller IDs ─────────────────────────────────
        for (const call of result.pendingCalls) {
            if (call.callerDbId < 0) {
                const idx = Math.abs(call.callerDbId) - 1;
                const realId = symbolIds[idx];
                if (realId !== undefined) { call.callerDbId = realId; }
            }
        }

        // ── Resolve relative import source paths ─────────────────────────
        const snapshot = registry.exportSnapshot();
        for (const imp of result.pendingImports) {
            const moduleStr = registry.resolve(imp.sourcePathId);
            if (moduleStr && !moduleStr.startsWith('/')) {
                const normalized = moduleStr.replace(/^\.\//, '').replace(/\.(ts|tsx|js|jsx)$/, '');
                // First check against the registry (already-indexed paths)
                for (let i = 0; i < snapshot.length; i++) {
                    const p = snapshot[i];
                    if (p.startsWith('/') && p.replace(/\.(ts|tsx|js|jsx)$/, '').endsWith(normalized)) {
                        imp.sourcePathId = i;
                        break;
                    }
                }
                // Also check globalSymbolMap keys for cross-file paths from other parse sessions
                if (registry.resolve(imp.sourcePathId) === moduleStr) {
                    for (const key of this.globalSymbolMap.keys()) {
                        const keyPath = key.substring(0, key.indexOf(':'));
                        if (keyPath.replace(/\.(ts|tsx|js|jsx)$/, '').endsWith(normalized)) {
                            imp.sourcePathId = registry.intern(keyPath);
                            // Rebuild index entry for this path if not already present
                            break;
                        }
                    }
                }
            }
        }

        // ── Build supplementary index from globalSymbolMap for cross-file resolution ──
        // Register already-indexed symbols from other files so import/call edges can resolve
        const registeredPaths = new Set<number>();
        for (const sym of result.symbols) {
            registeredPaths.add(registry.intern(sym.filePath));
        }
        // Walk globalSymbolMap and register any symbol NOT in the current file
        for (const [key, dbId] of this.globalSymbolMap) {
            const colonIdx = key.indexOf(':');
            const keyPath = key.substring(0, colonIdx);
            const rest = key.substring(colonIdx + 1);
            const colonIdx2 = rest.indexOf(':');
            const symName = rest.substring(0, colonIdx2);
            const lineStr = rest.substring(colonIdx2 + 1);

            const pathId = registry.intern(keyPath);
            if (registeredPaths.has(pathId)) continue; // already in index

            const nameId = registry.intern(symName);
            // Use a dummy typeId — type is not needed for resolution
            index.register({ dbId, nameId, pathId, typeId: 0, line: parseInt(lineStr, 10) + 1 });
        }

        // ── O(1) Edge resolution ─────────────────────────────────────────
        const callEdges = resolvePendingCalls(
            result.pendingCalls.filter(c => c.callerDbId > 0),
            index
        );
        const importEdges = resolvePendingImports(result.pendingImports, index);

        this.db.insertEdgeBatch(callEdges, 'call');
        this.db.insertEdgeBatch(importEdges, 'import');

        // ── Metadata ─────────────────────────────────────────────────────
        const contentHash = CodeIndexDatabase.computeHash(content);
        this.db.setFileHash(filePath, contentHash);
        this.db.setMeta('last_index_time', new Date().toISOString());

        this.sendMessage({
            type: 'parse-complete',
            id,
            symbolCount: result.symbols.length,
            edgeCount: callEdges.length + importEdges.length,
        });
    }

    /**
     * Parse multiple files in batch — Binary Pipeline Edition.
     *
     * IMPORTANT — provisional caller ID rebasing:
     *   Each file's extract() returns callerDbId values as -(localIdx+1), where localIdx
     *   is the symbol's position within THAT FILE's symbols[] array.  Before accumulating
     *   them into allPendingCalls we offset them by the number of symbols already buffered
     *   so that the global provisionalToDbId map can resolve them correctly.
     */
    private handleParseBatch(
        id: string,
        files: { filePath: string; content: string; language: 'typescript' | 'python' | 'c' }[]
    ): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const BATCH_SIZE = 500;
        const isBulkBatch = files.length > 10;

        if (isBulkBatch) {
            this.db.preIndexCleanup();
        }

        let totalSymbols = 0;
        let totalEdges = 0;

        const allPendingCalls: PendingCall[] = [];
        const allPendingImports: PendingImport[] = [];
        const registry = new StringRegistry();
        const index = new CompositeIndex();

        // symbolBuffer accumulates NewSymbol objects waiting to be flushed to the DB.
        // symbolBufferStartIdx = number of symbols already flushed (and in provisionalToDbId).
        let symbolBuffer: NewSymbol[] = [];
        let symbolBufferStartIdx = 0;

        // Maps global provisional index → real DB row ID.
        const provisionalToDbId = new Map<number, number>();

        const flushSymbolBuffer = () => {
            if (symbolBuffer.length === 0) return;
            const dbIds = this.db!.insertSymbols(symbolBuffer);
            for (let i = 0; i < dbIds.length; i++) {
                const sym = symbolBuffer[i];
                const pathId = registry.intern(sym.filePath);
                const nameId = registry.intern(sym.name);
                const typeId = registry.intern(sym.type);
                const dbId = dbIds[i];
                // Key = global sequential index (symbolBufferStartIdx + i)
                provisionalToDbId.set(symbolBufferStartIdx + i, dbId);
                index.register({ dbId, nameId, pathId, typeId, line: sym.rangeStartLine });
                // Keep globalSymbolMap in sync for cross-session single-file parses
                const key = `${sym.filePath}:${sym.name}:${sym.rangeStartLine - 1}`;
                this.globalSymbolMap.set(key, dbId);
            }
            symbolBufferStartIdx += symbolBuffer.length;
            totalSymbols += symbolBuffer.length;
            symbolBuffer = [];
        };

        // ── First pass: extract + buffer all symbols ───────────────────────
        let fileIndex = 0;
        for (const file of files) {
            this.db.deleteSymbolsByFile(file.filePath);

            const tree = this.parser.parse(file.content, file.language);
            const result = this.extractor.extract(tree, file.filePath, file.language, registry);

            // *** THE CRITICAL OFFSET: how many symbols have been accumulated globally
            //     BEFORE this file's symbols are added to the buffer.
            //     provisionalToDbId keys = symbolBufferStartIdx + bufferPosition.
            //     Local provisional index from extractor = 0..N-1 for this file.
            //     Global key = fileOffset + localIdx. ***
            const fileOffset = symbolBufferStartIdx + symbolBuffer.length;

            // Rebase this file's provisional caller IDs from local to global
            for (const call of result.pendingCalls) {
                if (call.callerDbId < 0) {
                    const localIdx = Math.abs(call.callerDbId) - 1;
                    // Translate to global provisional index
                    call.callerDbId = -(fileOffset + localIdx + 1);
                }
                allPendingCalls.push(call);
            }

            allPendingImports.push(...result.pendingImports);

            symbolBuffer.push(...result.symbols);
            if (symbolBuffer.length >= BATCH_SIZE) {
                flushSymbolBuffer();
            }

            const contentHash = CodeIndexDatabase.computeHash(file.content);
            this.db.setFileHash(file.filePath, contentHash);

            // Periodically save to disk during large batches to prevent data loss on crash
            if (isBulkBatch && fileIndex > 0 && fileIndex % 50 === 0) {
                this.db.saveToDisk();
            }
            fileIndex++;
        }

        // Flush any remaining symbols
        flushSymbolBuffer();

        // ── Resolve provisional caller IDs → real DB IDs ─────────────────
        // (All IDs are now globally indexed; provisionalToDbId covers them all.)
        for (const call of allPendingCalls) {
            if (call.callerDbId < 0) {
                const globalIdx = Math.abs(call.callerDbId) - 1;
                const realId = provisionalToDbId.get(globalIdx);
                if (realId !== undefined) {
                    call.callerDbId = realId;
                }
            }
        }

        // ── Resolve relative import source paths → absolute pathIds ────────
        const registrySnapshot = registry.exportSnapshot();
        for (const imp of allPendingImports) {
            const moduleStr = registry.resolve(imp.sourcePathId);
            if (moduleStr && !moduleStr.startsWith('/')) {
                const normalized = moduleStr.replace(/^\.\//, '').replace(/\.(ts|tsx|js|jsx)$/, '');
                for (let i = 0; i < registrySnapshot.length; i++) {
                    const p = registrySnapshot[i];
                    if (p.startsWith('/') && p.replace(/\.(ts|tsx|js|jsx)$/, '').endsWith(normalized)) {
                        imp.sourcePathId = i;
                        break;
                    }
                }
            }
        }

        // ── O(1) edge resolution via CompositeIndex ────────────────────────
        const callEdgeRecords = resolvePendingCalls(
            allPendingCalls.filter(c => c.callerDbId > 0),
            index
        );
        const importEdgeRecords = resolvePendingImports(allPendingImports, index);

        this.db.insertEdgeBatch(callEdgeRecords, 'call');
        this.db.insertEdgeBatch(importEdgeRecords, 'import');
        totalEdges = callEdgeRecords.length + importEdgeRecords.length;

        if (isBulkBatch) {
            this.db.postIndexOptimization();
        }

        this.db.setMeta('last_index_time', new Date().toISOString());
        this.db.saveToDisk();

        this.sendMessage({
            type: 'parse-batch-complete',
            id,
            totalSymbols,
            totalEdges,
            filesProcessed: files.length,
        });
    }

    /**
     * Check if file needs re-indexing based on content hash
     */
    private handleCheckFileHash(id: string, filePath: string, content: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const storedHash = this.db.getFileHash(filePath);
        const currentHash = CodeIndexDatabase.computeHash(content);
        const needsReindex = storedHash !== currentHash;

        this.sendMessage({
            type: 'file-hash-result',
            id,
            needsReindex,
            storedHash,
            currentHash,
        });
    }

    private handleCheckFileHashBatch(id: string, files: { filePath: string, contentHash: string }[]): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const pathsNeedingReindex: string[] = [];
        for (const file of files) {
            const storedHash = this.db.getFileHash(file.filePath);
            if (storedHash !== file.contentHash) {
                pathsNeedingReindex.push(file.filePath);
            }
        }

        this.sendMessage({
            type: 'file-hash-batch-result',
            id,
            pathsNeedingReindex,
        });
    }

    private handleDeleteFileSymbols(id: string, filePath: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        try {
            this.db.deleteSymbolsByFile(filePath);
            this.db.saveToDisk();
            this.sendMessage({ type: 'delete-file-symbols-complete', id });
        } catch (error: any) {
            this.sendError(id, `Error deleting symbols: ${error.message}`);
        }
    }

    /**
     * Export entire graph as JSON
     */
    private handleExportGraph(id: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const graph = this.db.exportGraph();
        console.log(`Worker: exported graph with ${graph.symbols.length} symbols, ${graph.edges.length} edges`);

        this.sendMessage({
            type: 'graph-export',
            id,
            graph,
        });
    }

    /**
     * Query symbols by name
     */
    private handleQuerySymbols(id: string, query: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const symbols = this.db.getSymbolsByName(query);
        const results: SymbolResult[] = symbols.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            filePath: s.filePath,
            range: {
                startLine: s.rangeStartLine,
                startColumn: s.rangeStartColumn,
                endLine: s.rangeEndLine,
                endColumn: s.rangeEndColumn,
            },
            complexity: s.complexity,
        }));

        this.sendMessage({
            type: 'query-result',
            id,
            symbols: results,
        });
    }

    /**
     * Query symbols by file
     */
    private handleQueryFile(id: string, filePath: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const symbols = this.db.getSymbolsByFile(filePath);
        const results: SymbolResult[] = symbols.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            filePath: s.filePath,
            range: {
                startLine: s.rangeStartLine,
                startColumn: s.rangeStartColumn,
                endLine: s.rangeEndLine,
                endColumn: s.rangeEndColumn,
            },
            complexity: s.complexity,
        }));

        this.sendMessage({
            type: 'query-result',
            id,
            symbols: results,
        });
    }

    /**
     * Clear entire index
     */
    private handleClear(id: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        this.db.clearIndex();
        this.globalSymbolMap.clear();
        this.allImports = [];
        this.allCalls = [];

        this.sendMessage({
            type: 'clear-complete',
            id,
        });
    }

    /**
     * Get index statistics
     */
    private handleStats(id: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const stats = this.db.getStats();
        const lastIndexTime = this.db.getMeta('last_index_time');

        this.sendMessage({
            type: 'stats-result',
            id,
            stats: {
                ...stats,
                lastIndexTime: lastIndexTime || undefined,
            },
        });
    }

    /**
     * Shutdown worker
     */
    private handleShutdown(): void {
        if (this.db) {
            this.db.close();
        }
        process.exit(0);
    }

    /**
     * Handle AI Query
     */
    private async handleAIQuery(request: any): Promise<void> {
        if (!this.orchestrator) {
            this.sendError(request.id, 'AI Orchestrator not initialized');
            return;
        }

        try {
            const result = await this.orchestrator.processQuery(request.query, {
                symbolId: request.symbolId,
                symbolName: request.symbolName,
                analysisType: request.analysisType,
            });

            this.sendMessage({
                type: 'ai-query-result',
                id: request.id,
                content: result.content,
                model: result.model,
                intent: {
                    type: result.intent.type,
                    confidence: result.intent.confidence,
                },
                latencyMs: result.latencyMs,
                contextIncluded: result.contextIncluded,
                neighborCount: result.neighborCount,
            });
        } catch (error) {
            this.sendError(request.id, `AI Query failed: ${(error as Error).message}`);
        }
    }

    /**
     * Handle AI Intent Classification
     */
    private handleAIClassifyIntent(request: any): void {
        if (!this.orchestrator) {
            this.sendError(request.id, 'AI Orchestrator not initialized');
            return;
        }

        const intent = this.orchestrator.classifyIntent(request.query);

        this.sendMessage({
            type: 'ai-intent-result',
            id: request.id,
            intentType: intent.type,
            confidence: intent.confidence,
            matchedPattern: intent.matchedPattern,
        });
    }



    /**
     * Handle Get Context
     */
    private handleGetContext(request: any): void {
        if (!this.db) {
            this.sendError(request.id, 'Database not initialized');
            return;
        }

        const context = this.db.getSymbolWithContext(request.symbolId);

        if (!context) {
            this.sendMessage({
                type: 'context-result',
                id: request.id,
                symbol: null,
                neighbors: [],
                incomingEdgeCount: 0,
                outgoingEdgeCount: 0,
            });
            return;
        }

        this.sendMessage({
            type: 'context-result',
            id: request.id,
            symbol: {
                id: context.symbol.id,
                name: context.symbol.name,
                type: context.symbol.type,
                filePath: context.symbol.filePath,
                range: {
                    startLine: context.symbol.rangeStartLine,
                    startColumn: context.symbol.rangeStartColumn,
                    endLine: context.symbol.rangeEndLine,
                    endColumn: context.symbol.rangeEndColumn,
                },
                complexity: context.symbol.complexity,
            },
            neighbors: context.neighbors.map(n => ({
                id: n.id,
                name: n.name,
                type: n.type,
                filePath: n.filePath,
                range: {
                    startLine: n.rangeStartLine,
                    startColumn: n.rangeStartColumn,
                    endLine: n.rangeEndLine,
                    endColumn: n.rangeEndColumn,
                },
                complexity: n.complexity,
            })),
            incomingEdgeCount: context.incomingEdges.length,
            outgoingEdgeCount: context.outgoingEdges.length,
        });
    }

    /**
     * Handle AI Configuration
     */
    private handleConfigureAI(request: any): void {
        if (!this.orchestrator) {
            // If orchestrator is not ready, we can't update it yet.
            // But since this might be called early, we should try to initialize it or just log.
            // However, initialize() should have been called already.
            this.sendError(request.id, 'AI Orchestrator not initialized');
            return;
        }

        try {
            this.orchestrator.updateConfig(request.config);
            this.sendMessage({
                type: 'configure-ai-complete',
                id: request.id
            });
        } catch (error) {
            this.sendError(request.id, `Failed to update AI config: ${(error as Error).message}`);
        }
    }

    /**
     * Handle Refine Graph request (Architect Pass)
     * MODIFIED: AI Architect Pass removed by user request.
     * Immediately returns success without AI processing.
     */
    private async handleRefineGraph(id: string): Promise<void> {
        if (!this.db) {
            this.sendError(id, 'Resource not initialized');
            return;
        }

        try {
            console.log('Worker: Graph refinement (Architect Pass) skipped (AI disabled).');

            // We behave as if the pass completed but found nothing new to add (purely local)
            this.sendMessage({
                type: 'refine-graph-complete',
                id,
                refinedNodeCount: 0,
                implicitLinkCount: 0
            });

        } catch (error) {
            console.error('Worker: Refine graph failed:', error);
            this.sendError(id, `Refine graph failed: ${(error as Error).message}`);
        }
    }

    private getLanguage(filePath: string): 'typescript' | 'python' | 'c' | null {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.ts' || ext === '.tsx') return 'typescript';
        if (ext === '.py') return 'python';
        if (ext === '.c' || ext === '.h') return 'c';
        return null;
    }

    /**
     * Send message to parent thread
     */
    private sendMessage(message: WorkerResponse): void {
        if (parentPort) {
            parentPort.postMessage(message);
        }
    }

    /**
     * Send error message
     */
    private sendError(id: string, error: string, stack?: string): void {
        this.sendMessage({
            type: 'error',
            id,
            error,
            stack,
        });
    }

    /**
     * Handle change impact analysis request
     */
    private handleAnalyzeImpact(id: string, nodeId: string): void {
        try {
            const analyzer = new ImpactAnalyzer(this.db!);

            // Parse nodeId to find the symbol
            const parts = nodeId.split(':');
            let symbolId: number | undefined;

            if (parts.length >= 3) {
                const line = parseInt(parts[parts.length - 1], 10);
                const symbolName = parts[parts.length - 2];
                const filePath = this.resolvePath(parts.slice(0, -2).join(':'));
                const symbols = this.db!.getSymbolsByFile(filePath);
                const symbol = symbols.find(s => s.name === symbolName && s.rangeStartLine === line);
                if (symbol) {
                    symbolId = symbol.id;
                }
            }

            if (!symbolId) {
                this.sendMessage({
                    type: 'impact-result',
                    id,
                    sourceNodeId: nodeId,
                    affected: [],
                    totalAffected: 0,
                    riskLevel: 'low'
                });
                return;
            }

            const impactNodes = analyzer.getImpactNodeIds(symbolId);
            const result = analyzer.analyzeImpact(symbolId);

            this.sendMessage({
                type: 'impact-result',
                id,
                sourceNodeId: nodeId,
                affected: impactNodes,
                totalAffected: result.totalAffected,
                riskLevel: result.riskLevel
            });

            console.log(`[Worker] Impact analysis for ${nodeId}: ${result.totalAffected} affected nodes (${result.riskLevel} risk)`);

        } catch (error) {
            this.sendError(id, `Impact analysis failed: ${(error as Error).message}`);
        }
    }

    /**
     * Handle incremental architect pass for changed files
     * MODIFIED: AI Incremental Pass removed.
     */
    private async handleRefineIncremental(id: string, changedFiles: string[]): Promise<void> {
        // No-op for AI refinement
        this.sendMessage({
            type: 'refine-incremental-complete',
            id,
            refinedNodeCount: 0,
            filesProcessed: changedFiles.length
        });
    }

    /**
     * Get Architecture Skeleton (JSON 1)
     */
    private async handleGetArchitectureSkeleton(id: string, refine: boolean = false): Promise<void> {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        try {
            const skeleton = await this.db.getArchitectureSkeleton(refine);
            this.sendMessage({
                type: 'architecture-skeleton',
                id,
                skeleton,
            });
        } catch (error) {
            this.sendError(id, `Failed to get architecture skeleton: ${(error as Error).message}`);
        }
    }

    /**
     * Handle function trace request
     */
    private handleTraceFunction(id: string, symbolId?: number, nodeId?: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        try {
            let targetId = symbolId;

            // Resolve Node ID if no Symbol ID provided
            if (!targetId && nodeId) {
                const parts = nodeId.split(':');
                if (parts.length >= 3) {
                    const line = parseInt(parts[parts.length - 1], 10);
                    const symbolName = parts[parts.length - 2];
                    const filePath = this.resolvePath(parts.slice(0, -2).join(':'));

                    const symbol = this.db.getSymbolByLocation(filePath, symbolName, line);
                    if (symbol) {
                        targetId = symbol.id;
                    }
                }
            }

            if (!targetId) {
                this.sendError(id, 'Invalid symbol ID or Node ID. Symbol not found.');
                return;
            }

            const trace = this.db.getFunctionTrace(targetId);
            this.sendMessage({
                type: 'function-trace',
                id,
                trace
            });
        } catch (error) {
            this.sendError(id, `Failed to trace function: ${(error as Error).message}`);
        }
    }
}

// Initialize worker
const worker = new IndexWorker();

// Listen for messages from parent
if (parentPort) {
    parentPort.on('message', (message: unknown) => {
        if (isWorkerRequest(message)) {
            worker.handleMessage(message);
        } else {
            console.error('Invalid message received:', message);
        }
    });
}
