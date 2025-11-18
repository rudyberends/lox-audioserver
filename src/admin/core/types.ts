// Basic, permissive types to avoid behavior changes while giving TS structure.
export interface Zone {
  id?: number | string;
  name?: string;
  [key: string]: any;
}
export interface Group {
  id?: string | number;
  name?: string;
  members?: Array<number|string>;
  [key: string]: any;
}
export interface Config {
  [key: string]: any;
}
export interface LogEntry {
  ts?: string | number;
  level?: string;
  message?: string;
  [key: string]: any;
}
