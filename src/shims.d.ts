// ---- yargs (loose) ----
declare module "yargs" { const y: any; export default y; }
declare module "yargs/helpers" { export function hideBin(argv: string[]): string[]; }

// ---- bn.js (typed enough so BN can be a type) ----
declare module "bn.js" {
  class BN {
    constructor(
      number?: number | string | Uint8Array | Buffer,
      base?: number | "hex",
      endian?: "le" | "be"
    );
    toString(base?: number | "hex"): string;
    add(b: BN): BN; sub(b: BN): BN; mul(b: BN): BN; div(b: BN): BN;
    isZero(): boolean;
  }
  namespace BN { function isBN(x: any): x is BN; }
  export = BN; // supports `import BN from "bn.js"` with esModuleInterop
}

// ---- Meteora DLMM SDK (loose) ----
declare module "@meteora-ag/dlmm" {
  const mod: any;
  export = mod;
  export default mod;
}
