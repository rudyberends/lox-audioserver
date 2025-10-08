/** Wire format for outbound RPC commands sent to Music Assistant. */
export interface CommandRequest {
  command: string;
  message_id: number;
  args?: Record<string, any>;
}

/** Successful RPC payload from Music Assistant. */
export interface SuccessResultMessage {
  message_id: number;
  result?: any;
  partial?: boolean;
}

/** Error payload returned by Music Assistant. */
export interface ErrorResultMessage {
  message_id: number;
  error_code: string;
  details?: string;
}

/** Real-time event emitted over the Music Assistant websocket. */
export interface EventMessage {
  event: string;
  object_id?: string;
  data?: any;
}

/** Initial handshake frame describing the server. */
export interface ServerInfoMessage {
  server_version: string;
}

/** Discriminated union of all messages that can arrive on the websocket. */
export type IncomingMessage =
  | SuccessResultMessage
  | ErrorResultMessage
  | EventMessage
  | ServerInfoMessage
  | Record<string, any>;

/** Repeat mode values exposed by Music Assistant. */
export enum RepeatMode {
  OFF = 0,
  ONE = 1,
  ALL = 2,
}

/** Connection state for the websocket client. */
export enum ConnectionState {
  DISCONNECTED = 0,
  CONNECTING = 1,
  CONNECTED = 2,
}

/** Event callback signature used by the client. */
export type EventCallback = (evt: EventMessage) => void;
