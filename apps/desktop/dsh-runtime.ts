/**
 * dsh 已卸下。
 *
 * 本模块不再创建 Cordis Context，不装载宿主服务，不装载九个插件，
 * 也不装载市场插件。调用方得到明确的不可用，旧能力不迁移。
 */
import * as path from 'node:path';
import { getDataDir } from './data-dir';

export const DSH_UNLOAD_REASON = 'dsh 已卸下，未迁移';

export const PLUGIN_NAMES = [
  'intent', 'trace', 'authz', 'brain', 'multi', 'memory', 'prompt', 'compensation', 'evolution',
] as const;



export interface PluginState {
  name: string;
  active: boolean;
  available: boolean;
  error?: string;
}

export interface OrchDeskRuntime {
  ctx: null;
  plugins: PluginState[];
  activeCount: number;
  host: null;
}

export function unavailablePlugin(name: string): PluginState {
  return { name, active: false, available: false, error: DSH_UNLOAD_REASON };
}

export async function startRuntime(): Promise<OrchDeskRuntime> {
  return {
    ctx: null,
    plugins: PLUGIN_NAMES.map((name) => unavailablePlugin(name)),
    activeCount: 0,
    host: null,
  };
}

export function getRuntime(): OrchDeskRuntime | null {
  return null;
}

export function getService<T>(_name: string): T | null {
  return null;
}

export function getPluginStates(): PluginState[] {
  return PLUGIN_NAMES.map((name) => unavailablePlugin(name));
}

export async function setPluginEnabled(name: string, _enabled: boolean): Promise<PluginState> {
  return unavailablePlugin(String(name || 'unknown'));
}

export function marketDir(): string {
  return path.join(getDataDir(), 'plugins');
}

export interface MarketPluginInfo {
  dir: string;
  manifest: null;
  manifestOk: false;
  hasEntry: false;
  error: string;
  enabled: false;
  active: false;
}


export async function setMarketPluginEnabled(dir: string): Promise<MarketPluginInfo> {
  return {
    dir: String(dir || ''),
    manifest: null,
    manifestOk: false,
    hasEntry: false,
    error: DSH_UNLOAD_REASON,
    enabled: false,
    active: false,
  };
}

export async function startupMarketPlugins(
  enabledMap: Record<string, boolean> | null | undefined,
): Promise<{ dir: string; ok: boolean; error?: string }[]> {
  return Object.entries(enabledMap || {})
    .filter(([, on]) => on)
    .map(([dir]) => ({ dir, ok: false, error: DSH_UNLOAD_REASON }));
}


export async function stopRuntime(): Promise<void> {}

export function persistGrantsNow(): boolean {
  return false;
}



export function hydrateGrants(): number {
  return 0;
}


