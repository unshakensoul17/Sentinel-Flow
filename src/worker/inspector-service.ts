/**
 * Inspector Service
 * Handles business logic for the inspector panel
 * - Fetches data from database
 * - Calculates metrics
 * - Delegates AI actions to orchestrator
 * 
 * Note: Node IDs use specific formats:
 * - Domain: "domain:Name"
 * - File: "domain:FilePath" (though usually just "FilePath" internally) -> logic needs to handle prefixes
 * - Symbol: "FilePath:Name:Line"
 */

import * as path from 'path';
import { CodeIndexDatabase } from '../db/database';
import { AIOrchestrator } from '../ai/orchestrator';
import { computeDomainHealth } from '../domain/health';
import {
    InspectorOverviewData,
    InspectorDependencyData,
    InspectorRiskData,
    InspectorAIResult,
    InspectorDependencyItem
} from './message-protocol';

export class InspectorService {
    constructor(
        private db: CodeIndexDatabase,
        private orchestrator: AIOrchestrator
    ) { }

    private resolvePath(p: string): string {
        if (!this.db) return p;
        const root = this.db.getWorkspaceRootHeuristic();
        if (p.startsWith(root)) return p;

        // Handle both "src/app..." and "/src/app..."
        const relativePath = p.startsWith('/') ? p.substring(1) : p;
        return path.join(root, relativePath);
    }

    /**
     * Get overview data for a selected node
     */
    async getOverview(nodeId: string, nodeType: 'domain' | 'file' | 'symbol'): Promise<InspectorOverviewData> {
        const data: InspectorOverviewData = {
            nodeType,
            name: '',
            path: '',
        };

        try {
            if (nodeType === 'domain') {
                const domainName = nodeId.replace(/^domain:/, '');
                data.name = domainName;
                data.path = 'Domain';

                const domainFiles = this.db.getFilesByDomain(domainName);
                if (domainFiles) {
                    data.fileCount = domainFiles.length;
                    let functionCount = 0;
                    for (const file of domainFiles) {
                        const stats = this.db.getFileStats(file.filePath);
                        if (stats) functionCount += stats.functionCount;
                    }
                    data.functionCount = functionCount;
                }

                // P1-A: Real health using computeDomainHealth()
                const domainSymbols = this.db.getSymbolsByDomain(domainName);
                const { crossDomain, total } = this.db.getDomainEdgeCounts(domainName);
                const health = computeDomainHealth(domainName, domainSymbols, crossDomain, total);
                data.healthPercent = health.healthScore;
                data.coupling = health.coupling;
                data.functionCount = data.functionCount ?? health.symbolCount;
            } else if (nodeType === 'file') {
                // Remove potential domain prefix if present for lookup (e.g. "Domain:/abs/path.ts" -> "/abs/path.ts")
                let rawFilePath = nodeId;
                const colonIdx = nodeId.indexOf(':');
                if (colonIdx > 0) {
                    const afterColon = nodeId.substring(colonIdx + 1);
                    if (afterColon.startsWith('/') || /^[a-zA-Z]:/.test(afterColon)) {
                        rawFilePath = afterColon;
                    }
                }
                let filePath = this.resolvePath(rawFilePath);

                data.name = filePath.split('/').pop() || filePath;
                data.path = filePath;

                const file = this.db.getFile(filePath);
                if (file) {
                    data.lastModified = file.lastModified;
                }

                const stats = this.db.getFileStats(filePath);
                if (stats) {
                    data.symbolCount = stats.symbolCount;
                    data.avgComplexity = 5; // Refined below from symbol scan
                }

                // P1-B: Real import/export counts from edge table
                const edgeCounts = this.db.getFileEdgeCounts(filePath);
                data.importCount = edgeCounts.importCount;
                data.exportCount = edgeCounts.exportCount;

                // Calculate imports/exports from edges
                const symbols = this.db.getSymbolsByFile(filePath);
                if (symbols && symbols.length > 0) {
                    let totalComplexity = 0;
                    let complexityCount = 0;

                    for (const sym of symbols) {
                        if (sym.complexity) {
                            totalComplexity += sym.complexity;
                            complexityCount++;
                        }
                    }

                    if (complexityCount > 0) {
                        data.avgComplexity = totalComplexity / complexityCount;
                    }
                    data.symbolCount = symbols.length;
                }

            } else if (nodeType === 'symbol') {
                // Format: filePath:symbolName:line
                const parts = nodeId.split(':');
                if (parts.length >= 3) {
                    const line = parseInt(parts[parts.length - 1], 10);
                    const symbolName = parts[parts.length - 2];
                    const filePath = this.resolvePath(parts.slice(0, -2).join(':'));

                    data.name = symbolName;
                    data.path = `${filePath}:${line}`;

                    const symbols = this.db.getSymbolsByFile(filePath);
                    const symbol = symbols.find(s => s.name === symbolName && s.rangeStartLine === line);

                    if (symbol) {
                        data.lines = (symbol.rangeEndLine - symbol.rangeStartLine) + 1;
                        data.complexity = symbol.complexity;

                        const incoming = this.db.getIncomingEdges(symbol.id);
                        const outgoing = this.db.getOutgoingEdges(symbol.id);

                        data.fanIn = incoming.length;
                        data.fanOut = outgoing.length;
                    }
                }
            }
        } catch (error) {
            console.error('Error fetching overview:', error);
        }

        return data;
    }

