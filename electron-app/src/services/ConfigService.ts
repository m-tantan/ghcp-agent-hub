/**
 * ConfigService
 * 
 * Handles persistence of application configuration including
 * selected repositories to a local JSON file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/**
 * Persisted repository configuration (minimal data needed to restore)
 */
export interface PersistedRepository {
  path: string;
  isExpanded: boolean;
}

/**
 * Application configuration structure
 */
export interface AppConfig {
  version: number;
  repositories: PersistedRepository[];
  activeFilter?: string; // 'all' | 'active' | 'needs-input'
  sessionNames?: Record<string, string>; // sessionId -> customName
  terminalColors?: Record<string, string>; // sessionId -> color hex
  repoColors?: Record<string, string>; // repo path -> base color hex
  savedTerminals?: SavedTerminal[]; // terminals to restore on app reopen
  sessionViewMode?: 'tile' | 'list'; // session display preference
  terminalOnlyMode?: boolean; // hide sessions, terminals fill entire space
}

export interface SavedTerminal {
  sessionId: string;
  cwd: string;
  color?: string;
  mission?: string;
}

const CONFIG_VERSION = 1;
const CONFIG_FILENAME = 'agent-hub-config.json';

/**
 * Configuration Service for persisting app state
 */
export class ConfigService {
  private configPath: string;

  constructor() {
    // Use electron's userData path for cross-platform config location
    const userDataPath = app.getPath('userData');
    this.configPath = path.join(userDataPath, CONFIG_FILENAME);
  }

  /**
   * Get the config file path
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Load configuration from disk
   */
  loadConfig(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        const config = JSON.parse(content) as AppConfig;
        
        // Validate config structure
        if (config && Array.isArray(config.repositories)) {
          return config;
        }
      }
    } catch (error) {
      console.error('Error loading config:', error);
    }

    // Return default empty config
    return {
      version: CONFIG_VERSION,
      repositories: [],
    };
  }

  /**
   * Save configuration to disk
   */
  saveConfig(config: AppConfig): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const content = JSON.stringify(config, null, 2);
      fs.writeFileSync(this.configPath, content, 'utf-8');
    } catch (error) {
      console.error('Error saving config:', error);
    }
  }

  /**
   * Load saved repository paths
   */
  loadRepositories(): PersistedRepository[] {
    const config = this.loadConfig();
    return config.repositories;
  }

  /**
   * Save repository paths
   */
  saveRepositories(repositories: PersistedRepository[]): void {
    const config = this.loadConfig();
    config.repositories = repositories;
    config.version = CONFIG_VERSION;
    this.saveConfig(config);
  }

  /**
   * Load saved filter
   */
  loadFilter(): string {
    const config = this.loadConfig();
    return config.activeFilter || 'all';
  }

  /**
   * Save active filter
   */
  saveFilter(filter: string): void {
    const config = this.loadConfig();
    config.activeFilter = filter;
    this.saveConfig(config);
  }

  /**
   * Get custom name for a session
   */
  getSessionName(sessionId: string): string | null {
    const config = this.loadConfig();
    return config.sessionNames?.[sessionId] ?? null;
  }

  /**
   * Set custom name for a session
   */
  setSessionName(sessionId: string, name: string): void {
    const config = this.loadConfig();
    if (!config.sessionNames) {
      config.sessionNames = {};
    }
    if (name.trim()) {
      config.sessionNames[sessionId] = name.trim();
    } else {
      delete config.sessionNames[sessionId];
    }
    this.saveConfig(config);
  }

  /**
   * Get all session names
   */
  getAllSessionNames(): Record<string, string> {
    const config = this.loadConfig();
    return config.sessionNames ?? {};
  }

  // --- Repo Colors ---

  getRepoColor(repoPath: string): string | null {
    const config = this.loadConfig();
    return config.repoColors?.[repoPath] ?? null;
  }

  setRepoColor(repoPath: string, color: string): void {
    const config = this.loadConfig();
    if (!config.repoColors) config.repoColors = {};
    config.repoColors[repoPath] = color;
    this.saveConfig(config);
  }

  getAllRepoColors(): Record<string, string> {
    const config = this.loadConfig();
    return config.repoColors ?? {};
  }

  // --- Terminal Colors ---

  getTerminalColor(sessionId: string): string | null {
    const config = this.loadConfig();
    return config.terminalColors?.[sessionId] ?? null;
  }

  setTerminalColor(sessionId: string, color: string): void {
    const config = this.loadConfig();
    if (!config.terminalColors) config.terminalColors = {};
    config.terminalColors[sessionId] = color;
    this.saveConfig(config);
  }

  getAllTerminalColors(): Record<string, string> {
    const config = this.loadConfig();
    return config.terminalColors ?? {};
  }

  // --- Saved Terminals ---

  getSavedTerminals(): SavedTerminal[] {
    const config = this.loadConfig();
    return config.savedTerminals ?? [];
  }

  setSavedTerminals(terminals: SavedTerminal[]): void {
    const config = this.loadConfig();
    config.savedTerminals = terminals;
    this.saveConfig(config);
  }

  // --- Session View Mode ---

  getSessionViewMode(): 'tile' | 'list' {
    const config = this.loadConfig();
    return config.sessionViewMode ?? 'tile';
  }

  setSessionViewMode(mode: 'tile' | 'list'): void {
    const config = this.loadConfig();
    config.sessionViewMode = mode;
    this.saveConfig(config);
  }

  // --- Terminal Only Mode ---

  getTerminalOnlyMode(): boolean {
    const config = this.loadConfig();
    return config.terminalOnlyMode ?? false;
  }

  setTerminalOnlyMode(enabled: boolean): void {
    const config = this.loadConfig();
    config.terminalOnlyMode = enabled;
    this.saveConfig(config);
  }
}
