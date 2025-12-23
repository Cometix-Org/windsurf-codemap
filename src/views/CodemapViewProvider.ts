/**
 * Codemap Webview View Provider - Sidebar integrated webview
 */

import * as vscode from 'vscode';
import type { Codemap } from '../types';
import {
  generateFastCodemap,
  generateSmartCodemap,
  isConfigured,
  generateSuggestions,
  retryTraceFromStage12Context,
  retryMermaidFromStage12Context,
  generateMermaidFromCodemapSnapshot,
} from '../agent';
import {
  saveCodemap,
  listCodemaps,
  deleteCodemap,
  loadCodemap,
  getStoragePath,
  getCodemapFilePath,
  updateCodemap,
} from '../storage/codemapStorage';
import * as logger from '../logger';

interface ActiveAgent {
  id: string;
  label: string;
  startTime: number;
}

interface ProgressState {
  totalStages: number;
  completedStages: number;
  activeAgents: ActiveAgent[];
  currentPhase: string;
}

export class CodemapViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codemap.mainView';

  private _view?: vscode.WebviewView;
  private _codemap: Codemap | null = null;
  private _currentCodemapFilename: string | null = null;
  private _messages: Array<{ role: string; content: string }> = [];
  private _isProcessing = false;
  private _mode: 'fast' | 'smart' = 'smart';
  private _suggestions: Array<{ id: string; text: string; sub?: string; startingPoints?: string[] }> = [];
  private _recentFiles: string[] = [];
  private _refreshTimer: NodeJS.Timeout | null = null;
  private _progress: ProgressState | null = null;
  private _unreadCodemaps: Set<string> = new Set();

  private getSuggestionRefreshConfig(): 'off' | 'manual' | 'auto' {
    const config = vscode.workspace.getConfiguration('codemap').get<string>('suggestionRefresh', 'auto');
    return config as 'off' | 'manual' | 'auto';
  }

  constructor(private readonly _extensionUri: vscode.Uri) {
    // Track recent file access
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file') {
        this.addRecentFile(editor.document.uri.fsPath);
      }
    });
    
    // Track file saves
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        this.addRecentFile(doc.uri.fsPath);
      }
    });
  }

  private addRecentFile(filePath: string) {
    // Remove if exists, add to front
    this._recentFiles = this._recentFiles.filter(f => f !== filePath);
    this._recentFiles.unshift(filePath);
    
    // Keep only last 20 files
    if (this._recentFiles.length > 20) {
      this._recentFiles = this._recentFiles.slice(0, 20);
    }
    
    // Debounced refresh
    this.scheduleRefresh();
  }
  
  private scheduleRefresh() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }

    if (this.getSuggestionRefreshConfig() !== 'auto'){
      return;
    }

    // Refresh suggestions every 30 seconds of activity
    this._refreshTimer = setTimeout(() => {
      this.refreshSuggestions();
    }, 30000);
  }
  
  private async refreshSuggestions(): Promise<void> {
    if (this.getSuggestionRefreshConfig() === 'off') {
      logger.info('Suggestion refresh is off');
      return;
    }

    if (!isConfigured() || this._recentFiles.length < 3) {
      return;
    }
    
    try {
      const suggestions = await generateSuggestions(this._recentFiles.slice(0, 10));
      this._suggestions = suggestions.map(s => ({
        id: s.id,
        text: s.text,
        sub: s.sub || 'Based on recent activity',
        startingPoints: s.startingPoints,
      }));
      this._updateWebview();
    } catch (error) {
      console.error('Failed to refresh suggestions:', error);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist')],
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready':
          this._updateWebview();
          // Initial load of suggestions
          this.refreshSuggestions();
          break;
        case 'submit':
          await this._handleSubmit(message.query, message.mode);
          break;
        case 'ensureMermaidDiagram':
          await this._generateMermaidDiagram(false);
          break;
        case 'retryTrace':
          await this._retryTrace(message.traceId);
          break;
        case 'retryAllTraces':
          await this._retryAllTraces();
          break;
        case 'regenerateMermaidDiagram':
          await this._generateMermaidDiagram(true);
          break;
        case 'openFile':
          this._openFile(message.path, message.line);
          break;
        case 'refreshHistory':
          this._updateWebview();
          break;
        case 'deleteHistory':
          this._deleteHistory(message.filename);
          break;
        case 'loadHistory':
          this._loadHistory(message.filename);
          break;
        case 'refreshSuggestions':
          await this.refreshSuggestions();
          break;
        case 'navigate':
          this._updateWebview();
          break;
        case 'openJson':
          this._openCodemapJson();
          break;
      }
    });
  }

  /**
   * Generate or regenerate Mermaid diagram
   * @param force - If true, regenerate even if diagram already exists
   */
  private async _generateMermaidDiagram(force: boolean = false): Promise<void> {
    if (this._isProcessing) {
      return;
    }
    if (!this._view || !this._codemap) {
      return;
    }

    // Non-force mode: skip if diagram already exists
    if (!force && this._codemap.mermaidDiagram && this._codemap.mermaidDiagram.trim().length > 0) {
      return;
    }

    if (!isConfigured()) {
      vscode.window.showErrorMessage('Please set your OpenAI API key first');
      return;
    }

    this._isProcessing = true;
    const actionLabel = force ? 'Regenerating' : 'Generating';
    this._progress = {
      totalStages: 1,
      completedStages: 0,
      activeAgents: [
        { id: 'mermaid', label: `${actionLabel} Mermaid diagram...`, startTime: Date.now() },
      ],
      currentPhase: `${actionLabel} Mermaid diagram...`,
    };
    this._updateWebview();

    try {
      const result = this._codemap.stage12Context
        ? await retryMermaidFromStage12Context(this._codemap.stage12Context)
        : await generateMermaidFromCodemapSnapshot(this._codemap);

      if (result.error) {
        throw new Error(result.error);
      }
      if (!result.diagram || result.diagram.trim().length === 0) {
        throw new Error('No mermaid diagram returned');
      }

      this._codemap = {
        ...this._codemap,
        mermaidDiagram: result.diagram.trim(),
        updatedAt: new Date().toISOString(),
      };

      if (this._currentCodemapFilename) {
        updateCodemap(this._currentCodemapFilename, this._codemap);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const action = force ? 'regenerate' : 'generate';
      vscode.window.showErrorMessage(`Failed to ${action} Mermaid diagram: ${msg}`);
    } finally {
      this._isProcessing = false;
      this._progress = null;
      this._updateWebview();
    }
  }

  private async _retryTrace(traceId: string): Promise<void> {
    if (this._isProcessing) {
      return;
    }
    if (!this._view || !this._codemap) {
      return;
    }

    const ctx = this._codemap.stage12Context;
    if (!ctx) {
      vscode.window.showErrorMessage(
        'This codemap cannot be retried (missing stage12Context). Regenerate the codemap first.'
      );
      return;
    }
    if (!isConfigured()) {
      vscode.window.showErrorMessage('Please set your OpenAI API key first');
      return;
    }

    const trace = this._codemap.traces.find((t) => t.id === traceId);
    if (!trace) {
      vscode.window.showErrorMessage(`Trace not found: ${traceId}`);
      return;
    }

    this._isProcessing = true;
    const completed = new Set<number>();
    this._progress = {
      totalStages: 3,
      completedStages: 0,
      activeAgents: [{ id: `trace-${traceId}`, label: `Retrying Trace ${traceId}...`, startTime: Date.now() }],
      currentPhase: 'Retrying trace...',
    };
    this._updateWebview();

    try {
      const stageLabels: Record<number, string> = {
        3: `Generating relation tree for Trace ${traceId}...`,
        4: `Adding location decorations for Trace ${traceId}...`,
        5: `Generating trace guide for Trace ${traceId}...`,
      };

      const result = await retryTraceFromStage12Context(traceId, ctx, {
        onTraceProcessing: (_tid, stage, status) => {
          if (!this._progress) {
            return;
          }
          if (status === 'start') {
            const idx = this._progress.activeAgents.findIndex((a) => a.id === `trace-${traceId}`);
            const label = stageLabels[stage] || `Retrying Trace ${traceId}...`;
            if (idx >= 0) {
              this._progress.activeAgents[idx].label = label;
            }
            this._progress.currentPhase = 'Retrying trace...';
          } else {
            completed.add(stage);
            this._progress.completedStages = completed.size;
            if (completed.size >= 3) {
              this._progress.activeAgents = this._progress.activeAgents.filter((a) => a.id !== `trace-${traceId}`);
            }
          }
          this._updateWebview();
        },
      });

      if (result.error) {
        throw new Error(result.error);
      }
      if (result.diagram) {
        trace.traceTextDiagram = result.diagram;
      }
      if (result.guide) {
        trace.traceGuide = result.guide;
      }

      this._codemap = {
        ...this._codemap,
        query: this._codemap.query || ctx.query,
        mode: this._codemap.mode || ctx.mode,
        updatedAt: new Date().toISOString(),
      };

      if (this._currentCodemapFilename) {
        updateCodemap(this._currentCodemapFilename, this._codemap);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to retry trace ${traceId}: ${msg}`);
    } finally {
      this._isProcessing = false;
      this._progress = null;
      this._updateWebview();
    }
  }

  private async _retryAllTraces(): Promise<void> {
    if (this._isProcessing) {
      return;
    }
    if (!this._view || !this._codemap) {
      return;
    }

    const ctx = this._codemap.stage12Context;
    if (!ctx) {
      vscode.window.showErrorMessage(
        'This codemap cannot be retried (missing stage12Context). Regenerate the codemap first.'
      );
      return;
    }
    if (!isConfigured()) {
      vscode.window.showErrorMessage('Please set your OpenAI API key first');
      return;
    }
    if (this._codemap.traces.length === 0) {
      return;
    }

    const traceStages: Map<string, Set<number>> = new Map();
    const stageLabelsFor = (traceId: string): Record<number, string> => ({
      3: `Generating relation tree for Trace ${traceId}...`,
      4: `Adding location decorations for Trace ${traceId}...`,
      5: `Generating trace guide for Trace ${traceId}...`,
    });

    this._isProcessing = true;
    this._progress = {
      totalStages: this._codemap.traces.length * 3,
      completedStages: 0,
      activeAgents: [{ id: 'retry-all', label: 'Retrying all traces...', startTime: Date.now() }],
      currentPhase: 'Retrying all traces...',
    };
    this._updateWebview();

    try {
      const results = await Promise.all(
        this._codemap.traces.map(async (t) => {
          const traceId = t.id;
          const labels = stageLabelsFor(traceId);
          const res = await retryTraceFromStage12Context(traceId, ctx, {
            onTraceProcessing: (tid, stage, status) => {
              if (!this._progress) {
                return;
              }
              if (!traceStages.has(tid)) {
                traceStages.set(tid, new Set());
              }

              if (status === 'start') {
                const label = labels[stage] || `Retrying Trace ${tid}...`;
                const existingIdx = this._progress.activeAgents.findIndex((a) => a.id === `trace-${tid}`);
                if (existingIdx >= 0) {
                  this._progress.activeAgents[existingIdx].label = label;
                } else {
                  this._progress.activeAgents.push({ id: `trace-${tid}`, label, startTime: Date.now() });
                }
                this._progress.currentPhase = 'Retrying all traces...';
              } else {
                traceStages.get(tid)!.add(stage);
                let completedStages = 0;
                for (const s of traceStages.values()) {
                  completedStages += s.size;
                }
                this._progress.completedStages = completedStages;
                if (traceStages.get(tid)!.size >= 3) {
                  this._progress.activeAgents = this._progress.activeAgents.filter((a) => a.id !== `trace-${tid}`);
                }
              }
              this._updateWebview();
            },
          });
          return { traceId, res };
        })
      );

      for (const { traceId, res } of results) {
        const trace = this._codemap.traces.find((x) => x.id === traceId);
        if (!trace) {
          continue;
        }
        if (res.error) {
          logger.warn(`Retry trace ${traceId} failed: ${res.error}`);
          continue;
        }
        if (res.diagram) {
          trace.traceTextDiagram = res.diagram;
        }
        if (res.guide) {
          trace.traceGuide = res.guide;
        }
      }

      this._codemap = {
        ...this._codemap,
        query: this._codemap.query || ctx.query,
        mode: this._codemap.mode || ctx.mode,
        updatedAt: new Date().toISOString(),
      };

      if (this._currentCodemapFilename) {
        updateCodemap(this._currentCodemapFilename, this._codemap);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to retry all traces: ${msg}`);
    } finally {
      this._isProcessing = false;
      this._progress = null;
      this._updateWebview();
    }
  }


  public showHome() {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.postMessage({
        type: 'navigate',
        page: 'home',
      });
    }
  }

  public showWithQuery(query: string, mode: 'fast' | 'smart' = 'smart') {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.postMessage({
        type: 'setQuery',
        query,
      });
      this._mode = mode;
    }
  }

  public loadCodemap(codemap: Codemap) {
    this._codemap = codemap;
    this._messages = [
      { role: 'assistant', content: `Loaded saved codemap: ${codemap.title}` }
    ];
    this._updateWebview();
    // Navigate to detail page
    this._view?.webview.postMessage({
      type: 'navigate',
      page: 'detail',
    });
  }

  private async _handleSubmit(query: string, mode: 'fast' | 'smart') {
    logger.separator('WEBVIEW SUBMIT');
    logger.info(`Submit received - query: "${query}", mode: ${mode}`);

    if (this._isProcessing) {
      logger.warn('Already processing a request, ignoring submit');
      vscode.window.showWarningMessage('Already processing a request');
      return;
    }

    if (!isConfigured()) {
      logger.error('OpenAI API key not configured');
      vscode.window.showErrorMessage('Please set your OpenAI API key first');
      return;
    }

    logger.info('Starting codemap generation...');
    this._isProcessing = true;
    this._mode = mode;
    this._messages = [];
    this._codemap = null;

    // Initialize progress state
    // Stages: Research(1) + Structure(1) + Traces(N*3) + Mermaid(1)
    // We'll update totalStages once we know the number of traces
    this._progress = {
      totalStages: 3, // Initial: Research + Structure + Mermaid
      completedStages: 0,
      activeAgents: [{
        id: 'init',
        label: 'Starting codemap generation...',
        startTime: Date.now(),
      }],
      currentPhase: 'Starting codemap generation...',
    };

    this._updateWebview();

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    logger.info(`Workspace root: ${workspaceRoot}`);

    // Track trace stages for progress calculation
    const traceStages: Map<string, Set<number>> = new Map();
    let numTraces = 0;
    let stage12Context: Codemap['stage12Context'] | undefined = undefined;

    const callbacks = {
      onMessage: (role: string, content: string) => {
        logger.debug(`[Callback] onMessage - role: ${role}, content length: ${content.length}`);
        this._messages.push({ role, content });
        this._updateWebview();
      },
      onToolCall: (tool: string, args: string, result: string) => {
        logger.debug(`[Callback] onToolCall - tool: ${tool}`);
        this._messages.push({
          role: 'tool',
          content: `[${tool}]\n${args}\n---\n${result.slice(0, 300)}${result.length > 300 ? '...' : ''}`,
        });
        this._updateWebview();
      },
      onCodemapUpdate: (codemap: Codemap) => {
        logger.info(`[Callback] onCodemapUpdate - title: ${codemap.title}, traces: ${codemap.traces.length}`);
        this._codemap = stage12Context
          ? { ...codemap, stage12Context, query, mode }
          : { ...codemap, query, mode };

        // Update total stages when we know the number of traces
        if (codemap.traces.length > 0 && numTraces !== codemap.traces.length) {
          numTraces = codemap.traces.length;
          // Research(1) + Structure(1) + Traces(N*3) + Mermaid(1)
          if (this._progress) {
            this._progress.totalStages = 2 + (numTraces * 3) + 1;
          }
        }

        this._updateWebview();
      },
      onStage12ContextReady: (context: Codemap['stage12Context']) => {
        stage12Context = context;
        if (this._codemap) {
          this._codemap = { ...this._codemap, stage12Context, query, mode };
          this._updateWebview();
        }
      },
      onPhaseChange: (phase: string, stageNumber: number) => {
        logger.info(`[Callback] onPhaseChange - phase: ${phase}, stage: ${stageNumber}`);

        if (this._progress) {
          // Map phase to user-friendly progress text
          const phaseLabels: Record<number, string> = {
            1: 'Researching codebase...',
            2: 'Generating codemap structure...',
            3: 'Processing traces...',
            6: 'Generating Mermaid diagram...',
          };

          this._progress.currentPhase = phaseLabels[stageNumber] || phase;

          // Update completed stages based on phase
          if (stageNumber === 2) {
            // Research complete
            this._progress.completedStages = 1;
          } else if (stageNumber === 3) {
            // Structure complete
            this._progress.completedStages = 2;
          } else if (stageNumber === 6) {
            // Starting mermaid - all trace stages should be complete
            this._progress.completedStages = 2 + (numTraces * 3);
          }

          // Clear active agents when phase changes (except for trace processing)
          if (stageNumber !== 3) {
            this._progress.activeAgents = [{
              id: `phase-${stageNumber}`,
              label: phaseLabels[stageNumber] || phase,
              startTime: Date.now(),
            }];
          }
        }

        this._updateWebview();
      },
      onTraceProcessing: (traceId: string, stage: number, status: 'start' | 'complete') => {
        logger.debug(`[Callback] onTraceProcessing - trace: ${traceId}, stage: ${stage}, status: ${status}`);

        if (this._progress) {
          // Track completed stages per trace
          if (!traceStages.has(traceId)) {
            traceStages.set(traceId, new Set());
          }

          // Get trace title from codemap if available
          const traceIndex = parseInt(traceId) - 1;
          const trace = this._codemap?.traces[traceIndex];
          const traceTitle = trace?.title ? ` "${trace.title}"` : '';

          // Map stage to user-friendly label
          const stageLabels: Record<number, string> = {
            3: `Generating relation tree for Trace ${traceId}${traceTitle}...`,
            4: `Adding location decorations for Trace ${traceId}${traceTitle}...`,
            5: `Generating trace guide for Trace ${traceId}${traceTitle}...`,
          };

          if (status === 'start') {
            const label = stageLabels[stage] || `Processing Trace ${traceId}...`;

            // Add to active agents
            const existingIdx = this._progress.activeAgents.findIndex(a => a.id === `trace-${traceId}`);
            if (existingIdx >= 0) {
              this._progress.activeAgents[existingIdx].label = label;
            } else {
              this._progress.activeAgents.push({
                id: `trace-${traceId}`,
                label,
                startTime: Date.now(),
              });
            }
            this._progress.currentPhase = 'Processing traces...';
          } else if (status === 'complete') {
            // Mark stage as complete
            traceStages.get(traceId)!.add(stage);

            // Count total completed trace stages
            let completedTraceStages = 0;
            for (const stages of traceStages.values()) {
              completedTraceStages += stages.size;
            }

            // Update progress: Research(1) + Structure(1) + completed trace stages
            this._progress.completedStages = 2 + completedTraceStages;

            // Remove from active agents if all stages complete for this trace
            if (traceStages.get(traceId)!.size >= 3) {
              this._progress.activeAgents = this._progress.activeAgents.filter(
                a => a.id !== `trace-${traceId}`
              );
            }
          }
        }

        this._updateWebview();
      },
    };

    try {
      logger.info(`Calling generate${mode === 'fast' ? 'Fast' : 'Smart'}Codemap...`);
      if (mode === 'fast') {
        await generateFastCodemap(query, workspaceRoot, callbacks);
      } else {
        await generateSmartCodemap(query, workspaceRoot, callbacks);
      }
      logger.info('Codemap generation function returned');

      // Save codemap to storage if generation succeeded
      if (this._codemap) {
        logger.info('Saving codemap to storage...');
        const savedPath = saveCodemap(this._codemap);
        logger.info(`Codemap saved to: ${savedPath}`);

        // Extract filename from path and track it
        const filename = savedPath.split(/[/\\]/).pop() || savedPath;
        this._currentCodemapFilename = filename;

        // Mark as unread
        this._unreadCodemaps.add(filename);

        this._messages.push({
          role: 'assistant',
          content: `Codemap saved to: ${savedPath}`,
        });

        // Update progress to complete
        if (this._progress) {
          this._progress.completedStages = this._progress.totalStages;
          this._progress.currentPhase = 'Codemap generated successfully!';
          this._progress.activeAgents = [{
            id: 'complete',
            label: 'Codemap generated successfully!',
            startTime: Date.now(),
          }];
        }

        this._updateWebview();
      } else {
        logger.warn('No codemap was generated (this._codemap is null)');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`Codemap generation failed: ${errorMsg}`);
      if (errorStack) {
        logger.error(`Stack trace: ${errorStack}`);
      }
      vscode.window.showErrorMessage(`Codemap generation failed: ${errorMsg}`);
    } finally {
      logger.info('Submit handler complete, resetting isProcessing to false');
      this._isProcessing = false;
      this._progress = null;
      this._updateWebview();
      logger.separator('WEBVIEW SUBMIT END');
    }
  }

  private _openFile(filePath: string, line: number) {
    const uri = vscode.Uri.file(filePath);
    vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(line - 1, 0, line - 1, 0),
      preview: false,
    });
  }

  private async _openCodemapJson() {
    if (!this._codemap || !this._currentCodemapFilename) {
      vscode.window.showWarningMessage('No codemap loaded');
      return;
    }

    // Open the actual JSON file from storage
    const filePath = getCodemapFilePath(this._currentCodemapFilename);
    const uri = vscode.Uri.file(filePath);

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        preview: false,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open codemap file: ${filePath}`);
    }
  }

  private _deleteHistory(filename: string) {
    if (deleteCodemap(filename)) {
      this._unreadCodemaps.delete(filename);
      vscode.window.showInformationMessage('Codemap deleted');
      this._updateWebview();
    }
  }

  private _loadHistory(filename: string) {
    const codemap = loadCodemap(filename);
    if (codemap) {
      this._codemap = codemap;
      this._currentCodemapFilename = filename;
      // Mark as read
      this._unreadCodemaps.delete(filename);
      this._messages = [
        { role: 'assistant', content: `Loaded saved codemap: ${codemap.title}` }
      ];
      this._updateWebview();
      // Navigate to detail page
      this._view?.webview.postMessage({
        type: 'navigate',
        page: 'detail',
      });
    } else {
      vscode.window.showErrorMessage(`Failed to load codemap: ${filename}`);
    }
  }

  private _getHistory() {
    const codemaps = listCodemaps();
    return codemaps.map(({ filename, codemap }) => ({
      id: filename,
      codemap,
      timestamp: new Date(codemap.savedAt || Date.now()).getTime(),
      isUnread: this._unreadCodemaps.has(filename),
    }));
  }

  private _updateWebview() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'update',
        codemap: this._codemap,
        messages: this._messages,
        isProcessing: this._isProcessing,
        mode: this._mode,
        suggestions: this._suggestions,
        history: this._getHistory(),
        progress: this._progress,
      });
    }
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.js')
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.css')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com; connect-src https://cdn.jsdelivr.net;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Codemap</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