    /**
     * Get dependencies for a node
     */
    async getDependencies(nodeId: string, nodeType: 'domain' | 'file' | 'symbol'): Promise<InspectorDependencyData> {
        const result: InspectorDependencyData = {
            calls: [],
            calledBy: [],
            imports: [],
            usedBy: []
        };

        try {
            if (nodeType === 'symbol') {
                const parts = nodeId.split(':');
                if (parts.length >= 3) {
                    const line = parseInt(parts[parts.length - 1], 10);
                    const symbolName = parts[parts.length - 2];
                    const filePath = this.resolvePath(parts.slice(0, -2).join(':'));

                    const symbols = this.db.getSymbolsByFile(filePath);
                    const symbol = symbols.find(s => s.name === symbolName && s.rangeStartLine === line);

                    if (symbol) {
                        const outgoing = this.db.getOutgoingEdges(symbol.id);
                        for (const edge of outgoing) {
                            const target = this.db.getSymbolById(edge.targetId);
                            if (target) {
                                result.calls.push(this.mapSymbolToDep(target));
                            }
                        }

                        const incoming = this.db.getIncomingEdges(symbol.id);
                        for (const edge of incoming) {
                            const source = this.db.getSymbolById(edge.sourceId);
                            if (source) {
                                result.calledBy.push(this.mapSymbolToDep(source));
                            }
                        }
                    }
                }
            } else if (nodeType === 'file') {
                let rawFilePath = nodeId;
                const colonIdx = nodeId.indexOf(':');
                if (colonIdx > 0) {
                    const afterColon = nodeId.substring(colonIdx + 1);
                    if (afterColon.startsWith('/') || /^[a-zA-Z]:/.test(afterColon)) {
                        rawFilePath = afterColon;
                    }
                }
                let filePath = this.resolvePath(rawFilePath);

                // Get all symbols in this file
                const symbols = this.db.getSymbolsByFile(filePath);
                const fileSymbolIds = new Set(symbols.map(s => s.id));

                const importsMap = new Map<string, InspectorDependencyItem>();
                const usedByMap = new Map<string, InspectorDependencyItem>();

                for (const sym of symbols) {
                    // Outgoing edges (Imports)
                    const outgoing = this.db.getOutgoingEdges(sym.id);
                    for (const edge of outgoing) {
                        if (!fileSymbolIds.has(edge.targetId)) {
                            const target = this.db.getSymbolById(edge.targetId);
                            if (target) {
                                const item = this.mapSymbolToDep(target);
                                importsMap.set(item.id, item);
                            }
                        }
                    }

                    // Incoming edges (Used By)
                    const incoming = this.db.getIncomingEdges(sym.id);
                    for (const edge of incoming) {
                        if (!fileSymbolIds.has(edge.sourceId)) {
                            const source = this.db.getSymbolById(edge.sourceId);
                            if (source) {
                                const item = this.mapSymbolToDep(source);
                                usedByMap.set(item.id, item);
                            }
                        }
                    }
                }

                result.imports = Array.from(importsMap.values());
                result.usedBy = Array.from(usedByMap.values());
            }
        } catch (error) {
            console.error('Error fetching dependencies:', error);
        }

        return result;
    }

    private mapSymbolToDep(symbol: any): InspectorDependencyItem {
        return {
            id: `${symbol.filePath}:${symbol.name}:${symbol.rangeStartLine}`,
            name: symbol.name,
            type: symbol.type,
            filePath: symbol.filePath
        };
    }

