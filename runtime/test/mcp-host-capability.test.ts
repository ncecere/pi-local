import { StdioTransport } from "@earendil-works/pi-mcp";
import { afterEach, expect, it, vi } from "vitest";
import { createTransport } from "../src/lib/mcp.ts";

vi.mock("@earendil-works/pi-mcp", async (original) => ({
 ...await original<typeof import("@earendil-works/pi-mcp")>(),
 StdioTransport: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());
it.each([undefined, false, true])("uses only the host capability (%s), overriding saved/inherited env", (trustedHumanConfirmations) => {
 vi.stubEnv("PI_LOCAL_TRUSTED_HUMAN_CONFIRMATIONS", "1");
 createTransport({ slug: "apple", name: "Apple", transport: "stdio", command: "synthetic-node", trustedHumanConfirmations,
  env: { PI_LOCAL_TRUSTED_HUMAN_CONFIRMATIONS: "1", OTHER: "retained" } });
 expect(StdioTransport).toHaveBeenLastCalledWith(expect.objectContaining({
  env: { PI_LOCAL_TRUSTED_HUMAN_CONFIRMATIONS: trustedHumanConfirmations === true ? "1" : "0", OTHER: "retained" },
 }));
});
