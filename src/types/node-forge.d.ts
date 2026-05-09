declare module 'node-forge' {
  export namespace pki {
    interface KeyPair {
      privateKey: unknown;
      publicKey: unknown;
    }
    namespace rsa {
      function generateKeyPair(opts: { bits: number; e?: number }): KeyPair;
    }
    function createCertificate(): {
      publicKey: unknown;
      serialNumber: string;
      validity: { notBefore: Date; notAfter: Date };
      setSubject(attrs: Array<{ name: string; value: string }>): void;
      setIssuer(attrs: Array<{ name: string; value: string }>): void;
      setExtensions(extensions: Array<Record<string, unknown>>): void;
      sign(privateKey: unknown, md?: unknown): void;
    };
    function certificateToPem(cert: unknown): string;
    function privateKeyToPem(key: unknown): string;
  }
  export namespace md {
    namespace sha256 {
      function create(): unknown;
    }
  }
}
