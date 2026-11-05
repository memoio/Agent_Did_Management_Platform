import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve("apps/console/public/app.js"), "utf8");
const html = readFileSync(resolve("apps/console/public/index.html"), "utf8");

describe("Pairing v2 Console contract", () => {
  it("contains both Pairing directions and no active v1 command or API", () => {
    expect(app).toContain("/api/v1/pairing-invitations");
    expect(app).toContain("/api/v1/pairing-offers/inspect");
    expect(app).toContain("/api/v1/management-drafts/");
    expect(app).toContain("Platform Invitation");
    expect(app).toContain("Agent Offer");
    expect(app).not.toContain("/api/v1/pairing-grants");
    expect(html).not.toMatch(/pair create|shareHandle|memo-pair-v1/);
  });

  it("requires explicit Provider selection and renders actionable diagnostics", () => {
    expect(app).toContain("eip6963:requestProvider");
    expect(app).toContain("data-provider-index");
    expect(app).toContain("平台不会自动选择");
    expect(app).toContain("NO_PROVIDER");
    expect(app).toContain("Codex 内置浏览器");
    expect(app).toContain("wallet_switchEthereumChain");
    expect(app).toContain("walletAddChainEnabled");
    expect(app).toContain("USER_REJECTED");
    expect(app).toContain("REQUEST_PENDING");
  });

  it("drives list and detail views from the selected Agent DID", () => {
    expect(app).toContain("ui.dashboard.agents");
    expect(app).toContain("data-open-agent");
    expect(app).toContain("/api/v1/dashboard/agents/");
    expect(app).toContain("ui.selectedDid");
    expect(app).not.toContain("bindings.at(-1)");
  });
});
