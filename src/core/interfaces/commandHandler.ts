export interface CommandHandler {
  handle(command: string, param?: any): Promise<boolean>;
}