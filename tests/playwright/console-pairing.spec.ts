import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";

const publicDirectory = resolve("apps/console/public");
const account = "0x1000000000000000000000000000000000000001";
const didA = "did:memo:agent:985:0x2000000000000000000000000000000000000001";
const didB = "did:memo:agent:985:0x2000000000000000000000000000000000000002";
const signature = `0x${"11".repeat(65)}`;

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!new Set(["index.html", "app.js", "styles.css"]).has(fileName)) {
      response.writeHead(404).end();
      return;
    }
    const contentType = fileName.endsWith(".html")
      ? "text/html; charset=utf-8"
      : fileName.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/css; charset=utf-8";
    response.writeHead(200, { "content-type": contentType });
    response.end(await readFile(resolve(publicDirectory, fileName)));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Console test server did not bind a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
});

function chainConfig() {
  return {
    chainId: 985,
    networkName: "MEMO Mainnet Local",
    environment: "local",
    rpcUrl: "http://127.0.0.1:9545",
    walletAddChainEnabled: false,
    nativeCurrency: { name: "MEMO", symbol: "MEMO", decimals: 18 },
    requiredConfirmations: 2,
    finality: { preferFinalizedTag: false, fallbackConfirmations: 2 },
    entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" },
    relayerSmartAccount: "0x3000000000000000000000000000000000000001",
    deploymentBlock: 1,
    contracts: {
      agentDidRegistry: { address: "0x4000000000000000000000000000000000000001" },
      agentManagementRegistry: { address: "0x4000000000000000000000000000000000000002" },
    },
  };
}

function agentSummary(agentDid: string, name: string, managed: boolean) {
  return {
    bindingId: `binding-${name}`,
    binding: { createdAt: "2026-11-03T09:00:00.000Z" },
    agentDid,
    identity: {
      exists: true,
      agentDid,
      identityAccount: agentDid.slice(-42),
      state: "ACTIVE",
      identityRevision: 1,
      profileHash: `0x${(managed ? "22" : "33").repeat(32)}`,
      network: "memo-mainnet:985",
    },
    profile: { name, description: `${name} 的可验证身份` },
    instances: [],
    management: managed ? {
      state: "ACTIVE",
      managerAccount: account,
      relationshipRevision: 1,
      managementScopes: ["profile.update", "instance.issue"],
    } : null,
    managementDraft: managed ? null : {
      draftId: "draft-agent-b",
      state: "AWAITING_WALLET_SIGNATURE",
    },
    pairing: {
      kind: managed ? "agent-offer" : "platform-invitation",
      state: "PAIRED",
      expiresAt: 1793698200,
    },
  };
}

function dashboard() {
  const config = chainConfig();
  const agents = [agentSummary(didA, "Agent Alpha", true), agentSummary(didB, "Agent Beta", false)];
  return {
    schema: "memo.agent-dashboard/2",
    walletSession: { account, chainId: 985 },
    walletDisplayDataDid: null,
    agents,
    pairingExchanges: [],
    counts: { total: 2, managed: 1, unmanaged: 1, pending: 1 },
    contract: {
      capabilities: [
        "identity.resolve.chain",
        "instance.create",
        "identity.suspend",
        "identity.resume",
        "identity.revoke",
      ],
    },
    events: [],
    chain: {
      config,
      latestBlock: { number: 128, hash: `0x${"44".repeat(32)}` },
      accounts: {
        relayer: {
          address: config.relayerSmartAccount,
          role: "Relayer Smart Account",
          balanceWei: "1000000000000000000",
          entryPointDepositWei: "500000000000000000",
        },
      },
      events: [],
      operations: [],
    },
  };
}

async function mockApi(page: Page) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    let data: unknown;
    if (pathname === "/api/v1/chain/config") data = chainConfig();
    else if (pathname === "/api/v1/wallet-login-intents") {
      data = { challengeId: "challenge-1", message: "Sign in to MEMO Agent DID" };
    } else if (pathname === "/api/v1/wallet-sessions") {
      data = { token: "test-wallet-session", account, chainId: 985, expiresAt: 1793698200 };
    } else if (pathname === "/api/v1/dashboard") data = dashboard();
    else if (pathname.startsWith("/api/v1/dashboard/agents/")) {
      const selectedDid = decodeURIComponent(pathname.slice("/api/v1/dashboard/agents/".length));
      const selected = dashboard().agents.find((agent) => agent.agentDid === selectedDid);
      data = { ...selected, contract: dashboard().contract, events: [] };
    } else if (pathname === "/api/v1/wallet-session") {
      data = { account, chainId: 985, expiresAt: 1793698200 };
    } else {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { code: "NOT_MOCKED", message: pathname } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data }),
    });
  });
}

