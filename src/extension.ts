// Purpose: VS Code Extension entry point
// Handles extension activation, command registration, and orchestration
// Main thread focuses only on UI events and delegation

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { WorkerManager } from './worker/worker-manager';
import { FileWatcherManager } from './file-watcher';
import { GraphWebviewProvider } from './webview-provider';
import { HeatCodeLensProvider, TraceCodeLensProvider } from './codelens-provider';
import { SidebarProvider } from './sidebar-provider';

let workerManager: WorkerManager | null = null;
let fileWatcherManager: FileWatcherManager | null = null;
let graphWebviewProvider: GraphWebviewProvider | null = null;
let heatCodeLensProvider: HeatCodeLensProvider | null = null;
let traceCodeLensProvider: TraceCodeLensProvider | null = null;
let outputChannel: vscode.OutputChannel;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Sentinel Flow');
    outputChannel.appendLine('Sentinel Flow extension activating...');

    // Initialize worker
    try {
        workerManager = new WorkerManager(async () => {
            vscode.window.showWarningMessage('Sentinel Flow Indexer restarted due to high memory usage.');
            outputChannel.appendLine('Worker restarted automatically.');
            // Re-apply configuration after worker resets
            await updateWorkerConfig();
        });
        const workerPath = path.join(context.extensionPath, 'dist', 'worker', 'worker.js');
        const storagePath = context.storageUri ? context.storageUri.fsPath : context.globalStorageUri.fsPath;

        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
        }

        await workerManager.start(workerPath, storagePath);
        outputChannel.appendLine(`Worker initialized successfully with storage at ${storagePath}`);

        // Initialize file watcher for incremental indexing
        fileWatcherManager = new FileWatcherManager(workerManager, outputChannel);
        fileWatcherManager.start();
        outputChannel.appendLine('File watcher started');

        // Initialize webview provider
        graphWebviewProvider = new GraphWebviewProvider(context, workerManager);

        // Initialize CodeLens providers
        heatCodeLensProvider = new HeatCodeLensProvider(workerManager);
        traceCodeLensProvider = new TraceCodeLensProvider(workerManager);

        const supportedLanguages = [
            { scheme: 'file', language: 'typescript' },
            { scheme: 'file', language: 'typescriptreact' },
            { scheme: 'file', language: 'python' },
            { scheme: 'file', language: 'c' }
        ];

        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(supportedLanguages, heatCodeLensProvider),
            vscode.languages.registerCodeLensProvider(supportedLanguages, traceCodeLensProvider)
        );
        outputChannel.appendLine('CodeLens providers registered');

        // Initialize Sidebar Provider
        const sidebarProvider = new SidebarProvider(context.extensionUri, context);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                'sentinel-flow-sidebar',
                sidebarProvider
            )
        );

        // Configure AI
        await updateWorkerConfig();

        // Listen for configuration changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(async (e) => {
                if (e.affectsConfiguration('sentinelFlow')) {
                    await updateWorkerConfig();
                }
            })
        );

        // Auto-index on first activation for this workspace
        const hasIndexedWorkspace = context.workspaceState.get<boolean>('hasIndexedWorkspace', false);
        if (!hasIndexedWorkspace) {
            outputChannel.appendLine('First time activation in this workspace detected.');
            // Give VS Code a moment to finish initializing
            const autoIndexTimer = setTimeout(() => {
                if (!workerManager) return; // Guard
                const autoIndexEnabled = context.workspaceState.get<boolean>('autoIndexEnabled', true);
                if (autoIndexEnabled) {
                    outputChannel.appendLine('Starting auto-index...');
                    vscode.commands.executeCommand('codeIndexer.indexWorkspace').then(() => {
                        context.workspaceState.update('hasIndexedWorkspace', true);
                    });
                } else {
                    outputChannel.appendLine('Auto-indexing is disabled, skipping initial index.');
                    context.workspaceState.update('hasIndexedWorkspace', true);
                }
            }, 5000);
            context.subscriptions.push({ dispose: () => clearTimeout(autoIndexTimer) });
        }

        // Listen for workspace folder changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
                if (e.added.length > 0 || e.removed.length > 0) {
                    const autoIndexEnabled = context.workspaceState.get<boolean>('autoIndexEnabled', true);
                    if (!autoIndexEnabled) {
                        outputChannel.appendLine('Workspace folders changed, but auto-indexing is disabled. Skipping re-index.');
                        return;
                    }

                    outputChannel.appendLine('Workspace folders changed. Re-indexing...');
                    if (workerManager) {
                        try {
                            // Silently clear index
                            await workerManager.clearIndex();
                            outputChannel.appendLine('Previous index cleared successfully.');
                            // Trigger re-index
                            await vscode.commands.executeCommand('codeIndexer.indexWorkspace');
                        } catch (error) {
                            outputChannel.appendLine(`Failed to auto-reindex after folder change: ${error}`);
                        }
                    }
                }
            })
        );
    } catch (error) {
        outputChannel.appendLine(`Failed to initialize worker: ${error}`);
        vscode.window.showErrorMessage('Sentinel Flow: Failed to initialize worker');
        return;
    }

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.indexWorkspace', async () => {
            await indexWorkspace();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.querySymbols', async () => {
            await querySymbols();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.clearIndex', async () => {
            await clearIndex();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.exportGraph', async () => {
            await exportGraph();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.exportArchitectureSkeleton', async () => {
            await exportArchitectureSkeleton();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.toggleFileWatcher', async () => {
            await toggleFileWatcher();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.visualizeGraph', async () => {
            await visualizeGraph();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.refineGraph', async () => {
            await refineGraph();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.refineArchitecture', async () => {
            await refineArchitecture();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sentinel-flow.invalidate-cache', () => {
            graphWebviewProvider?.postMessage({ type: 'cache-invalidate' });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.configureAI', async () => {
            await configureAI();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('architect.viewDirectory', async (uri: vscode.Uri) => {
            if (uri && uri.fsPath) {
                await viewDirectory(uri);
            } else {
                vscode.window.showErrorMessage('No directory selected');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('architect.traceFunction', async (symbolId?: number, nodeId?: string) => {
            if (graphWebviewProvider) {
                await graphWebviewProvider.traceSymbol(symbolId, nodeId);
            }
        })
    );

    outputChannel.appendLine('Sentinel Flow extension activated');
}

/**
 * Extension deactivation
 */
export async function deactivate() {
    if (fileWatcherManager) {
        fileWatcherManager.stop();
    }

    if (workerManager) {
        await workerManager.shutdown();
    }

    if (outputChannel) {
        outputChannel.dispose();
    }
}

/**
 * Index workspace command
 */
async function indexWorkspace() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Sentinel Flow: Worker not initialized');
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Sentinel Flow: Indexing Workspace',
            cancellable: false,
        },
        async (progress) => {
            try {
                // Find all supported files
                const files = await vscode.workspace.findFiles(
                    '**/*.{ts,tsx,py,c,h}',
                    '{**/node_modules/**,**/venv/**,**/.venv/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.cache/**,**/.vscode/**,**/__pycache__/**,**/.pytest_cache/**}'
                );

                const totalFiles = files.length;
                let processedCount = 0;
                let totalSymbols = 0;
                let totalEdges = 0;
                const BATCH_SIZE = 100; // Small batch size for interleaved UI responsiveness

                outputChannel.appendLine(`Starting chunked index of ${totalFiles} files...`);

                for (let i = 0; i < totalFiles; i += BATCH_SIZE) {
                    const chunk = files.slice(i, i + BATCH_SIZE);
                    progress.report({
                        message: `Processing ${processedCount}/${totalFiles} files...`,
                        increment: (chunk.length / totalFiles) * 100
                    });

                    // ── Pass 1: Read ONLY hashes (no content in RAM) ──────────────────
                    // We hash each file cheaply without holding the full string in memory.
                    // For a 15 000-file monorepo this keeps the RSS flat instead of
                    // spiking by gigabytes while we wait for the IPC round-trip.
                    const chunkHashes = await Promise.all(
                        chunk.map(async (file) => {
                            try {
                                if (!fs.existsSync(file.fsPath)) return null;
                                const language = getLanguage(file.fsPath);
                                if (!language) return null;
                                const content = await fs.promises.readFile(file.fsPath, 'utf8');
                                const contentHash = crypto.createHash('sha256').update(content).digest('hex');
                                // Drop the content string immediately — only keep the hash.
                                return { filePath: file.fsPath, language, contentHash };
                            } catch {
                                return null;
                            }
                        })
                    );

                    const validHashes = chunkHashes.filter((f): f is NonNullable<typeof f> => f !== null);
                    if (validHashes.length === 0) {
                        processedCount += chunk.length;
                        continue;
                    }

                    // ── Pass 2: Ask the worker which files actually changed ────────────
                    const pathsNeedingReindex = await workerManager!.checkFileHashBatch(
                        validHashes.map(f => ({ filePath: f.filePath, contentHash: f.contentHash }))
                    );

                    const reindexSet = new Set(pathsNeedingReindex);

                    if (reindexSet.size === 0) {
                        processedCount += chunk.length;
                        continue;
                    }

                    // ── Pass 3: Read ONLY the changed files' content ──────────────────
                    // This is the expensive I/O — but now it only runs for the small
                    // subset of files that genuinely changed (often 1–5% of the chunk).
                    const filesToParse = (
                        await Promise.all(
                            validHashes
                                .filter(f => reindexSet.has(f.filePath))
                                .map(async (f) => {
                                    try {
                                        const content = await fs.promises.readFile(f.filePath, 'utf8');
                                        return { filePath: f.filePath, language: f.language, content };
                                    } catch {
                                        return null;
                                    }
                                })
                        )
                    ).filter((f): f is NonNullable<typeof f> => f !== null);

                    if (filesToParse.length > 0) {
                        const result = await workerManager!.parseBatch(filesToParse);
                        totalSymbols += result.totalSymbols;
                        totalEdges += result.totalEdges;
                    }

                    processedCount += chunk.length;
                }

                // Finalize: signal webview to refresh caches
                graphWebviewProvider?.postMessage({ type: 'cache-invalidate' });

                vscode.window.showInformationMessage(
                    `Indexing complete. Processed ${totalFiles} files, found ${totalSymbols} symbols and ${totalEdges} edges.`
                );

                outputChannel.appendLine(`Indexing finished: ${totalSymbols} symbols, ${totalEdges} edges.`);
            } catch (error) {
                vscode.window.showErrorMessage(`Indexing failed: ${error}`);
                outputChannel.appendLine(`Indexing error: ${error}`);
            }
        }
    );
}

