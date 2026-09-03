export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';
const darkQuery = (): MediaQueryList => matchMedia('(prefers-color-scheme: dark)');

export function readStoredTheme(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function applyTheme(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
  const dark = preference === 'dark' || (preference === 'system' && darkQuery().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Re-applies the theme when the operating system preference changes while "system" is selected. */
export function watchSystemTheme(getPreference: () => ThemePreference): () => void {
  const query = darkQuery();
  const listener = (): void => {
    if (getPreference() === 'system') applyTheme('system');
  };
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
