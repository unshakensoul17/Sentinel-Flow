import * as vscode from 'vscode';

export class SidebarProvider implements vscode.WebviewViewProvider {
    _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'open-graph': {
                    vscode.commands.executeCommand('codeIndexer.visualizeGraph');
                    break;
                }
                case 'update-index': {
                    vscode.commands.executeCommand('codeIndexer.indexWorkspace');
                    break;
                }
                case 'reset-index': {
                    vscode.commands.executeCommand('codeIndexer.clearIndex');
                    break;
                }
                case 'update-api-keys': {
                    vscode.commands.executeCommand('codeIndexer.configureAI');
                    break;
                }
                case 'toggle-auto-index': {
                    this._context.workspaceState.update('autoIndexEnabled', data.value);
                    if (data.value) {
                        vscode.window.showInformationMessage('Sentinel Flow: Auto-Indexing Enabled');
                    } else {
                        vscode.window.showInformationMessage('Sentinel Flow: Auto-Indexing Disabled');
                    }
                    break;
                }
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const nonce = getNonce();
        const autoIndexEnabled = this._context.workspaceState.get<boolean>('autoIndexEnabled', true);

        // Use VS Code's native CSS variables for a consistent look
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; connect-src ${webview.cspSource} data:;">
				<title>Sentinel Flow</title>
                <style>
                    :root {
                        --container-padding: 16px;
                    }
                    body {
                        padding: var(--container-padding);
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-sideBar-background);
                        display: flex;
                        flex-direction: column;
                        gap: 16px;
                    }
                    
                    .header {
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                        margin-bottom: 8px;
                    }

                    h2 {
                        font-size: 11px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        color: var(--vscode-descriptionForeground);
                        margin: 0;
                        font-weight: 600;
                    }

                    .card {
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: 6px;
                        padding: 12px;
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                    }

                    .hero-button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 10px 14px;
                        text-align: center;
                        text-decoration: none;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        border-radius: 4px;
                        transition: background-color 0.1s;
                        width: 100%;
                        box-sizing: border-box;
                    }
                    
                    .hero-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }

                    .secondary-button {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        border: none;
                        padding: 8px 12px;
                        text-align: left;
                        text-decoration: none;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        font-size: 12px;
                        cursor: pointer;
                        border-radius: 4px;
                        transition: background-color 0.1s;
                        width: 100%;
                        box-sizing: border-box;
                    }

                    .secondary-button:hover {
                        background-color: var(--vscode-button-secondaryHoverBackground);
                    }

                    .icon {
                        width: 14px;
                        height: 14px;
                        fill: currentColor;
                        opacity: 0.8;
                    }

                    .divider {
                        height: 1px;
                        background-color: var(--vscode-widget-border);
                        margin: 4px 0;
                        opacity: 0.5;
                    }

                    .status-text {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                        opacity: 0.8;
                    }

                    /* Toggle Switch CSS */
                    .toggle-container {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        padding: 8px 12px;
                        background-color: var(--vscode-button-secondaryBackground);
                        border-radius: 4px;
                    }
                    .toggle-label {
                        font-size: 12px;
                        color: var(--vscode-foreground);
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .switch {
                        position: relative;
                        display: inline-block;
                        width: 32px;
                        height: 18px;
                    }
                    .switch input { 
                        opacity: 0;
                        width: 0;
                        height: 0;
                    }
                    .slider {
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--vscode-input-background);
                        border: 1px solid var(--vscode-widget-border);
                        transition: .2s;
                    }
                    .slider:before {
                        position: absolute;
                        content: "";
                        height: 12px;
                        width: 12px;
                        left: 2px;
                        bottom: 2px;
                        background-color: var(--vscode-foreground);
                        transition: .2s;
                    }
                    input:checked + .slider {
                        background-color: var(--vscode-button-background);
                        border-color: var(--vscode-button-background);
                    }
                    input:checked + .slider:before {
                        transform: translateX(14px);
                        background-color: var(--vscode-button-foreground);
                    }
                    .slider.round {
                        border-radius: 18px;
                    }
                    .slider.round:before {
                        border-radius: 50%;
                    }
                </style>
			</head>
			<body>
                <div class="header">
                    <h2>Sentinel Flow</h2>
                </div>

                <div class="card">
                    <button id="btn-open-graph" class="hero-button">
                        <span style="margin-right: 8px;">📊</span> Open Architecture Graph
                    </button>
                    <div class="status-text">Visualize codebase structure & flows</div>
                </div>

                <div class="header" style="margin-top: 12px;">
                    <h2>Workspace & AI</h2>
                </div>

                <div class="card" style="gap: 8px;">
                    <div class="toggle-container">
                        <div class="toggle-label">
                            <span style="font-size: 14px;">⚡</span> Auto-Index Workspace
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="toggle-auto-index" ${autoIndexEnabled ? 'checked' : ''}>
                            <span class="slider round"></span>
                        </label>
                    </div>

                    <div class="divider"></div>

                    <button id="btn-update-index" class="secondary-button">
                        <span style="font-size: 14px;">🔄</span> Update Workspace Index
                    </button>
                    
                    <button id="btn-update-api-keys" class="secondary-button">
                        <span style="font-size: 14px;">🔑</span> Update API Keys
                    </button>

                    <div class="divider"></div>

                    <button id="btn-reset-index" class="secondary-button" style="color: var(--vscode-errorForeground);">
                        <span style="font-size: 14px;">🗑️</span> Reset Workspace Index
                    </button>
                </div>

                <div class="header" style="margin-top: 12px;">
                    <h2>Help & Guides</h2>
                </div>

                <div class="card" style="gap: 8px;">
                    <a href="https://console.groq.com/keys" class="secondary-button">
                        <span style="font-size: 14px;">⚡</span> Get Groq API Key
                    </a>
                    
                    <a href="https://aistudio.google.com/app/apikey" class="secondary-button">
                        <span style="font-size: 14px;">✨</span> Get Gemini API Key
                    </a>

                    <div class="divider"></div>

                    <!-- Replace this link with your actual youtube tutorial link later -->
                    <a href="https://youtube.com" class="secondary-button">
                        <span style="font-size: 14px;">📺</span> Watch Video Tutorial
                    </a>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    
                    document.getElementById('btn-open-graph').addEventListener('click', () => {
                        vscode.postMessage({ type: 'open-graph' });
                    });
                    
                    document.getElementById('btn-update-index').addEventListener('click', () => {
                        vscode.postMessage({ type: 'update-index' });
                    });
                    
                    document.getElementById('btn-update-api-keys').addEventListener('click', () => {
                        vscode.postMessage({ type: 'update-api-keys' });
                    });
                    
                    document.getElementById('btn-reset-index').addEventListener('click', () => {
                        vscode.postMessage({ type: 'reset-index' });
                    });
                    
                    document.getElementById('toggle-auto-index').addEventListener('change', (e) => {
                        vscode.postMessage({ type: 'toggle-auto-index', value: e.target.checked });
                    });
                </script>
			</body>
			</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