/**
 * Query symbols command
 */
async function querySymbols() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    const query = await vscode.window.showInputBox({
        prompt: 'Enter symbol name to search',
        placeHolder: 'e.g., myFunction',
    });

    if (!query) {
        return;
    }

    try {
        const symbols = await workerManager.querySymbols(query);

        if (symbols.length === 0) {
            vscode.window.showInformationMessage(`No symbols found for "${query}"`);
            return;
        }

        // Create QuickPick items
        const items: vscode.QuickPickItem[] = symbols.map((symbol) => ({
            label: `$(symbol-${symbol.type}) ${symbol.name}`,
            description: `${symbol.type} • ${path.basename(symbol.filePath)}`,
            detail: `${symbol.filePath}:${symbol.range.startLine} (complexity: ${symbol.complexity})`,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Found ${symbols.length} symbol(s)`,
        });

        if (selected) {
            // Extract file path from detail
            const symbolIndex = items.indexOf(selected);
            const symbol = symbols[symbolIndex];

            // Open file at symbol location
            const doc = await vscode.workspace.openTextDocument(symbol.filePath);
            const editor = await vscode.window.showTextDocument(doc);

            const position = new vscode.Position(symbol.range.startLine - 1, symbol.range.startColumn);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
            );
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
        outputChannel.appendLine(`Query failed: ${error}`);
    }
}

/**
 * Clear index command
 */
async function clearIndex() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear the code index?',
        'Yes',
        'No'
    );

    if (confirm === 'Yes') {
        try {
            await workerManager.clearIndex();
            vscode.window.showInformationMessage('Code index cleared');
            outputChannel.appendLine('Index cleared');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to clear index: ${error}`);
            outputChannel.appendLine(`Failed to clear index: ${error}`);
        }
    }
}

