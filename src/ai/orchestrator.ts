// Purpose: Main AI Orchestrator
// Wires together intent routing, context assembly, and model clients
// Routes queries to appropriate AI model based on intent classification

import { IntentRouter, ClassifiedIntent } from './intent-router';
import { GroqClient, createGroqClient } from './groq-client';
import { VertexClient, createVertexClient } from './vertex-client';
import { GeminiClient, createGeminiClient } from './gemini-client';
import { BedrockClient, createBedrockClient } from './bedrock-client';
import { CodeIndexDatabase } from '../db/database';
import { SymbolContext } from '../db/schema';
import { DomainClassification, DomainType } from '../domain/classifier';
import * as fs from 'fs';

/**
 * Structured JSON context sent to the AI for node analysis.
 * Only the targetSymbol includes raw source code.
 * Neighbors are lightweight metadata stubs (no file reads).
 */
export interface NodeDependencyStub {
    name: string;
    type: string;           // function, class, variable, etc.
    filePath: string;
    relationType: string;   // 'call' | 'import' | 'inherit' | 'implement'
}

export interface NodeContext {
    targetSymbol: {
        name: string;
        type: string;
        filePath: string;
        lines: string;           // "startLine-endLine"
        complexity: number;
        code: string;            // Raw source code of this symbol only
    };
    dependencies: {
        outgoing: NodeDependencyStub[]; // what this symbol calls / imports
        incoming: NodeDependencyStub[]; // what calls / imports this symbol
    };
}

/**
 * AI Response from the orchestrator
 */
export interface AIResponse {
    content: string;
    model: string;
    intent: ClassifiedIntent;
    latencyMs: number;
    contextIncluded: boolean;
    neighborCount?: number;
}

/**
 * AI Query options
 */
export interface AIQueryOptions {
    symbolId?: number;
    symbolName?: string;
    includeContext?: boolean;
    analysisType?: 'security' | 'refactor' | 'dependencies' | 'general';
}

/**
 * AI Orchestrator - Main controller for AI-powered code analysis
 * 
 * Intent Routing:
 * - Reflex Path (Groq/Llama 3.1): Fast <300ms responses for simple queries
 * - Strategic Path (Vertex AI/Gemini 1.5 Pro): Deep analysis for complex queries
 * 
 * Context Assembly (cAST):
 * - Fetches target symbol + 1st-degree neighbors from SQLite
 * - Packages code context into AI prompts
 * 
 * MCP Integration:
 * - Exposes database as tools for AI access
 * - Read-only, strictly defined interfaces
 */
export class AIOrchestrator {
    private intentRouter: IntentRouter;
    private groqClient: GroqClient | null;
    private vertexClient: VertexClient | null;
    private geminiClient: GeminiClient | null;
    private bedrockClient: BedrockClient | null;

    /** Which provider to use for the strategic (deep analysis) path */
    private aiProvider: 'gemini' | 'bedrock' = 'gemini';

    private db: CodeIndexDatabase;

    constructor(db: CodeIndexDatabase) {
        this.db = db;
        this.intentRouter = new IntentRouter();


        // Initialize AI clients (will be null if API keys not available)
        this.groqClient = createGroqClient();
        this.vertexClient = createVertexClient();
        this.geminiClient = createGeminiClient();
        // Bedrock is initialized lazily when config is provided
        this.bedrockClient = createBedrockClient();
    }

