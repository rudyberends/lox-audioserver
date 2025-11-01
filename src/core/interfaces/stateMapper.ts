export interface StateMapper {
  initialize?(): Promise<void>;
  dispose?(): void;
}