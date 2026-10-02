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
export const GROWTH_PER_MINUTE = 0.1;
export const MAX_ORDERS_PER_MINUTE = 30;

/**
 * Orders per minute after `elapsedMs` of play.
 *
 * Must return START_ORDERS_PER_MINUTE at 0, never decrease as time passes,
 * never exceed MAX_ORDERS_PER_MINUTE, and be busier after five minutes than
 * at the start (src/game/traffic.test.js holds it to all four).
 */
export function ordersPerMinute(elapsedMs) {
  // FlyWell's shape, steeper: a step at each full minute, so every minute is
  // noticeably busier than the last. 10 % rather than FlyWell's 5 % because a
  // homepage visit lasts minutes, not half an hour: ~9.7/min at minute 5, the
  // board overflows (~24/min) around minute 15, the cap arrives at minute 17.
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60000);
  return Math.min(
    MAX_ORDERS_PER_MINUTE,
    START_ORDERS_PER_MINUTE * (1 + GROWTH_PER_MINUTE) ** minutes,
  );
}