    /**
     * Process an AI query with automatic routing
     */
    async processQuery(query: string, options: AIQueryOptions = {}): Promise<AIResponse> {
        const startTime = performance.now();

        // 1. Classify intent
        const intent = this.intentRouter.classify(query);
        console.log(`[Orchestrator] Intent: ${intent.type} (confidence: ${intent.confidence.toFixed(2)})`);

        // 2. Assemble context from SQLite if a symbol was provided
        let context: SymbolContext | null = null;
        let nodeContext: NodeContext | null = null;

        if (options.symbolId || options.symbolName) {
            context = await this.assembleContext(options);
            if (context) {
                nodeContext = this.buildNodeContext(context);
            }
        }

        // 3. Build prompt using structured JSON context
        const prompt = this.buildPrompt(query, nodeContext);

        // 4. Check Cache
        let cacheHash: string | null = null;
        if (nodeContext) {
            cacheHash = this.computeCacheHash(query, nodeContext, options.analysisType);
            const cachedEntry = this.db.getAICache(cacheHash);
            if (cachedEntry) {
                try {
                    const cachedResponse = JSON.parse(cachedEntry.response) as AIResponse;
                    console.log(`[Orchestrator] Cache hit for hash ${cacheHash.substring(0, 8)}`);
                    cachedResponse.latencyMs = 0; // Reset latency for cache hit
                    return cachedResponse;
                } catch (error) {
                    console.error('Failed to parse cached response:', error);
                }
            }
        }

        // 5. Route to appropriate model
        let response: AIResponse;

        // forceReflex=true bypasses intent classification for fast, interactive queries
        // (Inspector panel buttons). The strategic path (Gemini) takes 120-170s for
        // preview models — far too slow for on-demand UI actions.
        if (options.forceReflex || intent.type === 'reflex') {
            response = await this.executeReflexPath(prompt, intent, context);
        } else {
            response = await this.executeStrategicPath(
                prompt,
                intent,
                context,
                options.analysisType || 'general'
            );
        }

        const endTime = performance.now();
        response.latencyMs = Math.round(endTime - startTime);

        // 6. Cache Response
        if (cacheHash && response.model !== 'none') {
            this.db.setAICache(cacheHash, JSON.stringify(response));
        }

        return response;
    }

    /**
     * Compute cache hash based on query, structured node context, and analysis type.
     * Hashes the target symbol's code + its dependency stubs (not neighbor raw code).
     */
    private computeCacheHash(query: string, nodeContext: NodeContext, analysisType?: string): string {
        const str = JSON.stringify({
            query,
            targetCode: nodeContext.targetSymbol.code,
            outgoingIds: nodeContext.dependencies.outgoing.map(d => d.name + d.filePath),
            incomingIds: nodeContext.dependencies.incoming.map(d => d.name + d.filePath),
            analysisType: analysisType || 'general'
        });
        return CodeIndexDatabase.computeHash(str);
    }

    /**
     * Assemble context from database
     */
    private async assembleContext(options: AIQueryOptions): Promise<SymbolContext | null> {
        let symbolId = options.symbolId;

        // Resolve symbol by name if needed
        if (!symbolId && options.symbolName) {
            const symbol = this.db.getSymbolByName(options.symbolName);
            if (symbol) {
                symbolId = symbol.id;
            }
        }

        if (!symbolId) {
            return null;
        }

        return this.db.getSymbolWithContext(symbolId);
    }

    /**
     * Build a structured NodeContext JSON for AI prompts.
     *
     * Strategy:
     *   - TARGET: Read raw source code from disk (only this one file read).
     *   - NEIGHBORS: Map incoming/outgoing edges to lightweight stubs using
     *     already-available SQLite data. Zero file system reads for neighbors.
     *
     * This replaces the old extractCodeSnippets approach which dumped thousands
     * of lines of raw neighbor code into the prompt, causing token bloat and
     * LLM "Lost in the Middle" confusion.
     */
    private buildNodeContext(context: SymbolContext): NodeContext {
        const { symbol, outgoingEdges, incomingEdges, neighbors } = context;

        // --- 1. Read TARGET source code from disk (the only file read) ---
        let targetCode = '// Source code unavailable';
        try {
            if (fs.existsSync(symbol.filePath)) {
                const content = fs.readFileSync(symbol.filePath, 'utf-8');
                const lines = content.split('\n');
                const start = Math.max(0, symbol.rangeStartLine - 1);
                const end = Math.min(lines.length, symbol.rangeEndLine);
                targetCode = lines.slice(start, end).join('\n');
            } else {
                targetCode = `// File not found: ${symbol.filePath}`;
            }
        } catch (error) {
            targetCode = `// Error reading file: ${(error as Error).message}`;
        }

        // --- 2. Build a fast lookup map of neighbor id -> symbol for edge resolution ---
        const neighborMap = new Map<number, typeof neighbors[number]>();
        for (const n of neighbors) {
            neighborMap.set(n.id, n);
        }

        // --- 3. Map outgoing edges (what this symbol calls/imports) ---
        const outgoing: NodeDependencyStub[] = [];
        for (const edge of outgoingEdges) {
            const target = neighborMap.get(edge.targetId);
            if (target) {
                outgoing.push({
                    name: target.name,
                    type: target.type,
                    filePath: target.filePath,
                    relationType: edge.type,
                });
            }
        }

        // --- 4. Map incoming edges (what calls/imports this symbol) ---
        const incoming: NodeDependencyStub[] = [];
        for (const edge of incomingEdges) {
            const source = neighborMap.get(edge.sourceId);
            if (source) {
                incoming.push({
                    name: source.name,
                    type: source.type,
                    filePath: source.filePath,
                    relationType: edge.type,
                });
            }
        }

        console.log(
            `[Orchestrator] NodeContext built: target="${symbol.name}" ` +
            `outgoing=${outgoing.length} incoming=${incoming.length} (0 neighbor file reads)`
        );

        return {
            targetSymbol: {
                name: symbol.name,
                type: symbol.type,
                filePath: symbol.filePath,
                lines: `${symbol.rangeStartLine}-${symbol.rangeEndLine}`,
                complexity: symbol.complexity,
                code: targetCode,
            },
            dependencies: { outgoing, incoming },
        };
    }

