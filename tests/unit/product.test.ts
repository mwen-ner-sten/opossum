import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT } from '@shared/product';
import { serializeError, OpossumError } from '@shared/errors';
import { z } from 'zod';

describe('product metadata', () => {
  it('keeps the central version in step with package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(PRODUCT.version).toBe(pkg.version);
  });
});

describe('error serialization', () => {
  it('maps Zod failures to VALIDATION with field paths', () => {
    const result = z.object({ port: z.number() }).safeParse({ port: 'x' });
    const serialized = serializeError(result.error);
    expect(serialized.code).toBe('VALIDATION');
    expect(serialized.details).toEqual([{ path: 'port', message: expect.any(String) as string }]);
  });

  it('preserves OpossumError codes and hides unknown values', () => {
    expect(serializeError(new OpossumError('CONFLICT', 'dup'))).toEqual({
      code: 'CONFLICT',
      message: 'dup',
    });
    expect(serializeError(42)).toEqual({
      code: 'INTERNAL',
      message: 'An unexpected error occurred.',
    });
  });
});
