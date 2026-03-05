/**
 * AI Actions Section Component
 *
 * Renders action buttons:
 * - ▶ Explain
 * - ⚠ Audit
 * - 🛠 Refactor
 * - 🔗 Dependencies
 * - 📊 Optimize
 *
 * Shows loading state, cache indicator, and model used
 * Renders markdown results inline
 */

import { memo, useCallback, useState, useEffect, useRef } from 'react';
import { useSelectedId, useNodeType, useAIResult, useIsLoadingAI, useInspectorActions } from '../../stores/useInspectorStore';
import CollapsibleSection from './CollapsibleSection';
import { getDataProvider } from '../../panel/dataProvider';
import type { VSCodeAPI } from '../../types';
import type { AIResult } from '../../types/inspector';

interface AIActionsSectionProps {
    vscode: VSCodeAPI;
}

type AIAction = 'explain' | 'audit' | 'refactor' | 'optimize';

const AI_ACTIONS: { action: AIAction; icon: string; label: string }[] = [
    { action: 'explain', icon: '▶', label: 'Explain' },
    { action: 'audit', icon: '⚠', label: 'Audit' },
    { action: 'refactor', icon: '🛠', label: 'Refactor' },
    { action: 'optimize', icon: '📊', label: 'Optimize' },
];

const AIActionsSection = memo(({ vscode }: AIActionsSectionProps) => {
    const selectedId = useSelectedId();
    const nodeType = useNodeType();
    const aiResult = useAIResult();
    const isLoading = useIsLoadingAI();
    const { setAIResult, setLoadingAI } = useInspectorActions();

    const [activeAction, setActiveAction] = useState<AIAction | null>(null);
    const [elapsedSec, setElapsedSec] = useState(0);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Start/stop elapsed timer in sync with loading state
    useEffect(() => {
        if (isLoading) {
            setElapsedSec(0);
            timerRef.current = setInterval(() => setElapsedSec(s => s + 1), 1000);
        } else {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        }
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [isLoading]);

    const handleActionClick = useCallback(
        async (action: AIAction) => {
            if (!selectedId || isLoading) return;

            setActiveAction(action);
            setLoadingAI(true);

            try {
                const provider = getDataProvider(vscode);
                const result = await provider.executeAIAction(selectedId, action);
                setAIResult({
                    action,
                    content: result.content || '',
                    model: result.model || 'groq',
                    cached: result.cached || false,
                    loading: false,
                    patch: result.patch
                });
            } catch (error) {
                setAIResult({
                    action,
                    content: '',
                    model: 'groq',
                    cached: false,
                    loading: false,
                    error: error instanceof Error ? error.message : 'Failed to execute action',
                });
            }
        },
        [selectedId, isLoading, vscode, setAIResult, setLoadingAI]
    );

    const handleClearResult = useCallback(() => {
        setAIResult(null);
        setActiveAction(null);
    }, [setAIResult]);

    return (
        <CollapsibleSection id="ai-actions" title="AI Actions" icon="🤖" loading={false}>
            <div className="ai-actions-container">
                {/* P3-A: Guard — AI actions only work on symbol nodes */}
                {nodeType !== 'symbol' ? (
                    <div className="ai-actions-unavailable">
                        <span className="ai-unavailable-icon">⚡</span>
                        <span className="ai-unavailable-text">
                            AI actions are available for <strong>symbol nodes</strong> only.
                            Click a function or class in the graph to analyse it.
                        </span>
                    </div>
                ) : (
                    <>
                        {/* Action Buttons */}
                        <div className="ai-action-buttons">
                            {AI_ACTIONS.map(({ action, icon, label }) => (
                                <button
                                    key={action}
                                    className={`ai-action-btn ${activeAction === action ? 'active' : ''}`}
                                    onClick={() => handleActionClick(action)}
                                    disabled={isLoading || !selectedId}
                                    title={label}
                                >
                                    <span className="ai-action-icon">{icon}</span>
                                    <span className="ai-action-label">{label}</span>
                                </button>
                            ))}
                        </div>

                        {/* Loading State */}
                        {isLoading && (
                            <div className="ai-loading">
                                <span className="ai-loading-spinner">⏳</span>
                                <div className="ai-loading-text">
                                    <span>Analysing with AI… {elapsedSec}s</span>
                                    {elapsedSec >= 5 && (
                                        <span className="ai-loading-hint">Using Gemini for deep analysis</span>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Result Display */}
                        {aiResult && !isLoading && (
                            <div className="ai-result-container">
                                {/* Result Header */}
                                <div className="ai-result-header">
                                    <div className="ai-result-meta">
                                        <span className="ai-model-badge">
                                            {aiResult.model === 'gemini' ? '💡 Gemini' : aiResult.model === 'bedrock' ? '☁ Bedrock' : '⚡ Groq'}
                                        </span>
                                        {aiResult.cached && (
                                            <span className="ai-cached-badge">📦 Cached</span>
                                        )}
                                    </div>
                                    <button
                                        className="ai-result-close"
                                        onClick={handleClearResult}
                                        title="Clear result"
                                    >
                                        ×
                                    </button>
                                </div>

                                {/* Error State */}
                                {aiResult.error && (
                                    <div className="ai-error">
                                        ❌ {aiResult.error}
                                    </div>
                                )}

                                {/* Content */}
                                {aiResult.content && (
                                    <div className="ai-result-content">
                                        <AIMarkdownRenderer content={aiResult.content} />
                                    </div>
                                )}

                                {/* Refactor Patch */}
                                {aiResult.patch && (
                                    <RefactorPatchDisplay patch={aiResult.patch} vscode={vscode} />
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </CollapsibleSection>
    );
});

// Full-featured markdown renderer for AI results
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const AIMarkdownRenderer = memo(({ content }: { content: string }) => {
    return (
        <div className="ai-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
            </ReactMarkdown>
        </div>
    );
});

AIMarkdownRenderer.displayName = 'AIMarkdownRenderer';

// Refactor patch display component
interface RefactorPatchDisplayProps {
    patch: { summary: string; impactedNodeCount: number; diff: string };
    vscode: VSCodeAPI;
}

const RefactorPatchDisplay = memo(({ patch, vscode }: RefactorPatchDisplayProps) => {
    const handlePreview = useCallback(() => {
        vscode.postMessage({
            type: 'preview-refactor',
            diff: patch.diff,
        });
    }, [vscode, patch.diff]);

    const handleApply = useCallback(() => {
        vscode.postMessage({
            type: 'apply-refactor',
            diff: patch.diff,
        });
    }, [vscode, patch.diff]);

    const handleCancel = useCallback(() => {
        // Just close the patch display
    }, []);

    return (
        <div className="refactor-patch">
            <div className="patch-summary">
                <strong>Summary:</strong> {patch.summary}
            </div>
            <div className="patch-impact">
                <strong>Impact:</strong> {patch.impactedNodeCount} nodes affected
            </div>
            <div className="patch-actions">
                <button className="patch-btn preview" onClick={handlePreview}>
                    👁 Preview
                </button>
                <button className="patch-btn apply" onClick={handleApply}>
                    ✅ Apply
                </button>
                <button className="patch-btn cancel" onClick={handleCancel}>
                    ❌ Cancel
                </button>
            </div>
        </div>
    );
});

RefactorPatchDisplay.displayName = 'RefactorPatchDisplay';
AIActionsSection.displayName = 'AIActionsSection';

export default AIActionsSection;
