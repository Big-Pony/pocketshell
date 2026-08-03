// Hand-written types for `noise-handshake` (v4.2.0), which ships plain CommonJS
// with no .d.ts. Signatures transcribed from the package's own sources
// (node_modules/noise-handshake/{noise,cipher,dh}.js) and kept to what the
// library actually exposes — NOT `declare module "x"` (that is just `any`).
//
// Sibling of app/src/types/noise-handshake.d.ts. Same shape, one deliberate
// difference: every byte value the library *returns* comes out of `b4a.alloc()`,
// which under Bun/Node is a Node Buffer and in the browser a plain Uint8Array —
// in both cases backed by a real ArrayBuffer, never a SharedArrayBuffer. So the
// returns are typed `Uint8Array<ArrayBuffer>` (assignable to WebSocket.send /
// Response body / Buffer.compare), while every *parameter* stays the permissive
// `Uint8Array` so callers may hand in a view over any backing store.

declare module "noise-handshake" {
  /** Static or ephemeral X25519 key pair, as produced by `noise-handshake/dh`. */
  export interface NoiseKeyPair {
    publicKey: Uint8Array<ArrayBuffer>;
    secretKey: Uint8Array<ArrayBuffer>;
  }

  /** What the constructor accepts — any Uint8Array, however backed. */
  export interface NoiseKeyPairInput {
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
   * members this agent relies on are declared; the SymmetricState internals
   * (mixHash/mixKey/split/…) are deliberately left out.
   */
  export default class NoiseState {
    constructor(
      pattern: HandshakePattern,
      initiator: boolean,
      staticKeypair?: NoiseKeyPairInput | null,
      opts?: NoiseOptions,
    );

    /** Local static key pair (generated when none was passed in). */
    s: NoiseKeyPair;
    /**
     * Remote static public key. `null` until the pattern supplies it — either
     * from `initialise(prologue, remoteStatic)` on the pre-sharing side, or
     * from the handshake message carrying the peer's `s` token.
     */
    rs: Uint8Array<ArrayBuffer> | null;
    readonly initiator: boolean;
    readonly pattern: HandshakePattern;
    /** True once the last handshake message has been processed. */
    complete: boolean;
    /** Handshake hash; `null` until `final()` has run. */
    hash: Uint8Array<ArrayBuffer> | null;
    /** Split transport keys; `null` until `final()` has run. */
    tx: Uint8Array<ArrayBuffer> | null;
    rx: Uint8Array<ArrayBuffer> | null;

    /**
     * Mix in the prologue and any pre-shared static key. `remoteStatic` is
     * required whenever the pattern pre-shares the peer's static key on this
     * side (e.g. the IK initiator); it throws otherwise.
     */
    initialise(prologue: Uint8Array, remoteStatic?: Uint8Array): void;

    /** Write the next handshake message (optionally carrying a payload). */
    send(payload?: Uint8Array): Uint8Array<ArrayBuffer>;

    /** Read the next handshake message; returns its decrypted payload. */
    recv(buf: Uint8Array): Uint8Array<ArrayBuffer>;

    /** Split into transport keys. Called automatically by send/recv. */
    final(): void;
  }
}

declare module "noise-handshake/cipher" {
  /** CipherState (module.exports of cipher.js) — ChaCha20-Poly1305 with a counter nonce. */
  export default class CipherState {
    constructor(key?: Uint8Array | null);

    key: Uint8Array | null;
    /** Message counter; reset to 0 by initialiseKey, nulled by _clear(). */
    nonce: number | null;
    readonly CIPHER_ALG: string;
    readonly hasKey: boolean;

    initialiseKey(key: Uint8Array): void;
    setNonce(nonce: number): void;

    /** Throws when the ciphertext would exceed the 65535-byte Noise limit. */
    encrypt(plaintext: Uint8Array, ad?: Uint8Array): Uint8Array<ArrayBuffer>;
    decrypt(ciphertext: Uint8Array, ad?: Uint8Array): Uint8Array<ArrayBuffer>;

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

    /** Freshly generated random key pair. */
    generateKeyPair(): NoiseKeyPair;
    /**
     * Public key derived from an existing secret. Note the returned `secretKey`
     * is the very buffer that was passed in (dh.js does not copy it), so its
     * backing store is whatever the caller supplied.
     */
    generateKeyPair(privKey: Uint8Array): {
      publicKey: Uint8Array<ArrayBuffer>;
      secretKey: Uint8Array;
    };
    /** Deterministic key pair from a SKLEN-byte seed. */
    generateSeedKeyPair(seed: Uint8Array): NoiseKeyPair;
    /** Raw scalar multiplication: dh(theirPublicKey, myKeyPair). */
    dh(publicKey: Uint8Array, keyPair: { secretKey: Uint8Array }): Uint8Array<ArrayBuffer>;
  };

  export default DH;
}
