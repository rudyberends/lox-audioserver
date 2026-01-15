declare module 'acoustid' {
  type AcoustidOptions = {
    key: string;
    meta?: string;
    fpcalc?: Record<string, unknown>;
  };
  type AcoustidCallback = (err: Error | null, results: any[]) => void;
  const acoustid: (file: string, options: AcoustidOptions, callback: AcoustidCallback) => void;
  export default acoustid;
}
