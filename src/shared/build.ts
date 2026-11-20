declare const __ENT3D_BUILD__: string | undefined;

/** Injected at build time. Tests and `vite dev` fall back to `dev`. */
export const BUILD_ID: string =
  typeof __ENT3D_BUILD__ === 'string' && __ENT3D_BUILD__.length > 0 ? __ENT3D_BUILD__ : 'dev';
