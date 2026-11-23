import { describe, expect, it } from 'vitest';
import { feeRate, feeText, parseFee } from './partner';

describe('Frais d’interface (builder code)', () => {
  it('lit le frais en dixièmes de point de base, dans les bornes d’Hyperliquid', () => {
    expect(parseFee('10')).toBe(10);
    expect(parseFee('100')).toBe(100);
    expect(parseFee('101')).toBe(0);
    expect(parseFee('2.5')).toBe(0);
    expect(parseFee(undefined)).toBe(0);
  });

  it('écrit le taux autorisé et le taux lisible', () => {
    expect(feeRate(10)).toBe('0.01%');
    expect(feeRate(100)).toBe('0.1%');
    expect(feeRate(5)).toBe('0.005%');
    expect(feeText(10)).toBe('0,01 %');
  });
});
