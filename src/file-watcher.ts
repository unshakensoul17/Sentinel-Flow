// Purpose: File system watcher for incremental indexing
// Monitors workspace files and triggers re-indexing only when content changes
// Uses content hashing to avoid unnecessary re-parsing

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { WorkerManager } from './worker/worker-manager';

export class FileWatcherManager {
    private watcher: vscode.FileSystemWatcher | null = null;
    private workerManager: WorkerManager;
    private outputChannel: vscode.OutputChannel;
    private isEnabled: boolean = false;
    private pendingFiles: Set<string> = new Set();
    private batchTimer: NodeJS.Timeout | null = null;
    private readonly BATCH_MS = 1000;

    constructor(workerManager: WorkerManager, outputChannel: vscode.OutputChannel) {
        this.workerManager = workerManager;
        this.outputChannel = outputChannel;
    }

    /**
     * Start watching for file changes
     */
    start(): void {
        if (this.watcher) {
            return;
        }

        // Watch TypeScript, Python, and C files
        this.watcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{ts,tsx,py,c,h}',
            false, // Don't ignore creates
            false, // Don't ignore changes
            false  // Don't ignore deletes
        );

        // Handle file changes & creations using batching
        this.watcher.onDidChange((uri) => this.enqueueFile(uri));
        this.watcher.onDidCreate((uri) => this.enqueueFile(uri));

        // Handle deleted files immediately (still safe but less common to batch deletes)
        this.watcher.onDidDelete(async (uri) => {
            await this.handleFileDelete(uri);
        });

        this.isEnabled = true;
        this.outputChannel.appendLine('File watcher started (Batch mode enabled)');
    }

    /**
     * Stop watching files
     */
    stop(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }

        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        this.pendingFiles.clear();

        this.isEnabled = false;
        this.outputChannel.appendLine('File watcher stopped');
    }

    /**
     * Enqueue a file for batch re-indexing
     */
    private enqueueFile(uri: vscode.Uri): void {
        const filePath = uri.fsPath;
        if (this.shouldSkipFile(filePath)) return;

        this.pendingFiles.add(filePath);

        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
        }

        this.batchTimer = setTimeout(async () => {
            await this.processPendingBatch();
        }, this.BATCH_MS);
    }

    /**
     * Process all pending files in a single worker batch
     */
    private async processPendingBatch(): Promise<void> {
        if (this.pendingFiles.size === 0) return;

        const filesToProcess = Array.from(this.pendingFiles);
        this.pendingFiles.clear();
        this.batchTimer = null;

        this.outputChannel.appendLine(`FileWatcher: Processing batch of ${filesToProcess.length} files...`);

        try {
            const validFilesMetadata = await Promise.all(
                filesToProcess.map(async (filePath) => {
                    try {
                        if (!fs.existsSync(filePath)) return null;
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        const language = this.getLanguage(filePath);
                        if (!language) return null;
                        return { filePath, content, language };
                    } catch (e) {
                        return null;
                    }
                })
            );

            const filesToParse = validFilesMetadata.filter((f): f is NonNullable<typeof f> => f !== null);
            if (filesToParse.length === 0) return;

            // Use batch parsing for better cross-file edge resolution and fewer round-trips
            const result = await this.workerManager.parseBatch(filesToParse);

            this.outputChannel.appendLine(
                `Batch indexed ${result.filesProcessed} files: ${result.totalSymbols} symbols, ${result.totalEdges} edges`
            );

            // Invalidate inspector cache since data has changed
            vscode.commands.executeCommand('sentinel-flow.invalidate-cache');
        } catch (error) {
            this.outputChannel.appendLine(`Batch re-indexing failed: ${error}`);
        }
    }

    /**
     * Handle file deletion
     */
    private async handleFileDelete(uri: vscode.Uri): Promise<void> {
        const filePath = uri.fsPath;

        if (this.shouldSkipFile(filePath)) {
            return;
        }

        this.outputChannel.appendLine(`File deleted: ${filePath}`);

        try {
            await this.workerManager.deleteFileSymbols(filePath);
            this.outputChannel.appendLine(`Successfully cleaned up symbols for deleted file: ${filePath}`);
        } catch (error) {
            this.outputChannel.appendLine(`Error cleaning up symbols for deleted file ${filePath}: ${error}`);
        }
    }

    /**
     * Check if file should be skipped
     */
    private shouldSkipFile(filePath: string): boolean {
        const excludePatterns = [
            'node_modules',
            '.git',
            'venv',
            '.venv',
            'dist',
            'build',
            'out',
            '.vscode',
            '__pycache__',
            '.cache',
            '.pytest_cache',
            '.next',
            '.svelte-kit',
        ];

        return excludePatterns.some((pattern) => filePath.includes(pattern));
    }

    /**
     * Get language from file path
     */
    private getLanguage(filePath: string): 'typescript' | 'python' | 'c' | null {
        const ext = path.extname(filePath).toLowerCase();

        switch (ext) {
            case '.ts':
            case '.tsx':
                return 'typescript';
            case '.py':
                return 'python';
            case '.c':
            case '.h':
                return 'c';
            default:
                return null;
        }
    }

    /**
     * Compute content hash
     */
    static computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Check if watcher is active
     */
    isActive(): boolean {
        return this.isEnabled;
    }
}
