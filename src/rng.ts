//mulberry32 algo Credit: https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript
function rng(seed: number): () => number {
    return function() {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = seed;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

function rngInt(generator: () => number): (min: number, max: number) => number {
    return function(min: number, max: number) {
        return Math.floor(generator() * (max - min + 1)) + min;
    }
}

function rngChoice<T>(generator: () => number): (choices: T[]) => T {
    return function(choices: T[]) {
        if(choices.length === 0) {
            throw new Error("Cannot choose from an empty array");
        }
        const index = Math.floor(generator() * choices.length);

        return choices[index] as T;
    }
}

// normal noise, with σ (Box–Muller from two uniforms);
function rngNormal(generator: () => number): (mean: number, stddev: number) => number {
    return function(mean: number, stddev: number) {
        let u = 0, v = 0;
        while(u === 0) u = generator(); // Converting [0,1) to (0,1)
        while(v === 0) v = generator();
        const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        return z * stddev + mean;
    }
}

//uniform in a range, for the lifespan ε in for ex (−0.25, 0.25);
function rngUniform(generator: () => number): (min: number, max: number) => number {
    return function(min: number, max: number) {
        return generator() * (max - min) + min;
    }
}

// murmur3 32-bit finalizer: every input bit affects about half of the output bits.
function fmix32(h: number): number {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

// FNV-1a 32-bit string hash.
function fnv1a(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// An independent stream seed per purpose: rng(deriveSeed(runSeed, "noise")).
// Without fmix32, multiplication only carries bits upward, so a change in a high seed bit
// would change only the same high bit of the result.
function deriveSeed(seed: number, label: string): number {
    return fmix32(fnv1a(label) ^ fmix32(seed));
}

export { rng, rngInt, rngChoice, rngNormal, rngUniform, deriveSeed };