    /**
     * Build the final LLM prompt using the structured NodeContext.
     *
     * Structure:
     *   1. Target symbol source code (raw — AI needs to read this)
     *   2. Dependency graph JSON block (lightweight stubs, no raw neighbor code)
     *   3. Architectural analysis instruction (Chain-of-Thought)
     *   4. The specific user question / task
     */
    private buildPrompt(query: string, nodeContext: NodeContext | null): string {
        let prompt = '';

        if (nodeContext) {
            const { targetSymbol, dependencies } = nodeContext;

            // --- Block 1: Target source code ---
            prompt += `## Target Symbol\n`;
            prompt += `Name: ${targetSymbol.name}\n`;
            prompt += `Type: ${targetSymbol.type}\n`;
            prompt += `File: ${targetSymbol.filePath}\n`;
            prompt += `Lines: ${targetSymbol.lines}\n`;
            prompt += `Complexity Score: ${targetSymbol.complexity}\n\n`;
            prompt += `### Source Code\n\`\`\`\n${targetSymbol.code}\n\`\`\`\n\n`;

            // --- Block 2: Dependency graph as structured JSON ---
            // Uses only SQLite edge data — zero neighbor file reads.
            const dependencyGraph = {
                outgoing: dependencies.outgoing.map(d => ({
                    name: d.name,
                    type: d.type,
                    file: d.filePath,
                    relation: d.relationType,
                })),
                incoming: dependencies.incoming.map(d => ({
                    name: d.name,
                    type: d.type,
                    file: d.filePath,
                    relation: d.relationType,
                })),
            };

            if (dependencies.outgoing.length > 0 || dependencies.incoming.length > 0) {
                prompt += `## Dependency Graph\n`;
                prompt += `The following JSON describes what this symbol depends on and what depends on it.\n`;
                prompt += `\`\`\`json\n${JSON.stringify(dependencyGraph, null, 2)}\n\`\`\`\n\n`;
            }

            // --- Block 3: Chain-of-Architectural-Thought instruction ---
            prompt += `## Architectural Analysis\n`;
            prompt += `Before answering, identify the architectural pattern(s) in this code `;
            prompt += `(e.g., Factory, Singleton, Observer, Middleware, Repository, CQRS, `;
            prompt += `Event-Driven, Strategy, Decorator). Use the dependency graph above to trace `;
            prompt += `data flow and coupling. State the pattern(s), then answer in that context.\n\n`;
        }

        // --- Block 4: The actual question ---
        prompt += `## Question\n${query}`;

        return prompt;
    }