/**
 * Export graph command
 */
async function exportGraph() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    try {
        const graph = await workerManager.exportGraph();

        // Create output file path
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const outputPath = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, 'code-graph.json')
            : path.join(require('os').tmpdir(), 'code-graph.json');

        // Write graph to file
        fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2), 'utf-8');

        // Show success and open file
        const result = await vscode.window.showInformationMessage(
            `Graph exported to ${outputPath}`,
            'Open File'
        );

        if (result === 'Open File') {
            const doc = await vscode.workspace.openTextDocument(outputPath);
            await vscode.window.showTextDocument(doc);
        }

        outputChannel.appendLine(`Graph exported: ${graph.symbols.length} symbols, ${graph.edges.length} edges`);
    } catch (error) {
        vscode.window.showErrorMessage(`Export failed: ${error}`);
        outputChannel.appendLine(`Export failed: ${error}`);
    }
}

/**
 * Export architecture skeleton command
 */
async function exportArchitectureSkeleton() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    try {
        const skeleton = await workerManager.getArchitectureSkeleton();

        // Create output file path
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const outputPath = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, 'architecture-skeleton.json')
            : path.join(require('os').tmpdir(), 'architecture-skeleton.json');

        // Write to file
        fs.writeFileSync(outputPath, JSON.stringify(skeleton, null, 2), 'utf-8');

        // Show success and open file
        const result = await vscode.window.showInformationMessage(
            `Architecture skeleton exported to ${outputPath}`,
            'Open File'
        );

        if (result === 'Open File') {
            const doc = await vscode.workspace.openTextDocument(outputPath);
            await vscode.window.showTextDocument(doc);
        }

        outputChannel.appendLine(`Architecture skeleton exported: ${skeleton.nodes.length} files, ${skeleton.edges.length} connections`);
    } catch (error) {
        vscode.window.showErrorMessage(`Skeleton export failed: ${error}`);
        outputChannel.appendLine(`Skeleton export failed: ${error}`);
    }
}

