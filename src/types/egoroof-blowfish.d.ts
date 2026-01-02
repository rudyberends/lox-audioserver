declare module 'egoroof-blowfish' {
  export class Blowfish {
    static MODE: {
      CBC: number;
    };
    static PADDING: {
      NULL: number;
    };
    static TYPE: {
      UINT8_ARRAY: number;
    };

    constructor(
      key: string | ArrayBuffer | Uint8Array | Buffer,
      mode?: number,
      padding?: number,
    );
    setIv(iv: Uint8Array | Buffer | string): void;
    decode(data: Uint8Array | Buffer, type?: number): Uint8Array;
  }
}