    /**
     * Execute reflex path (Groq/Llama 3.1)
     * Optimized for speed but now allows technical detail
     */
    private async executeReflexPath(
        prompt: string,
        intent: ClassifiedIntent,
        context: SymbolContext | null
    ): Promise<AIResponse> {
        if (!this.groqClient) {
            return {
                content: 'Groq client not available. Please set GROQ_API_KEY environment variable.',
                model: 'none',
                intent,
                latencyMs: 0,
                contextIncluded: !!context,
                neighborCount: context?.neighbors.length,
            };
        }

        // **FIX 3: LOOSEN CONSTRAINTS FOR DEEP ANALYSIS**
        // Allow more detail when we have context (Inspector panel)
        // Keep it brief for quick queries without context
        const systemPrompt = context
            ? `You are a code analysis expert. Provide clear, technical explanations.
When analyzing code, explain:
- What it does
- How it works (key logic)
- Potential issues or improvements

Be concise but thorough - aim for 50-150 words for most explanations.`
            : `You are a code assistant providing quick explanations.
Keep responses brief and focused - under 30 words when possible.`;

        const response = await this.groqClient.complete(prompt, systemPrompt);

        return {
            content: response.content,
            model: response.model,
            intent,
            latencyMs: response.latencyMs,
            contextIncluded: !!context,
            neighborCount: context?.neighbors.length,
        };
    }

    /**
     * Execute strategic path — routes to Bedrock or Gemini/Vertex based on aiProvider setting.
     * Falls back to Groq on any strategic path failure.
     */
    private async executeStrategicPath(
        prompt: string,
        intent: ClassifiedIntent,
        context: SymbolContext | null,
        analysisType: 'security' | 'refactor' | 'dependencies' | 'general'
    ): Promise<AIResponse> {
        // --- Route based on the active provider ---
        if (this.aiProvider === 'bedrock') {
            if (!this.bedrockClient) {
                console.warn('[Orchestrator] Bedrock selected but client not initialized. Falling back to Groq.');
                return this.executeReflexPath(prompt, intent, context);
            }

            try {
                const response = await this.bedrockClient.analyzeCode(
                    prompt,
                    [],
                    analysisType,
                    intent.query
                );
                return {
                    content: response.content,
                    model: response.model,
                    intent,
                    latencyMs: response.latencyMs,
                    contextIncluded: !!context,
                    neighborCount: context?.neighbors.length,
                };
            } catch (error) {
                const errorMsg = (error as Error).message;
                console.warn(`[Orchestrator] Bedrock failed: ${errorMsg}. Falling back to Groq.`);
                const fallback = await this.executeReflexPath(prompt, intent, context);

                let detailedExplanation = "Bedrock request failed.";
                if (errorMsg.includes("Operation not allowed") || errorMsg.includes("AccessDenied")) {
                    detailedExplanation = `**Model Access Required!**\n\nAWS rejected the request with "Operation not allowed". AWS has recently updated their Bedrock permission flow and the old "Model Access" page is retired.\n\n**To fix this for Anthropic models:**\n1. In the AWS console left menu, click **Model catalog**.\n2. Click on the model you want to use (e.g. Claude 3 Haiku).\n3. Click **Request Model Access** or attempt to open it in the **Playground**.\n4. You will likely be prompted to submit "Use case details" or accept AWS Marketplace permissions for Anthropic.\n5. Complete the prompt. Once you can successfully prompt the model in the AWS Playground, it will instantly start working here!\n\n*(It takes 1-2 minutes for access to activate).*`;
                }

                return {
                    ...fallback,
                    content: `> ⚠️ **Bedrock Unreachable:** ${errorMsg}\n\n${detailedExplanation}\n\n---\n*Falling back to Groq/Llama...*\n\n${fallback.content}`,
                    model: `${fallback.model} (Fallback)`,
                };
            }
        }

        // --- Gemini / Vertex path (default) ---
        const client = this.geminiClient || this.vertexClient;

        if (!client) {
            throw new Error('AI Strategic client not configured. Required for default routing.');
        }

        try {
            const response = await client.analyzeCode(
                prompt,
                [],
                analysisType,
                intent.query
            );

            return {
                content: response.content,
                model: response.model,
                intent,
                latencyMs: response.latencyMs,
                contextIncluded: !!context,
                neighborCount: context?.neighbors.length,
            };
        } catch (error) {
            console.warn(`[Orchestrator] Strategic AI (${client === this.geminiClient ? 'Gemini' : 'Vertex'}) failed. Error: ${(error as Error).message}. Falling back to Reflex path (Groq).`);

            const fallbackResponse = await this.executeReflexPath(prompt, intent, context);

            if (fallbackResponse.model === 'none') {
                return fallbackResponse;
            }

            return {
                ...fallbackResponse,
                content: `> ⚠️ **Strategic AI unreachable.** Falling back to fast local-path analysis.\n\n${fallbackResponse.content}`,
                model: `${fallbackResponse.model} (Fallback)`
            };
        }
    }