/**
 * Visualize code graph
 */
async function visualizeGraph() {
    if (!graphWebviewProvider) {
        vscode.window.showErrorMessage('Graph webview provider not initialized');
        return;
    }

    try {
        await graphWebviewProvider.show();
    } catch (error) {
        vscode.window.showErrorMessage(
            `Failed to show graph visualization: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Run AI Architect Pass to refine the graph
 */
async function refineGraph() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    const config = vscode.workspace.getConfiguration('sentinelFlow');
    const geminiApiKey = config.get<string>('geminiApiKey');

    if (!geminiApiKey) {
        const result = await vscode.window.showErrorMessage(
            'Gemini API Key is not configured. Please set one up first.',
            'Configure AI'
        );
        if (result === 'Configure AI') {
            vscode.commands.executeCommand('codeIndexer.configureAI');
        }
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Refining graph with AI...',
            cancellable: false,
        },
        async (_progress) => {
            try {
                const result = await workerManager!.refineGraph();
                vscode.window.showInformationMessage(
                    `Graph refined: ${result.refinedNodeCount} nodes updated with AI insights.`
                );
                outputChannel.appendLine(
                    `Sentinel Pass complete: ${result.refinedNodeCount} nodes refined, ${result.implicitLinkCount} implicit links found.`
                );

                // Refresh webview if open
                if (graphWebviewProvider) {
                    graphWebviewProvider.refresh();
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Refinement failed: ${error}`);
                outputChannel.appendLine(`Refinement failed: ${error}`);
            }
        }
    );
}

/**
 * View directory in graph
 */
async function viewDirectory(uri: vscode.Uri) {
    if (!graphWebviewProvider) {
        // If webview is not open, open it first
        vscode.commands.executeCommand('codeIndexer.visualizeGraph');
        // Give it a moment to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (graphWebviewProvider) {
        // Ensure the webview is visible
        await graphWebviewProvider.show();

        // Send filter message
        graphWebviewProvider.postMessage({
            type: 'filter-by-directory',
            path: uri.fsPath
        });

        vscode.window.showInformationMessage(`Filtering graph by directory: ${path.basename(uri.fsPath)}`);
    } else {
        vscode.window.showErrorMessage('Failed to open graph webview');
    }
}

/**
 * Toggle file watcher command
 */
