import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';

export interface DomainNodeData extends Record<string, unknown> {
    domain: string;
    health: {
        domain: string;
        symbolCount: number;
        avgComplexity: number;
        coupling: number;
        healthScore: number;
        status: 'healthy' | 'warning' | 'critical';
        avgFragility?: number;
        totalBlastRadius?: number;
    };
    collapsed: boolean;
    nodeId: string;
    onToggleCollapse?: (id: string) => void;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
    zoomLevel?: number; // Injected from GraphCanvas
}

const DomainNode = memo(({ data, style }: NodeProps<Node<DomainNodeData>> & { style?: React.CSSProperties }) => {
    const {
        domain,
        health,
        collapsed,
        nodeId,
        onToggleCollapse,
        isDimmed = false,
        isActive = false,
        isClickable = true
    } = data;
    const safeHealth = health ?? { status: 'healthy' as const, symbolCount: 0, healthScore: 0, avgComplexity: 0, coupling: 0, domain };
    const { status, symbolCount } = safeHealth;

    // Get domain display name and icon
    const domainDisplayNames: Record<string, string> = {
        auth: '🔐 Authentication',
        payment: '💳 Payment',
        api: '🔌 API',
        database: '🗄️ Database',
        notification: '🔔 Notification',
        core: '⚙️ Core',
        ui: '🎨 UI',
        util: '🔧 Utilities',
        test: '🧪 Tests',
        config: '⚙️ Configuration',
        unknown: '❓ Unknown',
    };

    const displayName = domainDisplayNames[domain] || `📦 ${domain}`;

    // Health color mapping
    // Healthy: #22C55E (Green), Medium: #F59E0B (Amber), Risky: #EF4444 (Red)
    const healthColors = {
        healthy: '#22C55E',
        warning: '#F59E0B',
        critical: '#EF4444',
    };

    const borderColor = healthColors[status] || healthColors.healthy;

    // Calculate styling
    const containerOpacity = isDimmed ? 0.3 : 1;
    const borderWidth = isActive ? 5 : 3; // Thicker border as requested

    return (
        <div
            className="domain-node-container"
            style={{
                ...style,
                backgroundColor: 'var(--vscode-editor-background)',
                borderRadius: '40px', // Cylindrical / Rounded Container
                border: `${borderWidth}px solid ${borderColor}`,
                opacity: containerOpacity,
                boxShadow: isActive ? `0 0 0 2px ${borderColor}40` : 'none',
                width: '100%',
                height: '100%',
                cursor: isClickable ? 'pointer' : 'default',
                pointerEvents: isDimmed ? 'none' : 'auto',
                transition: 'all 0.2s ease',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                fontSize: '24px', // Increased from 18px
                padding: '0 20px', // Extra padding
                color: 'var(--vscode-editor-foreground)',
            }}
            title={`Domain: ${domain}\nStatus: ${status}\nHealth: ${safeHealth.healthScore}%`}
        >
            <Handle type="target" position={Position.Top} className="w-1.5 h-1.5 !bg-gray-400" />

            {/* Title Row */}
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    backgroundColor: isActive ? borderColor + '10' : 'transparent',
                }}
            >
                {/* Name & Icon */}
                <span className="font-bold truncate flex-1 node-label" style={{ fontSize: '24px' }}>
                    {displayName}
                </span>

                {/* Collapse Toggle */}
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
            {!collapsed && (
                <div className="node-meta px-3 pb-2 flex items-center justify-between text-[10px] opacity-70">
                    <span className="symbol-count">{symbolCount} symbols</span>
                </div>
            )}

            <Handle type="source" position={Position.Bottom} className="w-1.5 h-1.5 !bg-gray-400" />
        </div>
    );
});

DomainNode.displayName = 'DomainNode';

export default DomainNode;
