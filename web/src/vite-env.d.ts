/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /**
   * Token paired with the server's DASHBOARD_TOKEN. Only used when the
   * dashboard is built for a host that requires auth (LAN exposure). In
   * dev mode (localhost) the server has auth off, so this is left blank.
   */
  readonly VITE_DASHBOARD_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
