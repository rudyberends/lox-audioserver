export interface AlertFileInfo {
  id: string;
  filename: string;
  url: string;
  hasBackup: boolean;
}

export interface AlertFilesPort {
  list(): Promise<AlertFileInfo[]>;
  update(id: string, base64Data: string): Promise<void>;
  revert(id: string): Promise<void>;
}
