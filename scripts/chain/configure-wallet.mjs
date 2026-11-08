import { HDNodeWallet, getAddress } from "ethers";
import { readFile, lstat, open, link, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export function deriveAccount(phrase, passphrase, index, expectedAddress) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 10000) {
    throw new Error("INVALID_ACCOUNT_INDEX");
  }
  const wallet = HDNodeWallet.fromPhrase(
    phrase.trim().split(/\s+/u).join(" "),
    passphrase,
    `m/44'/60'/0'/0/${index}`,
  );
  if (wallet.address !== getAddress(expectedAddress)) {
    throw new Error("ADDRESS_MISMATCH");
  }
  return wallet;
}

export function findAccount(phrase, passphrase, index, expectedAddress) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 10000) {
    throw new Error("INVALID_ACCOUNT_INDEX");
  }
  const rootWallet = HDNodeWallet.fromPhrase(
    phrase.trim().split(/\s+/u).join(" "), passphrase, "m",
  );
  const expected = getAddress(expectedAddress);
  const paths = new Set([`m/44'/60'/0'/0/${index}`]);
  for (let account = 0; account < 50; account++) {
    paths.add(`m/44'/60'/0'/0/${account}`);
    paths.add(`m/44'/60'/${account}'/0/0`);
    paths.add(`m/44'/60'/0'/${account}`);
  }
  for (const derivationPath of paths) {
    const wallet = rootWallet.derivePath(derivationPath);
    if (wallet.address === expected) return wallet;
  }
  throw new Error("ADDRESS_MISMATCH");
}

// A real terminal is mandatory. No command arguments, pipes or echoed readline input.
function hiddenInput(prompt) {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY || !input.setRawMode) {
    throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  }
  process.stdout.write(prompt);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      input.removeListener("keypress", onKey);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write("\n");
      if (error) { value = ""; reject(error); }
      else resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c") return finish(new Error("CANCELLED"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { value = value.slice(0, -1); return; }
      if (!key.ctrl && !key.meta && typeof text === "string") {
        value += text.replace(/[\x00-\x1f\x7f]/g, "");
        if (value.length > 4096) finish(new Error("INPUT_TOO_LONG"));
      }
    };
    input.on("keypress", onKey);
  });
}

export async function writeWalletEnvironment(directory, wallet) {
  const filename = path.join(directory, ".env.local");
  // Refuse tracked files even when ignore rules also match.
  const tracked = execFileSync("git", ["ls-files", "--", ".env.local"], { cwd: directory, encoding: "utf8" });
  if (tracked.trim()) throw new Error("ENV_FILE_TRACKED");
  execFileSync("git", ["check-ignore", "-q", "--", ".env.local"], { cwd: directory });
  let content;
  let exists = false;
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("ENV_FILE_UNSAFE");
    exists = true;
    content = await readFile(filename, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    content = await readFile(path.join(directory, ".env.example"), "utf8");
  }
  const previous = parseEnv(content);
  if (previous.MEMO_RELAYER_PRIVATE_KEY || previous.MEMO_SIGNER_MODULE_PATH) {
    throw new Error("SIGNER_ALREADY_CONFIGURED");
  }
  // Existing blank files are preserved for manual review, avoiding overwrite races.
  if (exists) throw new Error("ENV_FILE_ALREADY_EXISTS");
  const values = {
    MEMO_RELAYER_ADDRESS: wallet.address,
    MEMO_DEPLOYER_ADDRESS: wallet.address,
    MEMO_RELAYER_PRIVATE_KEY: wallet.privateKey,
    MEMO_CHAIN_WRITES_ENABLED: "false",
  };
  for (const name of Object.keys(values)) {
    content = content.replace(new RegExp(`^${name}=.*\\r?$`, "gm"), "");
  }
  content = content.trimEnd() + "\n" + Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n") + "\n";
  const temporary = path.join(directory, `.env.wallet-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    // Hard-link publication is atomic and refuses to replace an existing destination.
    await link(temporary, filename);
  } finally { await unlink(temporary); }
  return filename;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("ARGUMENTS_NOT_SUPPORTED");
  const example = parseEnv(await readFile(path.join(root, ".env.example"), "utf8"));
  const expected = getAddress(example.MEMO_RELAYER_ADDRESS);
  console.log(`目标测试账户 ${expected}`);
  console.log("输入仅在本机处理，将检查常见 Ethereum 钱包路径及前 50 个账户。");
  const indexText = await hiddenInput("账户序号（首个账户为 0，直接回车默认 0）: ");
  if (indexText && !/^(0|[1-9][0-9]*)$/.test(indexText)) throw new Error("INVALID_ACCOUNT_INDEX");
  let phrase = await hiddenInput("助记词（隐藏输入）: ");
  let passphrase = await hiddenInput("BIP-39 附加口令（未设置则直接回车，区别于钱包解锁密码）: ");
  let wallet;
  try { wallet = findAccount(phrase, passphrase, Number(indexText || "0"), expected); }
  finally { phrase = ""; passphrase = ""; }
  const filename = await writeWalletEnvironment(root, wallet);
  console.log(`地址核对通过 ${wallet.address}`);
  console.log(`匹配的派生路径 ${wallet.path}`);
  console.log(`已配置 ${filename}。交易开关保持 false。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const known = new Set(["INVALID_ACCOUNT_INDEX", "ADDRESS_MISMATCH", "INTERACTIVE_TERMINAL_REQUIRED", "CANCELLED", "INPUT_TOO_LONG", "ENV_FILE_TRACKED", "ENV_FILE_UNSAFE", "ENV_FILE_ALREADY_EXISTS", "SIGNER_ALREADY_CONFIGURED", "ARGUMENTS_NOT_SUPPORTED"]);
    console.error(known.has(error.message) ? error.message : "WALLET_CONFIGURATION_FAILED");
    if (error.message === "ADDRESS_MISMATCH") {
      console.error("常见路径未找到目标地址。请核对助记词所属钱包、目标账户和 BIP-39 附加口令。附加口令未设置时直接回车，勿输入钱包解锁密码。");
    }
    process.exitCode = 1;
  });
}
