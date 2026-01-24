export type GoogleCastModule = typeof import('@lox-audioserver/node-googlecast');

let modulePromise: Promise<GoogleCastModule> | null = null;

export const loadGoogleCastModule = async (): Promise<GoogleCastModule> => {
  if (!modulePromise) {
    modulePromise = import('@lox-audioserver/node-googlecast');
  }
  return modulePromise;
};
