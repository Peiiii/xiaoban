import { mkdir, cp } from "node:fs/promises";
const directory = new URL("../public/vendor/", import.meta.url);
await mkdir(directory, { recursive: true });
await cp(
  new URL(
    "../node_modules/@gemigo/app-sdk/dist/gemigo-app-sdk.umd.js",
    import.meta.url,
  ),
  new URL("gemigo-app-sdk.umd.js", directory),
);
