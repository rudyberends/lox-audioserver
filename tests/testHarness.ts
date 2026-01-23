export type TestFn = () => void | Promise<void>;

export const tests: Array<{ name: string; fn: TestFn }> = [];

export const test = (name: string, fn: TestFn): void => {
  tests.push({ name, fn });
};
