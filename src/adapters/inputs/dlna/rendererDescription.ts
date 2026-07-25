import { escapeXml } from '@/adapters/mediaserver/didl';

/**
 * Static UPnP description documents for a MediaRenderer:1 device (one per zone).
 *
 * All renderer routes are namespaced under `/dlna-renderer/:zoneId/...` so a
 * single HTTP gateway serves every zone's renderer. The `:zoneId` in the path is
 * how the SOAP control endpoints know which zone a command targets.
 *
 *   /dlna-renderer/:zoneId/device.xml   — root device description (SSDP LOCATION)
 *   /dlna-renderer/:zoneId/avt/scpd.xml — AVTransport service description
 *   /dlna-renderer/:zoneId/rc/scpd.xml  — RenderingControl service description
 *   /dlna-renderer/:zoneId/cm/scpd.xml  — ConnectionManager service description
 *   /dlna-renderer/:zoneId/avt/control  — AVTransport SOAP control
 *   /dlna-renderer/:zoneId/rc/control   — RenderingControl SOAP control
 *   /dlna-renderer/:zoneId/cm/control   — ConnectionManager SOAP control
 *   /dlna-renderer/:zoneId/avt/event    — AVTransport GENA event subscription
 *   /dlna-renderer/:zoneId/rc/event     — RenderingControl GENA event subscription
 */

export function rendererBasePath(zoneId: number): string {
  return `/dlna-renderer/${zoneId}`;
}

export const RENDERER_PATHS = {
  device: 'device.xml',
  avtScpd: 'avt/scpd.xml',
  rcScpd: 'rc/scpd.xml',
  cmScpd: 'cm/scpd.xml',
  avtControl: 'avt/control',
  rcControl: 'rc/control',
  cmControl: 'cm/control',
  avtEvent: 'avt/event',
  rcEvent: 'rc/event',
} as const;

export function buildRendererDescription(params: {
  zoneId: number;
  udn: string;
  friendlyName: string;
  baseUrl: string;
}): string {
  const { zoneId, udn, friendlyName, baseUrl } = params;
  const base = `${baseUrl}${rendererBasePath(zoneId)}`;
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    `<URLBase>${escapeXml(base)}/</URLBase>` +
    '<device>' +
    '<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>' +
    `<friendlyName>${escapeXml(friendlyName)}</friendlyName>` +
    '<manufacturer>Sonn Audio</manufacturer>' +
    '<manufacturerURL>https://github.com/sonn-audio</manufacturerURL>' +
    '<modelDescription>Sonn Audio DLNA Renderer</modelDescription>' +
    '<modelName>Sonn Audio</modelName>' +
    '<modelNumber>1</modelNumber>' +
    `<UDN>${escapeXml(udn)}</UDN>` +
    '<dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMR-1.50</dlna:X_DLNADOC>' +
    '<serviceList>' +
    service(
      'AVTransport',
      `${base}/${RENDERER_PATHS.avtScpd}`,
      `${base}/${RENDERER_PATHS.avtControl}`,
      `${base}/${RENDERER_PATHS.avtEvent}`,
    ) +
    service(
      'RenderingControl',
      `${base}/${RENDERER_PATHS.rcScpd}`,
      `${base}/${RENDERER_PATHS.rcControl}`,
      `${base}/${RENDERER_PATHS.rcEvent}`,
    ) +
    serviceCm(
      `${base}/${RENDERER_PATHS.cmScpd}`,
      `${base}/${RENDERER_PATHS.cmControl}`,
    ) +
    '</serviceList>' +
    '</device>' +
    '</root>'
  );
}

function service(name: string, scpd: string, control: string, event: string): string {
  return (
    '<service>' +
    `<serviceType>urn:schemas-upnp-org:service:${name}:1</serviceType>` +
    `<serviceId>urn:upnp-org:serviceId:${name}</serviceId>` +
    `<SCPDURL>${escapeXml(scpd)}</SCPDURL>` +
    `<controlURL>${escapeXml(control)}</controlURL>` +
    `<eventSubURL>${escapeXml(event)}</eventSubURL>` +
    '</service>'
  );
}

function serviceCm(scpd: string, control: string): string {
  return (
    '<service>' +
    '<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>' +
    '<serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>' +
    `<SCPDURL>${escapeXml(scpd)}</SCPDURL>` +
    `<controlURL>${escapeXml(control)}</controlURL>` +
    '<eventSubURL></eventSubURL>' +
    '</service>'
  );
}

/**
 * AVTransport:1 SCPD. Declares the actions a control point may invoke. We
 * implement the transport essentials plus the state variables control points
 * read via GetTransportInfo/GetPositionInfo/GetMediaInfo.
 */
