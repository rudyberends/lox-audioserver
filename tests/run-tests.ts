import { runComputeAuthorizationHeaderTests } from './config.test';
import { runMergeZoneConfigEntriesTests } from './zonemanager.test';
import { runRequestSummaryTests } from './requestSummary.test';
import { runZoneDynamicCommandTests } from './zoneCommandsDynamic.test';

function main() {
  runComputeAuthorizationHeaderTests();
  runMergeZoneConfigEntriesTests();
  runRequestSummaryTests();
  runZoneDynamicCommandTests();
  console.log('All targeted unit tests passed.');
}

main();
