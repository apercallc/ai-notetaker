/**
 * Stopping a recording ends it for good, so every place that offers a stop
 * button (the in-call pill, the panel, the popup) asks the same way: the first
 * press arms the button and says so, a second press within a few seconds stops,
 * and doing nothing quietly puts the button back.
 */
export const STOP_LABEL = "Stop notes";
export const STOP_CONFIRM_LABEL = "Stop notes?";
export const STOP_CONFIRM_WINDOW_MS = 3000;

export interface StopConfirmOptions {
  /** Show the armed state (label, aria, styling). */
  arm: () => void;
  /** Restore the resting state. */
  disarm: () => void;
  /** The confirmed second press. */
  confirm: () => void;
  windowMs?: number;
}

export function createStopConfirm(options: StopConfirmOptions): { press: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    options.disarm();
  };
  return {
    cancel,
    press: () => {
      if (timer !== null) {
        cancel();
        options.confirm();
        return;
      }
      options.arm();
      timer = setTimeout(() => {
        timer = null;
        options.disarm();
      }, options.windowMs ?? STOP_CONFIRM_WINDOW_MS);
    },
  };
}
