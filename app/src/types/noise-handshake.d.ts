// Hand-written types for `noise-handshake` (v4.2.0), which ships plain CommonJS
// with no .d.ts. Signatures transcribed from the package's own sources
// (node_modules/noise-handshake/{noise,cipher,dh}.js) and kept to what the
// library actually exposes — NOT `declare module "x"` (that is just `any`).
//
// Byte types: the library uses b4a internally, which returns a Node Buffer
// under Node and a Uint8Array in the browser. Buffer is a Uint8Array subclass,
// so Uint8Array is the honest common type for both.

declare module "noise-handshake" {
  /** Static or ephemeral X25519 key pair, as produced by `noise-handshake/dh`. */
  export interface NoiseKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export type HandshakePattern = "NN" | "NNpsk0" | "XX" | "XXpsk0" | "IK" | "XK";

  export interface NoiseOptions {
    /** Pre-shared key; only meaningful for the *psk0 patterns. */
    psk?: Uint8Array;
  }

  /**
   * NoiseState (module.exports of noise.js) — extends SymmetricState. Only the
   * members this app relies on are declared; the SymmetricState internals
   * (mixHash/mixKey/split/…) are deliberately left out.
   */
  export default class NoiseState {
    constructor(
      pattern: HandshakePattern,
      initiator: boolean,
      staticKeypair?: NoiseKeyPair | null,
      opts?: NoiseOptions,
    );

    /** Local static key pair (generated when none was passed in). */
    s: NoiseKeyPair;
    /** Remote static public key; set from `initialise` or learned mid-handshake. */
    rs: Uint8Array | null;
    readonly initiator: boolean;
    readonly pattern: HandshakePattern;
    /** True once the last handshake message has been processed. */
    complete: boolean;
    /** Handshake hash, available after completion. */
    hash: Uint8Array | null;
    /** Split transport keys, available after completion. */
    tx: Uint8Array | null;
    rx: Uint8Array | null;

    /**
     * Mix in the prologue and any pre-shared static key. `remoteStatic` is
     * required whenever the pattern pre-shares the peer's static key on this
     * side (e.g. the IK initiator); it throws otherwise.
     */
    initialise(prologue: Uint8Array, remoteStatic?: Uint8Array): void;

    /** Write the next handshake message (optionally carrying a payload). */
    send(payload?: Uint8Array): Uint8Array;

    /** Read the next handshake message; returns its decrypted payload. */
    recv(buf: Uint8Array): Uint8Array;

    /** Split into transport keys. Called automatically by send/recv. */
    final(): void;
  }
}

declare module "noise-handshake/cipher" {
  /** CipherState (module.exports of cipher.js) — ChaCha20-Poly1305 with a counter nonce. */
  export default class CipherState {
    constructor(key?: Uint8Array | null);

    key: Uint8Array | null;
    nonce: number | null;
    readonly CIPHER_ALG: string;
    readonly hasKey: boolean;

    initialiseKey(key: Uint8Array): void;
    setNonce(nonce: number): void;

    /** Throws when the ciphertext would exceed the 65535-byte Noise limit. */
    encrypt(plaintext: Uint8Array, ad?: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array, ad?: Uint8Array): Uint8Array;

    static readonly MACBYTES: number;
    static readonly NONCEBYTES: number;
    static readonly KEYBYTES: number;
  }
}

declare module "noise-handshake/dh" {
  import type { NoiseKeyPair } from "noise-handshake";

  /** X25519 primitives (module.exports of dh.js) — exported as one object. */
  const DH: {
    readonly DHLEN: number;
    readonly PKLEN: number;
    readonly SKLEN: number;
    readonly SEEDLEN: number;
    readonly ALG: "25519";

    /** Random key pair, or the public key derived from `privKey` when given. */
    generateKeyPair(privKey?: Uint8Array): NoiseKeyPair;
    /** Deterministic key pair from a SKLEN-byte seed. */
    generateSeedKeyPair(seed: Uint8Array): NoiseKeyPair;
    /** Raw scalar multiplication: dh(theirPublicKey, myKeyPair). */
    dh(publicKey: Uint8Array, keyPair: { secretKey: Uint8Array }): Uint8Array;
  };

  export default DH;
}
