/**
 * -----------------------------------------------------------------------------
 * Registry Index
 * -----------------------------------------------------------------------------
 * Central export hub for all registry modules:
 *  - CommandMapperRegistry
 *  - StateMapperRegistry
 *  - ContentPlayerRegistry
 *  - ContentProviderRegistry
 *
 * This allows simple imports like:
 *   import { getContentPlayer } from '@/model/registry';
 * -----------------------------------------------------------------------------
 */

export * from './commandMapperRegistry';
export * from './stateMapperRegistry';
export * from './contentPlayerRegistry';
export * from './contentProviderRegistry';