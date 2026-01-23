export type StorageReadOptions = {
  writeIfMissing?: boolean;
};

export interface StoragePort {
  readJson<T>(path: string, fallback: T, options?: StorageReadOptions): Promise<T>;
  writeJson(path: string, data: unknown): Promise<void>;
  list(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}
