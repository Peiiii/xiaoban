import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });
await cp(resolve(root, "public"), resolve(root, "dist"), { recursive: true });
console.log(
  `Built ${(await readdir(resolve(root, "dist"))).length} static files. Server source: server/index.mjs`,
);

await mkdir(resolve(root, "dist/vendor"), { recursive: true });
await cp(
  resolve(root, "node_modules/@gemigo/app-sdk/dist/gemigo-app-sdk.umd.js"),
  resolve(root, "dist/vendor/gemigo-app-sdk.umd.js"),
);
if (process.env.GEMIGO_PROJECT_ID) {
  const config = {
    projectId: process.env.GEMIGO_PROJECT_ID,
    appId: process.env.GEMIGO_APP_ID,
    apiBase: process.env.GEMIGO_API_BASE || "https://gemigo.io/api/v1",
    platformOrigin: process.env.GEMIGO_PLATFORM_ORIGIN || "https://gemigo.io",
    requireLogin: process.env.GEMIGO_PUBLIC_ACCESS !== "1",
  };
  await writeFile(
    resolve(root, "dist/gateway-config.js"),
    `export default ${JSON.stringify(config)};\n`,
  );
}
