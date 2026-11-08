// tests for ../src/rng.ts
import { expect, it } from "vitest";
import { rng, rngInt, rngChoice, rngNormal, rngUniform, deriveSeed } from "../src/rng";

it('rng produces consistent results for the same seed', () => {
    const seed = 12345;
    const firstGenerator = rng(seed);
    const secondGenerator = rng(seed);
    const firstRun = Array.from({ length: 5 }, () => firstGenerator());
    const secondRun = Array.from({ length: 5 }, () => secondGenerator());
    expect(firstRun).toEqual(secondRun);
});

it('rng produces different results for different seeds', () => {
    const a = rng(1), b = rng(2);
    const runA = Array.from({ length: 5 }, () => a());
    const runB = Array.from({ length: 5 }, () => b());
    expect(runA).not.toEqual(runB);
});

it('rng values are in [0, 1)', () => {
    const generator = rng(13579);
    for (let i = 0; i < 10_000; i++) {
        const value = generator();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
    }
});

it('rngInt produces integers within the specified range, including both ends', () => {
    const seed = 67890;
    const generator = rng(seed);
    const intGenerator = rngInt(generator);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
        const value = intGenerator(1, 10);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(10);
        expect(Number.isInteger(value)).toBe(true);
        seen.add(value);
    }
    expect(seen.has(1)).toBe(true);
    expect(seen.has(10)).toBe(true);
});

it('rngChoice selects an element from the provided array', () => {
    const seed = 54321;
    const generator = rng(seed);
    const choiceGenerator = rngChoice(generator);
    const choices = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 100; i++) {
        const choice = choiceGenerator(choices);
        expect(choices).toContain(choice);
    }
});

it('rngChoice throws an error when given an empty array', () => {
    const seed = 11111;
    const generator = rng(seed);
    const choiceGenerator = rngChoice(generator);
    expect(() => choiceGenerator([])).toThrow("Cannot choose from an empty array");
});

it('rngNormal produces values with the specified mean and stddev', () => {
    const seed = 98765;
    const generator = rng(seed);
    const normalGenerator = rngNormal(generator);
    // stddev ≠ 1, otherwise a bug like `z / stddev` would give the same output as `z * stddev`.
    const mean = 10;
    const stddev = 3;
    const n = 10_000;
    const samples = Array.from({ length: n }, () => normalGenerator(mean, stddev));
    const sampleMean = samples.reduce((acc, val) => acc + val, 0) / n;
    const sampleStddev = Math.sqrt(samples.reduce((acc, val) => acc + (val - sampleMean) ** 2, 0) / (n - 1));
    // Standard error of the mean is 3/√10000 = 0.03; the tolerances are several times that.
    expect(Math.abs(sampleMean - mean)).toBeLessThan(0.15);
    expect(Math.abs(sampleStddev - stddev)).toBeLessThan(0.15);
});

it('rngUniform produces values in the half-open range [min, max)', () => {
    const seed = 24680;
    const generator = rng(seed);
    const uniformGenerator = rngUniform(generator);
    for (let i = 0; i < 1000; i++) {
        const value = uniformGenerator(-1, 1);
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThan(1);
    }
});

it('deriveSeed produces different seeds for different labels', () => {
    const baseSeed = 123456;
    const seed1 = deriveSeed(baseSeed, "label1");
    const seed2 = deriveSeed(baseSeed, "label2");
    expect(seed1).not.toEqual(seed2);
});

it('deriveSeed produces the same seed for the same label', () => {
    const baseSeed = 123456;
    const seed1 = deriveSeed(baseSeed, "label");
    const seed2 = deriveSeed(baseSeed, "label");
    expect(seed1).toEqual(seed2);
});

it('deriveSeed produces different seeds for different base seeds', () => {
    const seed1 = deriveSeed(111111, "label");
    const seed2 = deriveSeed(222222, "label");
    expect(seed1).not.toEqual(seed2);
});

it('deriveSeed produces a non-negative integer in [0, 2^32)', () => {
    const baseSeed = 123456;
    const derivedSeed = deriveSeed(baseSeed, "label");
    expect(Number.isInteger(derivedSeed)).toBe(true);
    expect(derivedSeed).toBeGreaterThanOrEqual(0);
    expect(derivedSeed).toBeLessThan(Math.pow(2, 32));
});

function popcount(n: number): number {
    let count = 0;
    for (let x = n >>> 0; x !== 0; x >>>= 1) count += x & 1;
    return count;
}

it('deriveSeed spreads a change in a high seed bit across the result', () => {
    // Without a finalizer, flipping the top seed bit flips only the top bit of the result.
    const a = deriveSeed(0, "noise");
    const b = deriveSeed(0x80000000, "noise");
    expect(popcount(a ^ b)).toBeGreaterThan(8);
});

it('drawing from one derived stream does not change another', () => {
    const runSeed = 42;
    const expected = rng(deriveSeed(runSeed, "lifespan"))();

    const noise = rng(deriveSeed(runSeed, "noise"));
    const lifespan = rng(deriveSeed(runSeed, "lifespan"));
    for (let i = 0; i < 100; i++) noise(); // e.g. a policy change adds draws elsewhere

    expect(lifespan()).toBe(expected);
});