    /**
     * Get risks for a node
     * Enhanced: Uses AI-calculated riskScore/riskReason + technical debt items
     */
    async getRisks(nodeId: string, nodeType: 'domain' | 'file' | 'symbol'): Promise<InspectorRiskData> {
        let level: 'low' | 'medium' | 'high' = 'low';
        let heatScore = 0;
        const warnings: string[] = [];

        try {
            if (nodeType === 'symbol') {
                const parts = nodeId.split(':');
                if (parts.length >= 3) {
                    const line = parseInt(parts[parts.length - 1], 10);
                    const symbolName = parts[parts.length - 2];
                    const filePath = this.resolvePath(parts.slice(0, -2).join(':'));

                    const fileSymbols = this.db.getSymbolsByFile(filePath);
                    const symbol = fileSymbols.find(s => s.name === symbolName && s.rangeStartLine === line);

                    if (symbol) {
                        // Use AI risk score if available (from Architect Pass)
                        if ((symbol as any).riskScore != null && (symbol as any).riskScore > 0) {
                            heatScore = (symbol as any).riskScore;
                            if ((symbol as any).riskReason) {
                                warnings.push(`AI Risk: ${(symbol as any).riskReason}`);
                            }
                        }

                        // Static complexity check
                        if (symbol.complexity > 15) {
                            warnings.push(`High complexity (${symbol.complexity})`);
                            if (heatScore === 0) heatScore += 30;
                        }

                        // Coupling check
                        const incoming = this.db.getIncomingEdges(symbol.id).length;
                        if (incoming > 20) {
                            warnings.push(`High coupling (called by ${incoming} symbols)`);
                            if (heatScore === 0) heatScore += 20;
                        }

                        // Fragility from Architect Pass
                        if (symbol.fragility === 'high') {
                            warnings.push('AI-flagged as fragile');
                            heatScore = Math.max(heatScore, 60);
                        }

                        // Technical debt items
                        const debtItems = this.db.getTechnicalDebt(symbol.id);
                        for (const item of debtItems) {
                            warnings.push(`${item.smellType}: ${item.description}`);
                            if (item.severity === 'high') heatScore = Math.max(heatScore, 70);
                            else if (item.severity === 'medium') heatScore = Math.max(heatScore, 40);
                        }
                    }
                }

                // P1-C: Domain risk — based on avg complexity across all symbols in domain
            } else if (nodeType === 'domain') {
                const domainName = nodeId.replace(/^domain:/, '');
                const domainSymbols = this.db.getSymbolsByDomain(domainName);

                if (domainSymbols.length > 0) {
                    const avgComplexity = domainSymbols.reduce((s, sym) => s + sym.complexity, 0) / domainSymbols.length;
                    const highComplexitySymbols = domainSymbols.filter(s => s.complexity > 15);
                    const fragileSymbols = domainSymbols.filter(s => s.fragility === 'high');

                    heatScore = Math.min(100, Math.round(avgComplexity * 3.5));

                    if (highComplexitySymbols.length > 0) {
                        warnings.push(`${highComplexitySymbols.length} high-complexity symbol(s) (complexity > 15)`);
                    }
                    if (fragileSymbols.length > 0) {
                        warnings.push(`${fragileSymbols.length} AI-flagged fragile symbol(s)`);
                        heatScore = Math.max(heatScore, 50);
                    }

                    const { crossDomain, total } = this.db.getDomainEdgeCounts(domainName);
                    const coupling = total > 0 ? crossDomain / total : 0;
                    if (coupling > 0.6) {
                        warnings.push(`High cross-domain coupling (${Math.round(coupling * 100)}% of edges cross domain boundary)`);
                        heatScore = Math.max(heatScore, 45);
                    }
                }

                // P1-C: File risk — based on avg complexity + coupling of symbols in file
            } else if (nodeType === 'file') {
                let rawFilePath = nodeId;
                const colonIdx = nodeId.indexOf(':');
                if (colonIdx > 0) {
                    const afterColon = nodeId.substring(colonIdx + 1);
                    if (afterColon.startsWith('/') || /^[a-zA-Z]:/.test(afterColon)) {
                        rawFilePath = afterColon;
                    }
                }
                let filePath = this.resolvePath(rawFilePath);

                const fileSymbols = this.db.getSymbolsByFile(filePath);

                if (fileSymbols.length > 0) {
                    const avgComplexity = fileSymbols.reduce((s, sym) => s + sym.complexity, 0) / fileSymbols.length;
                    const highComplexity = fileSymbols.filter(s => s.complexity > 15);
                    const fragile = fileSymbols.filter(s => s.fragility === 'high');

                    heatScore = Math.min(100, Math.round(avgComplexity * 3.5));

                    if (highComplexity.length > 0) {
                        warnings.push(`${highComplexity.length} high-complexity function(s)`);
                    }
                    if (fragile.length > 0) {
                        warnings.push(`${fragile.length} fragile symbol(s) in this file`);
                        heatScore = Math.max(heatScore, 50);
                    }

                    const { importCount } = this.db.getFileEdgeCounts(filePath);
                    if (importCount > 15) {
                        warnings.push(`High file coupling (${importCount} outgoing imports)`);
                        heatScore = Math.max(heatScore, 35);
                    }
                }
            }

            if (heatScore > 60) level = 'high';
            else if (heatScore > 30) level = 'medium';

        } catch (error) {
            console.error('Error calculating risks:', error);
        }

        return { level, heatScore, warnings };
    }