    /**
     * Execute MCP tool call
     */


    /**
     * Get available MCP tools
     */


    /**
     * Check if Groq client is available
     */
    hasGroqClient(): boolean {
        return this.groqClient !== null;
    }

    /**
     * Check if Vertex AI client is available
     */
    hasVertexClient(): boolean {
        return this.vertexClient !== null;
    }

    /**
     * Classify symbol domain using AI
     * Uses Groq for fast classification or falls back to heuristics
     */


    /**
     * Get intent classification without executing query
     */
    classifyIntent(query: string): ClassifiedIntent {
        return this.intentRouter.classify(query);
    }
    /**
     * Update AI client configuration
     */
    updateConfig(config: { vertexProject?: string; groqApiKey?: string; geminiApiKey?: string; awsRegion?: string; bedrockModelId?: string; awsAccessKeyId?: string; awsSecretAccessKey?: string; aiProvider?: 'gemini' | 'bedrock' }) {
        if (config.groqApiKey) {
            console.log('[Orchestrator] Updating Groq client with new API key');
            this.groqClient = createGroqClient({ apiKey: config.groqApiKey });
        }

        if (config.vertexProject) {
            console.log('[Orchestrator] Updating Vertex AI client with new project ID');
            this.vertexClient = createVertexClient({ projectId: config.vertexProject });
        }

        if (config.geminiApiKey) {
            console.log('[Orchestrator] Updating Gemini client with new API key');
            this.geminiClient = createGeminiClient({ apiKey: config.geminiApiKey });
        }

        if (config.awsRegion || config.bedrockModelId || config.awsAccessKeyId) {
            console.log('[Orchestrator] Updating Bedrock client with new config');
            this.bedrockClient = createBedrockClient({
                region: config.awsRegion,
                modelId: config.bedrockModelId,
                accessKeyId: config.awsAccessKeyId,
                secretAccessKey: config.awsSecretAccessKey
            });
        }

        if (config.aiProvider) {
            console.log(`[Orchestrator] AI provider switched to: ${config.aiProvider}`);
            this.aiProvider = config.aiProvider;
        }
    }
    // } removed to keep methods inside class

    /**
     * Optimized Domain Classification using the Architecture Skeleton (JSON 1)
     * Categorizes files into domains and generates high-level summaries.
     */


    /**
     * Architect Pass: Refine system graph using Gemini 1.5 Pro
     * Sends structural skeleton to AI to infer purpose, impact, and implicit links
     */


    /**
     * Reflex Pass: Get instant insight for a node using Groq (Llama 3.1)
     * Target latency < 200ms
     */
    async getNodeInsight(nodeMetadata: any, question: string): Promise<string> {
        if (!this.groqClient) {
            return "AI Insight unavailable (Groq key missing)";
        }

        const context = JSON.stringify({
            name: nodeMetadata.name,
            type: nodeMetadata.type,
            purpose: nodeMetadata.purpose,
            tags: nodeMetadata.search_tags,
            fragility: nodeMetadata.fragility
        });

        const prompt = `Node Context: ${context}\n\nQuestion: ${question}\n\nAnswer concisely (under 20 words):`;
        const systemPrompt = "You are a coding expert. Be extremely concise.";

        try {
            const response = await this.groqClient.complete(prompt, systemPrompt);
            return response.content;
        } catch (error) {
            console.warn('[Orchestrator] Reflex pass failed:', error);
            return "Insight generation failed.";
        }
    }
    /**
     * Semantic module labeling using Gemini
     * Generates human-friendly names for top-level folders based on contents and imports
     */

}

/**
 * Create an AI orchestrator instance
 */
export function createOrchestrator(db: CodeIndexDatabase): AIOrchestrator {
    return new AIOrchestrator(db);
}
