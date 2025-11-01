export interface ZoneCommandMapper {
  readonly type: string;

  initialize?(): Promise<void>;
  handle(command: string, param?: any): Promise<boolean>;
  destroy?(): Promise<void>;

  getMetadata?(): Record<string, any>;
}