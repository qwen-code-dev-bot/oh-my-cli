export const DESKTOP_CHANNELS = Object.freeze({
  getBootstrapState: "desktop:get-bootstrap-state",
});

export type DesktopChannel =
  (typeof DESKTOP_CHANNELS)[keyof typeof DESKTOP_CHANNELS];

export interface DesktopBootstrapState {
  platform: NodeJS.Platform;
  version: string;
}

export interface DesktopBridge {
  getBootstrapState(): Promise<DesktopBootstrapState>;
}

export type DesktopInvoker = (
  channel: DesktopChannel,
) => Promise<DesktopBootstrapState>;

export function createDesktopBridge(
  invoke: DesktopInvoker,
): DesktopBridge {
  return Object.freeze({
    getBootstrapState: () =>
      invoke(DESKTOP_CHANNELS.getBootstrapState),
  });
}
