import { describe, expect, test } from '@jest/globals';
import { classifyByQtyProfit, medianThreshold } from '../dish-optimization-report.js';

describe('dish-optimization classifyByQtyProfit', () => {
  test('medianThreshold on odd count', () => {
    expect(medianThreshold((x) => x, [1, 2, 9])).toBe(2);
  });

  test('four quadrants for dishes in one category', () => {
    const dishes = [
      { dish: 'A', qty: 10, revenue: 100, profit: 80 },
      { dish: 'B', qty: 10, revenue: 100, profit: 20 },
      { dish: 'C', qty: 2, revenue: 50, profit: 40 },
      { dish: 'D', qty: 1, revenue: 10, profit: 2 }
    ];
    const { star, traffic, potential, eliminate, sparse } = classifyByQtyProfit(dishes);
    expect(sparse).toEqual([]);
    expect(star.length + traffic.length + potential.length + eliminate.length).toBe(4);
    const hi = new Set([...star, ...traffic, ...potential, ...eliminate].map((x) => x.dish));
    expect(hi.size).toBe(4);
  });

  test('sparse when single dish', () => {
    const { sparse } = classifyByQtyProfit([{ dish: 'X', qty: 1, revenue: 10, profit: 5 }]);
    expect(sparse.length).toBe(1);
  });
});