export const AVT_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>SetAVTransportURI</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>CurrentURI</name><direction>in</direction>
        <relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
      <argument><name>CurrentURIMetaData</name><direction>in</direction>
        <relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetNextAVTransportURI</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>NextURI</name><direction>in</direction>
        <relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>
      <argument><name>NextURIMetaData</name><direction>in</direction>
        <relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Play</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Speed</name><direction>in</direction>
        <relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Pause</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Stop</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Seek</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Unit</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_SeekMode</relatedStateVariable></argument>
      <argument><name>Target</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_SeekTarget</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetTransportInfo</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>CurrentTransportState</name><direction>out</direction>
        <relatedStateVariable>TransportState</relatedStateVariable></argument>
      <argument><name>CurrentTransportStatus</name><direction>out</direction>
        <relatedStateVariable>TransportStatus</relatedStateVariable></argument>
      <argument><name>CurrentSpeed</name><direction>out</direction>
        <relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetPositionInfo</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Track</name><direction>out</direction>
        <relatedStateVariable>CurrentTrack</relatedStateVariable></argument>
      <argument><name>TrackDuration</name><direction>out</direction>
        <relatedStateVariable>CurrentTrackDuration</relatedStateVariable></argument>
      <argument><name>TrackMetaData</name><direction>out</direction>
        <relatedStateVariable>CurrentTrackMetaData</relatedStateVariable></argument>
      <argument><name>TrackURI</name><direction>out</direction>
        <relatedStateVariable>CurrentTrackURI</relatedStateVariable></argument>
      <argument><name>RelTime</name><direction>out</direction>
        <relatedStateVariable>RelativeTimePosition</relatedStateVariable></argument>
      <argument><name>AbsTime</name><direction>out</direction>
        <relatedStateVariable>AbsoluteTimePosition</relatedStateVariable></argument>
      <argument><name>RelCount</name><direction>out</direction>
        <relatedStateVariable>RelativeCounterPosition</relatedStateVariable></argument>
      <argument><name>AbsCount</name><direction>out</direction>
        <relatedStateVariable>AbsoluteCounterPosition</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetMediaInfo</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>NrTracks</name><direction>out</direction>
        <relatedStateVariable>NumberOfTracks</relatedStateVariable></argument>
      <argument><name>MediaDuration</name><direction>out</direction>
        <relatedStateVariable>CurrentMediaDuration</relatedStateVariable></argument>
      <argument><name>CurrentURI</name><direction>out</direction>
        <relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
      <argument><name>CurrentURIMetaData</name><direction>out</direction>
        <relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
      <argument><name>NextURI</name><direction>out</direction>
        <relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>
      <argument><name>NextURIMetaData</name><direction>out</direction>
        <relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument>
      <argument><name>PlayMedium</name><direction>out</direction>
        <relatedStateVariable>PlaybackStorageMedium</relatedStateVariable></argument>
      <argument><name>RecordMedium</name><direction>out</direction>
        <relatedStateVariable>RecordStorageMedium</relatedStateVariable></argument>
      <argument><name>WriteStatus</name><direction>out</direction>
        <relatedStateVariable>RecordMediumWriteStatus</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetTransportSettings</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>PlayMode</name><direction>out</direction>
        <relatedStateVariable>CurrentPlayMode</relatedStateVariable></argument>
      <argument><name>RecQualityMode</name><direction>out</direction>
        <relatedStateVariable>CurrentRecordQualityMode</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetDeviceCapabilities</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>PlayMedia</name><direction>out</direction>
        <relatedStateVariable>PossiblePlaybackStorageMedia</relatedStateVariable></argument>
      <argument><name>RecMedia</name><direction>out</direction>
        <relatedStateVariable>PossibleRecordStorageMedia</relatedStateVariable></argument>
      <argument><name>RecQualityModes</name><direction>out</direction>
        <relatedStateVariable>PossibleRecordQualityModes</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>LastChange</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportState</name><dataType>string</dataType>
      <allowedValueList><allowedValue>STOPPED</allowedValue><allowedValue>PLAYING</allowedValue>
      <allowedValue>PAUSED_PLAYBACK</allowedValue><allowedValue>TRANSITIONING</allowedValue>
      <allowedValue>NO_MEDIA_PRESENT</allowedValue></allowedValueList></stateVariable>
    <stateVariable sendEvents="no"><name>TransportStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportPlaySpeed</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NumberOfTracks</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrack</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackDuration</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentMediaDuration</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NextAVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NextAVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeTimePosition</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteTimePosition</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeCounterPosition</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteCounterPosition</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PlaybackStorageMedium</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RecordStorageMedium</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RecordMediumWriteStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PossiblePlaybackStorageMedia</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PossibleRecordStorageMedia</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentPlayMode</name><dataType>string</dataType>
      <defaultValue>NORMAL</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>PossibleRecordQualityModes</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentRecordQualityMode</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekMode</name><dataType>string</dataType>
      <allowedValueList><allowedValue>REL_TIME</allowedValue><allowedValue>TRACK_NR</allowedValue></allowedValueList></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekTarget</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

/** RenderingControl:1 SCPD — volume + mute. */
export const RC_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetVolume</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>CurrentVolume</name><direction>out</direction>
        <relatedStateVariable>Volume</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetVolume</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>DesiredVolume</name><direction>in</direction>
        <relatedStateVariable>Volume</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetMute</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>CurrentMute</name><direction>out</direction>
        <relatedStateVariable>Mute</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetMute</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction>
        <relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>DesiredMute</name><direction>in</direction>
        <relatedStateVariable>Mute</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>LastChange</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>Volume</name><dataType>ui2</dataType>
      <allowedValueRange><minimum>0</minimum><maximum>100</maximum><step>1</step></allowedValueRange></stateVariable>
    <stateVariable sendEvents="no"><name>Mute</name><dataType>boolean</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Channel</name><dataType>string</dataType>
      <allowedValueList><allowedValue>Master</allowedValue></allowedValueList></stateVariable>
  </serviceStateTable>
</scpd>`;

/** ConnectionManager:1 SCPD — the sink side (we accept http-get audio). */
export const CM_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetProtocolInfo</name><argumentList>
      <argument><name>Source</name><direction>out</direction>
        <relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
      <argument><name>Sink</name><direction>out</direction>
        <relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;
