type State = {
  zones: any[];
  groups: any[];
  config: any;
  logs: any[];
};

const state: State = {
  zones: [],
  groups: [],
  config: {},
  logs: []
};

const subscribers = new Set<(s: State) => void>();

export const Store = {
  get: () => state,
  set(p: Partial<State>) {
    Object.assign(state, p);
    subscribers.forEach(cb => cb(state));
  },
  subscribe(cb: (s: State) => void) {
    subscribers.add(cb);
    cb(state);
    return () => subscribers.delete(cb);
  }
};
