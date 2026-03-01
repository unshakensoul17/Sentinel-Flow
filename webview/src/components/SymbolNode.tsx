import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { CouplingMetrics } from '../types';

export interface SymbolNodeData extends Record<string, unknown> {
    label: string;
    symbolType: 'function' | 'method' | 'class' | 'interface' | 'enum' | 'variable' | 'type';
    complexity: number;
    blastRadius?: number;
    isSink?: boolean;
    coupling: CouplingMetrics;
    filePath: string;
    line: number;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
    isHighlighted?: boolean;
    zoomLevel?: number; // Injected from GraphCanvas
}

const SymbolNode = memo(({ data, style }: NodeProps<Node<SymbolNodeData>> & { style?: React.CSSProperties }) => {
    const {
        label,
        symbolType,
        complexity,
        coupling,
        isDimmed = false,
        isActive = false,
        isClickable = true,
        isHighlighted = false,
    } = data;

    // Safe coupling with fallback to avoid crash on undefined
    const safeCoupling = coupling ?? { color: '#3b82f6', cbo: 0, inDegree: 0, outDegree: 0, normalizedScore: 0, nodeId: '' };

    // Icon based on symbol type
    const getIcon = () => {
        switch (symbolType) {
            case 'function': return '𝑓';
            case 'method': return 'ⓜ';
            case 'class': return 'ⓒ';
            case 'interface': return 'ⓘ';
            case 'enum': return 'ⓔ';
            case 'variable': return 'ⓥ';
            case 'type': return 'ⓣ';
            default: return '●';
        }
    };

    // Calculate styling
    const containerOpacity = isDimmed ? 0.55 : 1;
    const borderWidth = isActive || isHighlighted ? 2 : 1;

    // Use coupling color for border, but normalized to health colors if possible?
    // The requirement says "Health should NOT be displayed as text. Instead: Use border color... Healthy #22C55E...".
    // Coupling metrics usually come with a color. Let's assume coupling.color is already mapped or we map it here.
    // If coupling.color represents the "heat", we might want to map it to the 3 distinct colors requested.
    // Let's deduce health from complexity/coupling if raw values available, otherwise use coupling.color but ensure it matches the palette.

    let borderColor = safeCoupling.color; // Default from backend
    if (complexity > 20 || safeCoupling.cbo > 10) borderColor = '#EF4444';
    else if (complexity > 10 || safeCoupling.cbo > 5) borderColor = '#F59E0B';
    else borderColor = '#22C55E';


    return (
        <div
            className="symbol-node-container"
            style={{
                ...style,
                backgroundColor: 'var(--vscode-editor-background)',
                borderRadius: '12px', // More rounded for symbols
                border: `${borderWidth}px solid ${borderColor}`,
                opacity: containerOpacity,
                boxShadow: isHighlighted ? `0 0 0 2px ${borderColor}40` : 'none',
                width: '100%',
                height: '100%',
                cursor: isClickable ? 'pointer' : 'default',
                pointerEvents: isDimmed ? 'none' : 'auto',
                transition: 'all 0.2s ease',
                display: 'flex',
                alignItems: 'center',
                padding: '4px 8px',
                gap: '8px',
                fontSize: '14px', // Increased from 13px
                color: 'var(--vscode-editor-foreground)',
            }}
            title={`Symbol: ${label}\nType: ${symbolType}\nComplexity: ${complexity}\nCBO: ${safeCoupling.cbo}`}
        >
            <Handle type="target" position={Position.Top} className="w-1 h-1 !bg-gray-400" />

            {/* Icon */}
            <span
                className="font-bold text-lg leading-none"
                style={{ color: borderColor, fontSize: '18px' }}
            >
                {getIcon()}
            </span>

            {/* Name - Hidden at low zoom levels via CSS/Parent */}
            <div className="flex-1 min-w-0 flex flex-col justify-center node-label">
                <span className="font-medium truncate leading-tight">
                    {label}
                </span>

                {/* Optional: Small subtitle for very high zoom? for now just name as requested "Icon + Node Name" */}
            </div>

            {/* Is Sink Indicator */}
            {data.isSink && (
                <span className="text-[8px] font-bold text-red-500 border border-red-500 rounded px-1" title="Sink">
                    S
                </span>
            )}

            <Handle type="source" position={Position.Bottom} className="w-1 h-1 !bg-gray-400" />
        </div>
    );
});

SymbolNode.displayName = 'SymbolNode';

export default SymbolNode;
