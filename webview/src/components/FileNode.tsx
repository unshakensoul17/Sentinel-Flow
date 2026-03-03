import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';

export interface FileNodeData extends Record<string, unknown> {
    label?: string;
    filePath: string;
    symbolCount: number;
    avgCoupling: number;
    avgFragility?: number;
    totalBlastRadius?: number;
    collapsed: boolean;
    nodeId: string;
    onToggleCollapse?: (id: string) => void;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
    zoomLevel?: number; // Injected from GraphCanvas
}

const FileNode = memo(({ data, style }: NodeProps<Node<FileNodeData>> & { style?: React.CSSProperties }) => {
    const {
        filePath,
        symbolCount,
        avgCoupling,
        isDimmed = false,
        isActive = false,
        isClickable = true,
        collapsed,
        nodeId,
        onToggleCollapse,
    } = data;

    const fileName = filePath.split('/').pop() || filePath;

    // Color based on Health (Avg Coupling as proxy)
    // Healthy: #22C55E (Green), Medium: #F59E0B (Amber), Risky: #EF4444 (Red)
    const getBorderColor = () => {
        if (avgCoupling < 0.3) return '#22C55E'; // Green
        if (avgCoupling < 0.6) return '#F59E0B'; // Amber
        return '#EF4444'; // Red
    };

    const borderColor = getBorderColor();

    // Calculate styling
    const containerOpacity = isDimmed ? 0.55 : 1;
    const borderWidth = isActive ? 5 : 3; // Thicker border

    // Zoom-based details class (handled by parent container class in CSS usually, but here we can use conditional rendering if needed)
    // We'll use specific classes that GraphCanvas will toggle on the container, but we can also use the data.zoomLevel if passed
    // For now, we render the structure, and CSS will handle the hiding based on parent classes if strictly CSS,
    // or we can use the zoomLevel logic here if we pass it down. 
    // The requirement said "Zoom-based detail... Zoom < 0.6 show only icon+name". 
    // We will render everything and assume global CSS classes or style injection will hide them, 
    // OR we can implement it here if we receive zoomLevel. 
    // Let's assume standard rendering for now and usage of simple structure.

    return (
        <div
            className="file-node-container"
            style={{
                ...style,
                backgroundColor: 'var(--vscode-editor-background)',
                borderRadius: '60px', // Cylindrical / Pill shape
                border: `${borderWidth}px solid ${borderColor}`,
                opacity: containerOpacity,
                boxShadow: isActive ? `0 0 0 2px ${borderColor}40` : 'none',
                width: '100%', // Fill the ELK-assigned width
                height: '100%', // Fill the ELK-assigned height
                cursor: isClickable ? 'pointer' : 'default',
                pointerEvents: 'all', // ALWAYS allow interaction
                zIndex: 1000, // Force on top of parent domains
                transition: 'all 0.2s ease',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                fontSize: '22px', // Increased from 20px
                padding: '0 20px', // Extra padding for curved edges
                color: 'var(--vscode-editor-foreground)',
            }}
            title={`File: ${filePath}\nSymbols: ${symbolCount}\nCoupling: ${(avgCoupling * 100).toFixed(0)}%`}
        >
            <Handle type="target" position={Position.Top} className="w-1 h-1 !bg-gray-400" />

            {/* Title Row */}
            <div
                className="flex items-center justify-center gap-2 px-2 py-1.5 w-full"
                style={{
                    backgroundColor: isActive ? borderColor + '10' : 'transparent',
                }}
            >
                {/* Icon */}
                <span style={{ fontSize: '26px', lineHeight: 1 }}>📄</span>

                {/* Name */}
                <span className="font-medium truncate node-label text-center" style={{ fontSize: '24px', flex: 1 }}>
                    {fileName}
                </span>

                {/* Collapse Toggle (if container) - Files usually don't have children in this graph context unless they contain classes etc? 
                    Actually in Architect graph, files contain symbols. So they are collapsible. */}
                <div
                    onClick={(e) => {
                        e.stopPropagation();
                        if (typeof onToggleCollapse === 'function') {
                            onToggleCollapse(nodeId);
                        }
                    }}
                    className="cursor-pointer opacity-60 hover:opacity-100 px-1"
                >
                    {collapsed ? '▶' : '▼'}
                </div>
            </div>

            {/* Metadata Row - Progressive Disclosure */}
            {/* Using a specific class 'node-meta' helps targeting with CSS based on zoom */}
            <div className="node-meta px-2 pb-1.5 flex items-center justify-between text-[9px] opacity-70">
                <span className="symbol-count">{symbolCount} symbols</span>
            </div>

            <Handle type="source" position={Position.Bottom} className="w-1 h-1 !bg-gray-400" />
        </div>
    );
});

FileNode.displayName = 'FileNode';

export default FileNode;
