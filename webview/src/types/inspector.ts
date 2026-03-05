/**
 * Inspector Panel Type Definitions
 * Types for the right-side contextual inspector panel
 */

// Node types for selection
export type NodeType = 'domain' | 'file' | 'symbol';

// Selection message from graph
export interface SelectNodeMessage {
    type: 'select-node';
    id: string;
    nodeType: NodeType;
}

// Overview data varies by node type
export interface OverviewData {
    nodeType: NodeType;
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

export interface DependencyItem {
    id: string;
    name: string;
    type: string;
    filePath: string;
}

export interface DependencyData {
    calls: DependencyItem[]; // Outgoing: Function calls
    calledBy: DependencyItem[]; // Incoming: Called by
    imports: DependencyItem[]; // Outgoing: File imports
    usedBy: DependencyItem[]; // Incoming: Used by files
}

export interface RiskData {
    level: 'low' | 'medium' | 'high';
    heatScore: number;
    warnings: string[];
}

export interface AIResult {
    action: string;
    content: string;
    model: 'groq' | 'gemini' | 'bedrock' | string;
    cached: boolean;
    loading: boolean;
    error?: string;
    patch?: RefactorPatch;
}

export interface RefactorPatch {
    summary: string;
    impactedNodeCount: number;
    diff: string;
}

export interface ImpactData {
    summary: string;
    impactedNodes: number;
    preview?: string;
}

// Inspector state - immutable for stable references
export interface InspectorState {
    selectedId: string | null;
    nodeType: NodeType | null;

    overview: OverviewData | null;
    deps: DependencyData | null;
    risks: RiskData | null;
    ai: AIResult | null;
    impact: ImpactData | null;

    // Loading states
    isLoadingOverview: boolean;
    isLoadingDeps: boolean;
    isLoadingRisks: boolean;
    isLoadingAI: boolean;

    // Collapsed sections (array for stable serialization)
    collapsedSections: string[];
}