async function installTwoWalletProviders(page: Page, options: {
  chainId?: string;
  switchErrorCode?: number;
  signErrorCode?: number;
} = {}) {
  await page.addInitScript(({ walletAccount, walletSignature, initialChainId, switchErrorCode, signErrorCode }) => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const createProvider = (label: string, isMetaMask = false) => ({
      label,
      isMetaMask,
      on(event: string, listener: (value: unknown) => void) {
        const values = listeners.get(event) || new Set();
        values.add(listener);
        listeners.set(event, values);
      },
      async request({ method }: { method: string }) {
        if (method === "eth_chainId") return initialChainId;
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [walletAccount];
        if (method === "personal_sign" || method === "eth_signTypedData_v4") {
          if (signErrorCode !== undefined) throw Object.assign(new Error("Mock wallet rejected signing"), { code: signErrorCode });
          return walletSignature;
        }
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
          if (switchErrorCode !== undefined) throw Object.assign(new Error("Mock wallet cannot switch network"), { code: switchErrorCode });
          return null;
        }
        throw Object.assign(new Error(`Unsupported mock method: ${method}`), { code: -32601 });
      },
    });
    const alpha = createProvider("Wallet Alpha", true);
    const beta = createProvider("Wallet Beta");
    Object.defineProperty(window, "ethereum", { configurable: true, value: alpha });
    Object.assign(window, {
      __memoWalletEmit(event: string, value: unknown) {
        for (const listener of listeners.get(event) || []) listener(value);
      },
    });
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: { info: { name: "Wallet Alpha" }, provider: alpha },
      }));
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: { info: { name: "Wallet Beta" }, provider: beta },
      }));
    });
  }, {
    walletAccount: account,
    walletSignature: signature,
    initialChainId: options.chainId || "0x3d9",
    switchErrorCode: options.switchErrorCode,
    signErrorCode: options.signErrorCode,
  });
}

async function selectAlphaAndConnect(page: Page) {
  await expect(page.locator(".wallet-provider-choice")).toHaveCount(2);
  await expect(page.locator("#connect-wallet")).toBeDisabled();
  await page.getByRole("button", { name: /Wallet Alpha/ }).click();
  await expect(page.locator("#connect-wallet")).toBeEnabled();
  await page.locator("#connect-wallet").click();
}

test("无 Provider 时显示可执行诊断和原页面地址", async ({ page }) => {
  await page.goto(origin);
  await expect(page.locator("#wallet-detection-status")).toContainText("NO_PROVIDER");
  await expect(page.getByRole("button", { name: "复制页面地址" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新检测钱包" })).toBeVisible();
  await expect(page.locator("#wallet-provider-list")).toContainText("Codex 内置浏览器");
  await expect(page.locator("#login-screen")).toHaveScreenshot("wallet-no-provider.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.03,
  });
});

test("EIP-6963 显式选钱包后登录并展示两个 Agent 与双向 Pairing", async ({ page }) => {
  await mockApi(page);
  await installTwoWalletProviders(page);
  await page.goto(origin);

  await selectAlphaAndConnect(page);

  await expect(page.locator("#app-screen")).toBeVisible();
  await expect(page.locator("#agents-table tr")).toHaveCount(2);
  await expect(page.locator("#agents-table")).toContainText("Agent Alpha");
  await expect(page.locator("#agents-table")).toContainText("Agent Beta");
  await expect(page.locator("#pending-count")).toHaveText("1");

  await page.getByRole("button", { name: /登记 \/ 创建/ }).first().click();
  await expect(page.getByRole("heading", { name: "平台生成邀请文件" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "导入 Agent 提供的 Offer" })).toBeVisible();
  await expect(page.locator("#app-screen")).toHaveScreenshot("pairing-and-multi-agent-dashboard.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.03,
  });
});

test("错误网络且禁止自动添加时展示 chain 985 手工配置", async ({ page }) => {
  await mockApi(page);
  await installTwoWalletProviders(page, { chainId: "0x1", switchErrorCode: 4902 });
  await page.goto(origin);
  await selectAlphaAndConnect(page);

  await expect(page.locator("#wallet-detection-status")).toContainText("WRONG_NETWORK");
  await expect(page.locator("#wallet-network-help")).toBeVisible();
  await expect(page.locator("#wallet-network-help")).toContainText("MEMO Mainnet Local");
  await expect(page.locator("#wallet-network-help")).toContainText("985");
  await expect(page.locator("#wallet-network-help")).toContainText("http://127.0.0.1:9545");
});

test("钱包拒签时明确显示 USER_REJECTED", async ({ page }) => {
  await mockApi(page);
  await installTwoWalletProviders(page, { signErrorCode: 4001 });
  await page.goto(origin);
  await selectAlphaAndConnect(page);

  await expect(page.locator("#wallet-detection-status")).toContainText("USER_REJECTED");
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.locator("#app-screen")).toBeHidden();
});

test("账户或网络变化立即撤销旧钱包会话", async ({ page }) => {
  await mockApi(page);
  await installTwoWalletProviders(page);
  await page.goto(origin);
  await selectAlphaAndConnect(page);
  await expect(page.locator("#app-screen")).toBeVisible();

  await page.evaluate(() => {
    (window as typeof window & { __memoWalletEmit: (event: string, value: unknown) => void })
      .__memoWalletEmit("accountsChanged", ["0x9000000000000000000000000000000000000009"]);
  });
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.locator("#wallet-detection-status")).toContainText("ACCOUNT_CHANGED");

  await page.locator("#connect-wallet").click();
  await expect(page.locator("#app-screen")).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __memoWalletEmit: (event: string, value: unknown) => void })
      .__memoWalletEmit("chainChanged", "0x1");
  });
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.locator("#wallet-detection-status")).toContainText("CHAIN_CHANGED");
});