    /**
     * Execute AI Action
     */
    async executeAIAction(
        nodeId: string,
        action: 'explain' | 'audit' | 'refactor' | 'optimize'
    ): Promise<InspectorAIResult> {

        let prompt = '';
        let analysisType: any = 'general';

        if (action === 'refactor') analysisType = 'refactor';
        else if (action === 'audit') analysisType = 'security';

        // **FIX 2: EXTRACT SYMBOL ID FROM NODE ID**
        // Parse the nodeId to get symbolId for context fetching
        let symbolId: number | undefined;

        // Symbol IDs have format: "filePath:symbolName:line"
        const parts = nodeId.split(':');
        if (parts.length >= 3) {
            const line = parseInt(parts[parts.length - 1], 10);
            const symbolName = parts[parts.length - 2];
            const filePath = this.resolvePath(parts.slice(0, -2).join(':'));

            // Look up the actual symbol ID from the database
            const symbols = this.db.getSymbolsByFile(filePath);
            const symbol = symbols.find(s => s.name === symbolName && s.rangeStartLine === line);

            if (symbol) {
                symbolId = symbol.id;
                console.log(`[Inspector] Resolved nodeId "${nodeId}" to symbolId ${symbolId}`);
            } else {
                console.warn(`[Inspector] Could not resolve symbol from nodeId: ${nodeId}`);
            }
        }

        // Build prompt based on action
        if (action === 'explain') prompt = `Explain in detail what this code does, its purpose, and how it works.`;
        else if (action === 'audit') prompt = `Perform a thorough security audit of this code. Identify vulnerabilities, risky patterns, and suggest fixes.`;
        else if (action === 'refactor') prompt = `Analyze this code for quality issues and suggest specific refactoring improvements with code examples.`;
        else if (action === 'optimize') prompt = `Analyze this code for performance bottlenecks and suggest optimizations.`;

        // P3-B: Guard — if we couldn't resolve a symbolId, bail out early with
        // a helpful message rather than sending a contextless prompt to the AI
        if (!symbolId) {
            return {
                action,
                content: '',
                model: 'none',
                cached: false,
                loading: false,
                error: 'AI analysis requires a symbol node. Select a function or class in the graph first.',
            };
        }

        try {
            // Use orchestrator with proper symbolId for context
            const result = await this.orchestrator.processQuery(prompt, {
                symbolId,  // **THIS IS THE KEY FIX**
                analysisType,
                includeContext: true  // Ensure we fetch full context
            });

            // Check for diff blocks if refactor
            let patch = undefined;
            if (action === 'refactor' && result.content.includes('```diff')) {
                const diffMatch = result.content.match(/```diff\n([\s\S]*?)```/);
                if (diffMatch) {
                    patch = {
                        summary: 'AI Suggested Refactor',
                        impactedNodeCount: 1,
                        diff: diffMatch[1]
                    };
                }
            }

            return {
                action,
                content: result.content,
                model: result.model === 'llama-3.1-8b-instant' ? 'groq' : result.model.includes('gemini') ? 'vertex' : result.model,
                cached: false,
                loading: false,
                patch
            };

        } catch (error) {
            console.error(`[Inspector] AI Action failed:`, error);
            return {
                action,
                content: '',
                model: 'groq',
                cached: false,
                loading: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Explain why a risk is high/medium
     */
    async explainRisk(nodeId: string, metric: string): Promise<string> {
        // Resolve symbol ID for context
        let symbolId: number | undefined;
        let displayName = nodeId;

        const parts = nodeId.split(':');
        if (parts.length >= 3) {
            const line = parseInt(parts[parts.length - 1], 10);
            const symbolName = parts[parts.length - 2];
            const filePath = this.resolvePath(parts.slice(0, -2).join(':'));

            displayName = symbolName;
            const symbols = this.db.getSymbolsByFile(filePath);
            const symbol = symbols.find(s => s.name === symbolName && s.rangeStartLine === line);

            if (symbol) {
                symbolId = symbol.id;
            }
        }

        const prompt = `The symbol "${displayName}" is classified as having a "${metric}" risk level. 
        Analyze the code and explain why this risk level is assigned. 
        Focus on complexity, coupling, and any specific patterns in the implementation that contribute to this risk.
        Be concise but specific to the provided code.`;

        try {
            const result = await this.orchestrator.processQuery(prompt, {
                symbolId,
                analysisType: 'general',
                includeContext: true
            });
            return result.content;
        } catch (error) {
            return `Failed to explain risk: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
}
