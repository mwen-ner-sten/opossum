import type { OpossumApi } from '@shared/contracts';

declare global {
  interface Window {
    opossum: OpossumApi;
  }
}

export {};
