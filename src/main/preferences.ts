import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

interface WindowPreferences {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const defaults: WindowPreferences = { width: 1280, height: 800, maximized: false };

export class PreferencesStore {
  private readonly path: string;
  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, 'preferences.json');
  }

  loadWindow(): WindowPreferences {
    if (!existsSync(this.path)) return defaults;
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<WindowPreferences>;
      return {
        width: Math.max(1024, Number(value.width) || defaults.width),
        height: Math.max(700, Number(value.height) || defaults.height),
        maximized: Boolean(value.maximized),
        ...(typeof value.x === 'number' ? { x: value.x } : {}),
        ...(typeof value.y === 'number' ? { y: value.y } : {}),
      };
    } catch {
      return defaults;
    }
  }

  saveWindow(window: BrowserWindow): void {
    const bounds = window.getNormalBounds();
    const value: WindowPreferences = { ...bounds, maximized: window.isMaximized() };
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
    renameSync(temporary, this.path);
  }
}
