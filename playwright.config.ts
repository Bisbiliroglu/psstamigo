import { defineConfig, devices } from "@playwright/test";

/**
 * PSST_E2E_TARGET=preview runs the suite against the production build (with CSP)
 * served by `vite preview`; the default is the Vite dev server.
 */
const preview = process.env["PSST_E2E_TARGET"] === "preview";
const origin = preview ? "http://localhost:4173" : "http://localhost:5173";

/**
 * Browser integration tests. They use the real PeerJS Cloud signaling server,
 * so an internet connection is required. Microphone input is a Chromium fake device;
 * no real microphone is ever captured by the test suite.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `${origin}/psstamigo/`,
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
        },
      },
    },
  ],
  webServer: {
    command: preview ? "npx vite build && npx vite preview --port 4173 --strictPort" : "npm run dev",
    url: `${origin}/psstamigo/`,
    reuseExistingServer: !preview,
    timeout: 120_000,
  },
});
