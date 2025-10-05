export interface CommandRequest {
  command: string;
  message_id: number;
  args?: Record<string, any>;
}

export interface SuccessResultMessage {
  message_id: number;
  result?: any;
  partial?: boolean;
}

export interface ErrorResultMessage {
  message_id: number;
  error_code: string;
  details?: string;
}

export interface EventMessage {
  event: string;
  object_id?: string;
  data?: any;
}

export interface ServerInfoMessage {
  server_version: string;
}

export type IncomingMessage =
  | SuccessResultMessage
  | ErrorResultMessage
  | EventMessage
  | ServerInfoMessage
  | Record<string, any>;

export enum RepeatMode {
  OFF = 0,
  ONE = 1,
  ALL = 2,
}

export enum ConnectionState {
  DISCONNECTED = 0,
  CONNECTING = 1,
  CONNECTED = 2,
}

export type EventCallback = (evt: EventMessage) => void;
