export type GoogleCastModule = typeof import('@sonn-audio/node-googlecast');

let modulePromise: Promise<GoogleCastModule> | null = null;

export const loadGoogleCastModule = async (): Promise<GoogleCastModule> => {
  if (!modulePromise) {
    modulePromise = import('@sonn-audio/node-googlecast');
  }
  return modulePromise;
};
