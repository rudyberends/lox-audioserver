export type ZoneId = number;

export interface MapperInit {
  zoneId?: ZoneId;
  zoneName: string;
}

export interface CommandHandleResult {
  handled: boolean;
}

export type GenericCommand = string;

