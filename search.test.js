import { describe, it, expect } from 'vitest';
import { normalizar, isCode, formatCode, buildSearchSql } from './search.js';

describe('normalizar', () => {
  it('removes accents and lowercases', () => {
    expect(normalizar('Computadora')).toBe('computadora');
    expect(normalizar('Águila')).toBe('aguila');
  });
});

describe('isCode', () => {
  it('detects valid codes', () => {
    expect(isCode('14.06.0053.0230')).toBe(true);
    expect(isCode('140600530230')).toBe(true);
    expect(isCode('abc')).toBe(false);
  });
});

describe('formatCode', () => {
  it('formats 12 digit codes correctly', () => {
    expect(formatCode('140600530230')).toBe('14.06.0053.0230');
  });
});