async function toggleFileWatcher() {
    if (!fileWatcherManager) {
        vscode.window.showErrorMessage('File watcher not initialized');
        return;
    }

    if (fileWatcherManager.isActive()) {
        fileWatcherManager.stop();
        vscode.window.showInformationMessage('File watcher stopped');
    } else {
        fileWatcherManager.start();
        vscode.window.showInformationMessage('File watcher started');
    }
}

/**
 * Determine language from file extension
 */
function getLanguage(filePath: string): 'typescript' | 'python' | 'c' | null {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.ts' || ext === '.tsx') {
        return 'typescript';
    } else if (ext === '.py') {
        return 'python';
    } else if (ext === '.c' || ext === '.h') {
        return 'c';
    }

    return null;
}

/**
 * Update worker AI configuration
 */
async function updateWorkerConfig() {
    if (!workerManager) return;

    const config = vscode.workspace.getConfiguration('sentinelFlow');

    const groqApiKey = config.get<string>('groqApiKey');
    const geminiApiKey = config.get<string>('geminiApiKey');
    const awsRegion = config.get<string>('awsRegion');
    const bedrockModelId = config.get<string>('bedrockModelId');
    const aiProvider = config.get<'gemini' | 'bedrock'>('aiProvider') || 'gemini';
    const awsAccessKeyId = config.get<string>('awsAccessKeyId');
    const awsSecretAccessKey = config.get<string>('awsSecretAccessKey');

    try {
        await workerManager.configureAI({
            groqApiKey,
            geminiApiKey,
            awsRegion,
            bedrockModelId,
            aiProvider,
            awsAccessKeyId,
            awsSecretAccessKey,
        });
        outputChannel.appendLine('AI configuration updated');
    } catch (error) {
        outputChannel.appendLine(`Failed to update AI config: ${error}`);
    }
}
/**
 * Configure AI API keys via input boxes
 */
async function configureAI() {
    const config = vscode.workspace.getConfiguration('sentinelFlow');

    // 1. Get Groq API Key
    const currentGroqKey = config.get<string>('groqApiKey') || '';
    const groqKey = await vscode.window.showInputBox({
        title: 'Configure Groq API Key',
        prompt: 'Enter your Groq API Key (Llama 3.1 analysis)',
        value: currentGroqKey,
        password: true,
        placeHolder: 'gsk_...',
        ignoreFocusOut: true
    });

    if (groqKey !== undefined) {
        await config.update('groqApiKey', groqKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Groq API Key updated successfully.');
    }


    // 2. Get Gemini API Key
    const currentGeminiKey = config.get<string>('geminiApiKey') || '';
    const geminiKey = await vscode.window.showInputBox({
        title: 'Configure Gemini API Key',
        prompt: 'Enter your Google Gemini API Key (Gemini 1.5 analysis)',
        value: currentGeminiKey,
        password: true,
        placeHolder: 'AIza...',
        ignoreFocusOut: true
    });

    if (geminiKey !== undefined) {
        await config.update('geminiApiKey', geminiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Gemini API Key updated successfully.');
    }

    // Explicitly trigger worker update (though onDidChangeConfiguration should handle it)
    await updateWorkerConfig();
}

/** Handle AI Provider toggle from sidebar (called by SidebarProvider indirectly via command) */
export async function setAIProvider(provider: 'gemini' | 'bedrock') {
    const config = vscode.workspace.getConfiguration('sentinelFlow');
    await config.update('aiProvider', provider, vscode.ConfigurationTarget.Global);
    await updateWorkerConfig();
    vscode.window.showInformationMessage(`Sentinel Flow: AI Provider switched to ${provider === 'bedrock' ? 'Amazon Bedrock' : 'Google Gemini'}.`);
}

/**
 * Refine architecture labels with AI
 */
async function refineArchitecture() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Refining architecture labels with AI...',
            cancellable: false,
        },
        async () => {
            try {
                if (!workerManager) throw new Error('Worker not initialized');
                const skeleton = await workerManager.getArchitectureSkeleton(true);

                // If webview is open, refresh it
                if (graphWebviewProvider) {
                    graphWebviewProvider.refreshArchitectureSkeleton(skeleton);
                }

                vscode.window.showInformationMessage('Architecture labels refined successfully');
            } catch (error) {
                vscode.window.showErrorMessage(`Refinement failed: ${error}`);
            }
        }
    );
}

