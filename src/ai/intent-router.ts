// Purpose: Intent classification for AI query routing
// Determines whether a query should use the fast reflex path (Groq/Llama)
// or the thorough strategic path (Gemini)

/**
 * Intent types for routing decisions
 */
export type IntentType = 'reflex' | 'strategic';

/**
 * Classified intent with confidence score
 */
export interface ClassifiedIntent {
    type: IntentType;
    confidence: number;
    query: string;
    matchedPattern?: string;
}

/**
 * Pattern definition for intent matching
 */
interface IntentPattern {
    pattern: RegExp;
    type: IntentType;
    weight: number;
}

/**
 * Intent Router - classifies queries into reflex or strategic paths
 * 
 * Reflex Path (Groq/Llama 3.1):
 * - Simple explanations: "Explain this node", "What does this function do?"
 * - Quick lookups: "Describe", "Show me", "What is"
 * - Target: <300ms response time
 * 
 * Strategic Path (Gemini 1.5 Pro):
 * - Complex analysis: "Audit for security", "Refactor this dependency graph"
 * - Multi-file reasoning: "Analyze dependencies", "Find all usages"
 * - Deep code review tasks
 */
export class IntentRouter {
    private reflexPatterns: IntentPattern[] = [
        // Simple explanation queries
        { pattern: /\b(explain|describe|what is|what does|what's|show me)\b/i, type: 'reflex', weight: 1.0 },
        // Quick lookup patterns
        { pattern: /\b(tell me about|give me|how does)\b.*\b(work|function|do)\b/i, type: 'reflex', weight: 0.9 },
        // Single item focus
        { pattern: /\b(this|the)\s+(function|class|method|variable|node)\b/i, type: 'reflex', weight: 0.8 },
        // Simple questions
        { pattern: /^(what|how|where|why)\s+\w+\s*\?*$/i, type: 'reflex', weight: 0.7 },
    ];

    private strategicPatterns: IntentPattern[] = [
        // Security and audit patterns
        { pattern: /\b(audit|security|vulnerability|vulnerabilities|secure|attack|exploit)\b/i, type: 'strategic', weight: 1.0 },
        // Refactoring patterns
        { pattern: /\b(refactor|restructure|reorganize|optimize|improve)\b/i, type: 'strategic', weight: 1.0 },
        // Dependency analysis
        { pattern: /\b(dependency|dependencies|graph|relationship|coupling)\b/i, type: 'strategic', weight: 0.9 },
        // Multi-file patterns
        { pattern: /\b(module|project|codebase|entire|all files|across)\b/i, type: 'strategic', weight: 0.8 },
        // Complex analysis
        { pattern: /\b(analyze|analysis|review|assess|evaluate|architecture)\b/i, type: 'strategic', weight: 0.85 },
        // Find all usages
        { pattern: /\b(find all|list all|show all|every|all usages|all references)\b/i, type: 'strategic', weight: 0.9 },
        // Impact analysis
        { pattern: /\b(impact|affect|change|breaking|migrate|migration)\b/i, type: 'strategic', weight: 0.85 },
    ];

    /**
     * Classify a query into reflex or strategic intent
     */
    classify(query: string): ClassifiedIntent {
        const normalizedQuery = query.trim().toLowerCase();

        // Score both paths
        let reflexScore = 0;
        let reflexMatch: string | undefined;
        let strategicScore = 0;
        let strategicMatch: string | undefined;

        // Check reflex patterns
        for (const { pattern, weight } of this.reflexPatterns) {
            if (pattern.test(normalizedQuery)) {
                if (weight > reflexScore) {
                    reflexScore = weight;
                    reflexMatch = pattern.source;
                }
            }
        }

        // Check strategic patterns
        for (const { pattern, weight } of this.strategicPatterns) {
            if (pattern.test(normalizedQuery)) {
                if (weight > strategicScore) {
                    strategicScore = weight;
                    strategicMatch = pattern.source;
                }
            }
        }

        // Determine winning intent
        // Strategic patterns take priority when scores are close (threshold: 0.2)
        if (strategicScore > 0 && (strategicScore >= reflexScore - 0.2)) {
            return {
                type: 'strategic',
                confidence: strategicScore,
                query,
                matchedPattern: strategicMatch,
            };
        }

        if (reflexScore > 0) {
            return {
                type: 'reflex',
                confidence: reflexScore,
                query,
                matchedPattern: reflexMatch,
            };
        }

        // Default to reflex for simple/unmatched queries (faster response)
        return {
            type: 'reflex',
            confidence: 0.5,
            query,
        };
    }

    /**
     * Quick check if query is definitely strategic
     */
    isStrategic(query: string): boolean {
        return this.classify(query).type === 'strategic';
    }

    /**
     * Quick check if query is definitely reflex
     */
    isReflex(query: string): boolean {
        return this.classify(query).type === 'reflex';
    }
}

// Export singleton instance
export const intentRouter = new IntentRouter();
