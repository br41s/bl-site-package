/**
 * How busy the offices are: orders per minute, as a function of how long the
 * game has been running.
 *
 * The simulation (rules.js) asks this function for the current rate every
 * time it schedules the next order, so this is the one place the game's
 * difficulty is decided. Patience per order is fixed (PATIENCE_MS in
 * rules.js) and there are six offices: at 6 orders a minute a new one opens
 * every ten seconds; past ~24 a minute the board stays full and lives start to
 * go no matter how fast the player is.
 */

export const START_ORDERS_PER_MINUTE = 6;
export const MAX_ORDERS_PER_MINUTE = 30;

/**
 * Orders per minute after `elapsedMs` of play.
 *
 * Must return START_ORDERS_PER_MINUTE at 0, never decrease as time passes,
 * never exceed MAX_ORDERS_PER_MINUTE, and be busier after five minutes than
 * at the start (src/game/traffic.test.js holds it to all four).
 */
export function ordersPerMinute(elapsedMs) {
  // TODO(Brais): the difficulty curve.
  return START_ORDERS_PER_MINUTE;
}
