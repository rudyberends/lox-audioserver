export interface PrimaryExperienceSourceType {
  type?: string;
}

export interface PrimaryExperienceProduct {
  jid?: string;
  friendlyName?: string;
}

export interface PrimaryExperienceSource {
  id?: string;
  friendlyName?: string;
  sourceType?: PrimaryExperienceSourceType;
  product?: PrimaryExperienceProduct;
  [key: string]: any;
}

export interface PrimaryExperience {
  source?: PrimaryExperienceSource;
  listener?: Array<string | { jid?: string }>;
  state?: string;
  lastUsed?: string;
  [key: string]: any;
}

export interface NotificationData {
  speaker?: {
    level: number;
  };
  artist?: string;
  album?: string;
  name?: string;
  liveDescription?: string;
  friendlyName?: string;
  playQueueItemId?: string;
  duration?: number;
  trackImage?: { url: string }[];
  image?: any;
  state?: string;
  position?: number;
  primaryExperience?: PrimaryExperience;
  [key: string]: any;
}

export interface NotificationPayload {
  id?: number | string;
  timestamp?: string;
  type: string;
  kind?: string;
  data: NotificationData;
}

export interface NotificationMessage {
  notification: NotificationPayload;
}
