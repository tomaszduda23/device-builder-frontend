/** Formatting for the browser flash engines' details-log lines. */

/**
 * A progress line every ten percent: feed it each percent as it lands and it
 * logs ``<label>: <percent>%`` the first time a new tenth is reached (the
 * percent as reached, so a transfer that jumps to 68% prints 68%).
 */
export function tenthLogger(
  log: (line: string) => void,
  label: string
): (percent: number) => void {
  let nextTenth = 10;
  return (percent) => {
    if (percent < nextTenth) return;
    log(`${label}: ${percent}%`);
    nextTenth = Math.floor(percent / 10) * 10 + 10;
  };
}
