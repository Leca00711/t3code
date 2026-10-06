import { describe, expect, it } from "vite-plus/test";

import { openMcpElicitationUrl } from "./mcpElicitationLink";

describe("openMcpElicitationUrl", () => {
  it("opens the page and reports no error", async () => {
    const opened: string[] = [];
    await expect(
      openMcpElicitationUrl("https://github.com/login/device", async (url) => {
        opened.push(url);
      }),
    ).resolves.toBeNull();
    expect(opened).toEqual(["https://github.com/login/device"]);
  });

  it("explains a failed open so the user can copy the URL instead", async () => {
    await expect(
      openMcpElicitationUrl("https://x.test", async () => {
        throw new Error("Unable to open link.");
      }),
    ).resolves.toBe(
      "Couldn't open the browser: Unable to open link. Copy the URL and open it manually.",
    );
    await expect(openMcpElicitationUrl("https://x.test", undefined)).resolves.toBe(
      "Couldn't open the browser: Link opening is unavailable. Copy the URL and open it manually.",
    );
  });
});
