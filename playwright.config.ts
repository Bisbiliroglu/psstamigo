import { defineConfig, devices } from "@playwright/test";

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
    baseURL: "http://localhost:5173/psstamigo/",
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
    command: "npm run dev",
    url: "http://localhost:5173/psstamigo/",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
