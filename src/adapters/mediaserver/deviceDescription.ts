import { escapeXml } from '@/adapters/mediaserver/didl';

/**
 * Static UPnP description documents for the MediaServer:1 device.
 *
 * Paths (served relative to the gateway origin):
 *   /dlna/device.xml        — root device description (SSDP LOCATION points here)
 *   /dlna/cds/scpd.xml       — ContentDirectory service description
 *   /dlna/cms/scpd.xml       — ConnectionManager service description (minimal)
 *   /dlna/cds/control        — ContentDirectory SOAP control endpoint
 */

export const DEVICE_DESCRIPTION_PATH = '/dlna/device.xml';
export const CDS_SCPD_PATH = '/dlna/cds/scpd.xml';
export const CMS_SCPD_PATH = '/dlna/cms/scpd.xml';
export const CDS_CONTROL_PATH = '/dlna/cds/control';
export const CMS_CONTROL_PATH = '/dlna/cms/control';
export const CDS_EVENT_PATH = '/dlna/cds/event';
export const CMS_EVENT_PATH = '/dlna/cms/event';

export function buildDeviceDescription(params: {
  udn: string;
  friendlyName: string;
  baseUrl: string;
}): string {
  const { udn, friendlyName, baseUrl } = params;
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    `<URLBase>${escapeXml(baseUrl)}</URLBase>` +
    '<device>' +
    '<deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>' +
    `<friendlyName>${escapeXml(friendlyName)}</friendlyName>` +
    '<manufacturer>Sonn Audio</manufacturer>' +
    '<manufacturerURL>https://github.com/sonn-audio</manufacturerURL>' +
    '<modelDescription>Sonn Audio DLNA MediaServer</modelDescription>' +
    '<modelName>Sonn Audio</modelName>' +
    '<modelNumber>1</modelNumber>' +
    `<UDN>${escapeXml(udn)}</UDN>` +
    // Sec/DLNA hint so strict controllers (Samsung/B&O) recognise a media server.
    '<dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMS-1.50</dlna:X_DLNADOC>' +
    '<serviceList>' +
    '<service>' +
    '<serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>' +
    '<serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>' +
    `<SCPDURL>${CDS_SCPD_PATH}</SCPDURL>` +
    `<controlURL>${CDS_CONTROL_PATH}</controlURL>` +
    `<eventSubURL>${CDS_EVENT_PATH}</eventSubURL>` +
    '</service>' +
    '<service>' +
    '<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>' +
    '<serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>' +
    `<SCPDURL>${CMS_SCPD_PATH}</SCPDURL>` +
    `<controlURL>${CMS_CONTROL_PATH}</controlURL>` +
    `<eventSubURL>${CMS_EVENT_PATH}</eventSubURL>` +
    '</service>' +
    '</serviceList>' +
    '</device>' +
    '</root>'
  );
}

/**
 * ContentDirectory SCPD. Declares the actions a control point may invoke. We
 * implement Browse (the essential one) plus the required GetSystemUpdateID and
 * GetSearchCapabilities/GetSortCapabilities stubs.
 */
export const CDS_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument><name>ObjectID</name><direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>BrowseFlag</name><direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSystemUpdateID</name>
      <argumentList>
        <argument><name>Id</name><direction>out</direction>
          <relatedStateVariable>SystemUpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSearchCapabilities</name>
      <argumentList>
        <argument><name>SearchCaps</name><direction>out</direction>
          <relatedStateVariable>SearchCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSortCapabilities</name>
      <argumentList>
        <argument><name>SortCaps</name><direction>out</direction>
          <relatedStateVariable>SortCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType>
      <allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

/** Minimal ConnectionManager SCPD — enough for controllers that require it to exist. */
export const CMS_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>GetProtocolInfo</name>
      <argumentList>
        <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
        <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

const CMS_NS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
// Advertise the explicit PN-tagged MP3 profile we actually serve (matching the
// <res> protocolInfo and the track's contentFeatures header) so a strict sink
// recognises the profile, plus the audio/mpeg wildcard as a fallback.
const SOURCE_PROTOCOL_INFO = [
  'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=00;DLNA.ORG_CI=0;' +
    'DLNA.ORG_FLAGS=8D500000000000000000000000000000',
  'http-get:*:audio/mpeg:*',
].join(',');

/** SOAP response for ConnectionManager GetProtocolInfo (we are source-only). */
export function buildGetProtocolInfoResponse(): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:GetProtocolInfoResponse xmlns:u="${CMS_NS}">` +
    `<Source>${escapeXml(SOURCE_PROTOCOL_INFO)}</Source>` +
    '<Sink></Sink>' +
    '</u:GetProtocolInfoResponse>' +
    '</s:Body></s:Envelope>'
  );
}
