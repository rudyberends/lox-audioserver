/**
 * Port-level shape of the "zone player" abstraction. The concrete class lives
 * in the application layer; ports only see the surface that adapters can rely
 * on. Kept intentionally minimal — adapters that need richer player state must
 * negotiate it through an explicit port method, not by depending on the class.
 */
export interface ZonePlayer {
  getState(): unknown;
}
