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
}

export interface NotificationMessage {
  notification: {
    type: string;
    data: NotificationData;
  };
}
