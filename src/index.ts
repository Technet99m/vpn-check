import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import packageJson from "../package.json" with { type: "json" };
import {
  BAKED_WG_CONFIGURATION_NAME,
  BAKED_WG_DASHBOARD_BASE_URL,
  BAKED_WG_DASHBOARD_TIMEOUT_MS,
  BAKED_WG_DASHBOARD_TOKEN,
} from "./baked-config";

type ParsedPeer = {
  name: string;
  publicKey: string;
  allowedIps: string[];
};

type Ipv4Network = {
  start: number;
  end: number;
  maskBits: number;
  input: string;
};

type PeerInfo = {
  allowed_ips?: string[];
  endpoint?: string;
};

type PeerApiResponse = {
  data?: Record<string, Record<string, PeerInfo>>;
  message?: string | null;
  status?: boolean;
};

const APP_VERSION = String(packageJson.version ?? "0.0.0");
const RAW_CONFIG_ENDPOINT_PATH = "/api/getWireguardConfigurationRawFile";
const PEERS_ENDPOINT_PATH = "/api/ping/getAllPeersIpAddress";

// ── ANSI colors (only when writing to a real terminal) ──────────────────────

const isTTY = process.stdout.isTTY === true;
const c = {
  reset:  isTTY ? "\x1b[0m"  : "",
  bold:   isTTY ? "\x1b[1m"  : "",
  dim:    isTTY ? "\x1b[2m"  : "",
  green:  isTTY ? "\x1b[32m" : "",
  red:    isTTY ? "\x1b[31m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  cyan:   isTTY ? "\x1b[36m" : "",
};

function clr(color: keyof typeof c, text: string): string {
  return `${c[color]}${text}${c.reset}`;
}

// ── IP / CIDR helpers ────────────────────────────────────────────────────────

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function parseTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw ?? "10000");
  if (!Number.isFinite(parsed) || parsed <= 0) return 10000;
  return parsed;
}

function isValidIpv4(ip: string): boolean {
  const ipv4Regex = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  return ipv4Regex.test(ip);
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return (((a << 24) >>> 0) + ((b << 16) >>> 0) + ((c << 8) >>> 0) + d) >>> 0;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

function parseIpv4Network(raw: string): Ipv4Network | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [ipPart, prefixPart] = trimmed.split("/");
  if (!ipPart || !isValidIpv4(ipPart)) return null;

  const maskBits = prefixPart === undefined ? 32 : Number(prefixPart);
  if (!Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) return null;

  const ipInt = ipv4ToInt(ipPart);
  const mask = maskBits === 0 ? 0 : ((0xffffffff << (32 - maskBits)) >>> 0);
  const start = (ipInt & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;

  return {
    start,
    end,
    maskBits,
    input: maskBits === 32 ? intToIpv4(start) : `${intToIpv4(start)}/${maskBits}`,
  };
}

function rangesOverlap(a: Ipv4Network, b: Ipv4Network): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Human-readable summary of a network range. */
function describeRange(net: Ipv4Network): string {
  if (net.maskBits === 32) return intToIpv4(net.start);
  const count = net.end - net.start + 1;
  const countStr = count.toLocaleString("en-US");
  return `${intToIpv4(net.start)} – ${intToIpv4(net.end)}  (${countStr} addresses, /${net.maskBits})`;
}

// ── API helpers ──────────────────────────────────────────────────────────────

function getDashboardBaseAndHeaders(): { baseUrl: string; headers: Record<string, string> } {
  const base = process.env.WG_DASHBOARD_BASE_URL?.trim() || BAKED_WG_DASHBOARD_BASE_URL.trim();
  if (!base) {
    throw new Error("Missing WG_DASHBOARD_BASE_URL. Set env var or bake it in src/baked-config.ts.");
  }
  const headers: Record<string, string> = { Accept: "application/json, text/plain" };
  const token = process.env.WG_DASHBOARD_TOKEN?.trim() || BAKED_WG_DASHBOARD_TOKEN.trim();
  if (token) {
    headers["wg-dashboard-apikey"] = token;
  }
  return { baseUrl: normalizeBaseUrl(base), headers };
}

async function fetchWireguardRawConfig(): Promise<string> {
  const { baseUrl, headers } = getDashboardBaseAndHeaders();
  const configurationName =
    process.env.WG_CONFIGURATION_NAME?.trim() || BAKED_WG_CONFIGURATION_NAME.trim();
  if (!configurationName) {
    throw new Error("Missing WG_CONFIGURATION_NAME. Set env var or bake it in src/baked-config.ts.");
  }

  const timeoutMs = parseTimeoutMs(
    process.env.WG_DASHBOARD_TIMEOUT_MS?.trim() || BAKED_WG_DASHBOARD_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl}${RAW_CONFIG_ENDPOINT_PATH}?configurationName=${encodeURIComponent(configurationName)}`;
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });

    if (!response.ok) {
      throw new Error(`WG Dashboard request failed (${response.status} ${response.statusText}).`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as { data?: { content?: string }; status?: boolean; message?: string };
      if (typeof body.data?.content === "string") return body.data.content;
      throw new Error("Unexpected response shape: expected JSON data string.");
    }
    return await response.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function extractPeerName(peerKey: string): string {
  const sep = " - ";
  const idx = peerKey.lastIndexOf(sep);
  if (idx === -1) return peerKey.trim();
  return peerKey.slice(0, idx).trim();
}

function extractPublicKeyFromPeerKey(peerKey: string): string {
  const sep = " - ";
  const idx = peerKey.lastIndexOf(sep);
  if (idx === -1) return peerKey.trim();
  return peerKey.slice(idx + sep.length).trim();
}

async function fetchPeerNameByPublicKey(): Promise<Map<string, string>> {
  const { baseUrl, headers } = getDashboardBaseAndHeaders();
  const timeoutMs = parseTimeoutMs(
    process.env.WG_DASHBOARD_TIMEOUT_MS?.trim() || BAKED_WG_DASHBOARD_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${PEERS_ENDPOINT_PATH}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`WG Dashboard request failed (${response.status} ${response.statusText}).`);
    }

    const body = (await response.json()) as PeerApiResponse;
    if (!body?.data || typeof body.data !== "object") {
      throw new Error("Unexpected response shape: missing peers data.");
    }

    const nameByPublicKey = new Map<string, string>();
    for (const peers of Object.values(body.data)) {
      for (const peerKey of Object.keys(peers)) {
        const publicKey = extractPublicKeyFromPeerKey(peerKey);
        if (publicKey) nameByPublicKey.set(publicKey, extractPeerName(peerKey));
      }
    }
    return nameByPublicKey;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Config parsing ───────────────────────────────────────────────────────────

function parsePeersFromConfig(rawConfig: string, peerNameByPublicKey: Map<string, string>): ParsedPeer[] {
  const peers: ParsedPeer[] = [];
  let currentPeer: ParsedPeer | null = null;
  let pendingName = "";
  let pendingPublicKey = "";
  let peerIndex = 0;

  const finalizeCurrent = () => {
    if (!currentPeer) return;
    const mappedName = currentPeer.publicKey ? peerNameByPublicKey.get(currentPeer.publicKey) : undefined;
    const fallback = mappedName || pendingName || pendingPublicKey || `Peer ${peerIndex}`;
    currentPeer.name = currentPeer.name || fallback;
    peers.push(currentPeer);
  };

  for (const line of rawConfig.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const commentNameMatch = trimmed.match(/^#\s*(?:name|peer)\s*[:=]\s*(.+)$/i);
    if (commentNameMatch?.[1]) {
      pendingName = commentNameMatch[1].trim();
      continue;
    }

    if (trimmed === "[Peer]") {
      finalizeCurrent();
      peerIndex += 1;
      currentPeer = { name: pendingName, publicKey: "", allowedIps: [] };
      pendingName = "";
      pendingPublicKey = "";
      continue;
    }

    if (!currentPeer) continue;

    const [rawKey, ...rest] = trimmed.split("=");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (!value) continue;

    if (key === "publickey") {
      currentPeer.publicKey = value;
      pendingPublicKey = value;
      continue;
    }

    if (key === "allowedips") {
      currentPeer.allowedIps.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }

  finalizeCurrent();
  return peers;
}

// ── Lookup helpers ───────────────────────────────────────────────────────────

function findOwnerName(peers: ParsedPeer[], targetIp: string): string | null {
  const targetNetwork = parseIpv4Network(targetIp);
  if (!targetNetwork) return null;
  for (const peer of peers) {
    for (const allowedIp of peer.allowedIps) {
      const allowedNetwork = parseIpv4Network(allowedIp);
      if (allowedNetwork && rangesOverlap(targetNetwork, allowedNetwork)) return peer.name;
    }
  }
  return null;
}

function findConflictsInRange(
  peers: ParsedPeer[],
  targetRange: Ipv4Network,
): Array<{ owner: string; range: string; start: number }> {
  const conflicts = new Map<string, { owner: string; range: string; start: number }>();
  for (const peer of peers) {
    for (const allowedIp of peer.allowedIps) {
      const allowedNetwork = parseIpv4Network(allowedIp);
      if (!allowedNetwork || !rangesOverlap(targetRange, allowedNetwork)) continue;
      const key = `${allowedNetwork.start}-${allowedNetwork.end}-${peer.name}`;
      if (!conflicts.has(key)) {
        conflicts.set(key, { owner: peer.name, range: allowedNetwork.input, start: allowedNetwork.start });
      }
    }
  }
  return [...conflicts.values()].sort((a, b) => a.start - b.start || a.owner.localeCompare(b.owner));
}

// ── Output helpers ───────────────────────────────────────────────────────────

const QUIT_WORDS = new Set(["q", "quit", "exit", ":q", "bye"]);

function isQuitCommand(s: string): boolean {
  return QUIT_WORDS.has(s.toLowerCase());
}

function printBanner(): void {
  const line = "─".repeat(48);
  console.log(`\n${clr("bold", `  VPN IP Checker  v${APP_VERSION}`)}`);
  console.log(clr("dim", `  ${line}`));
  console.log(clr("dim", "  Enter an IPv4 address or CIDR range to check."));
  console.log(clr("dim", '  Type "exit" or press Ctrl+C to quit.\n'));
}

function showFetching(): () => void {
  if (!isTTY) return () => {};
  process.stdout.write(clr("dim", "  Fetching…"));
  return () => process.stdout.write("\r" + " ".repeat(12) + "\r");
}

function printSingleIpResult(ip: string, owner: string | null): void {
  if (owner) {
    console.log(`  ${clr("red", "✗")}  ${clr("bold", ip)} is ${clr("red", "taken")} by ${clr("yellow", owner)}`);
  } else {
    console.log(`  ${clr("green", "✓")}  ${clr("bold", ip)} is ${clr("green", "available")}`);
  }
}

function printRangeResult(
  net: Ipv4Network,
  conflicts: Array<{ owner: string; range: string; start: number }>,
): void {
  const rangeLabel = describeRange(net);
  console.log(`  ${clr("dim", "Range:")} ${clr("bold", rangeLabel)}`);

  if (conflicts.length === 0) {
    console.log(`  ${clr("green", "✓")}  No conflicts — range is fully available`);
    return;
  }

  const word = conflicts.length === 1 ? "conflict" : "conflicts";
  console.log(`  ${clr("red", "✗")}  ${clr("red", String(conflicts.length))} ${word} found:\n`);

  const maxRangeLen = Math.max(...conflicts.map((x) => x.range.length));
  for (const { range, owner } of conflicts) {
    const padded = range.padEnd(maxRangeLen);
    console.log(`     ${clr("yellow", padded)}  ${clr("dim", "→")}  ${owner}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runOnce(rawInput: string): Promise<void> {
  const targetNetwork = parseIpv4Network(rawInput);
  if (!targetNetwork) {
    console.error(`  ${clr("red", "!")}  Invalid IPv4 address or CIDR range: ${clr("bold", rawInput)}`);
    process.exitCode = 1;
    return;
  }

  const clearFetching = showFetching();
  let rawConfig: string;
  let peerNameByPublicKey: Map<string, string>;
  try {
    [rawConfig, peerNameByPublicKey] = await Promise.all([
      fetchWireguardRawConfig(),
      fetchPeerNameByPublicKey(),
    ]);
  } catch (err) {
    clearFetching();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${clr("red", "!")}  ${message}`);
    process.exitCode = 1;
    return;
  }
  clearFetching();

  const peers = parsePeersFromConfig(rawConfig, peerNameByPublicKey);

  if (targetNetwork.maskBits === 32) {
    const owner = findOwnerName(peers, targetNetwork.input);
    printSingleIpResult(targetNetwork.input, owner);
  } else {
    const conflicts = findConflictsInRange(peers, targetNetwork);
    printRangeResult(targetNetwork, conflicts);
  }
}

async function main() {
  if (process.argv.includes("--version")) {
    console.log(APP_VERSION);
    return;
  }

  const argIp = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (argIp !== undefined) {
    await runOnce(argIp);
    return;
  }

  printBanner();

  const rl = createInterface({ input, output });

  rl.on("SIGINT", () => {
    console.log("\n  Goodbye.");
    rl.close();
    process.exit(0);
  });

  try {
    while (true) {
      let rawInput = "";
      try {
        rawInput = (await rl.question(clr("cyan", "  > "))).trim();
      } catch (err) {
        // EOF / readline closed
        break;
      }

      if (!rawInput) continue;

      if (isQuitCommand(rawInput)) {
        console.log("  Goodbye.");
        break;
      }

      const targetNetwork = parseIpv4Network(rawInput);
      if (!targetNetwork) {
        console.log(`  ${clr("red", "!")}  Invalid IPv4 address or CIDR range: ${clr("bold", rawInput)}\n`);
        continue;
      }

      const clearFetching = showFetching();
      let rawConfig: string;
      let peerNameByPublicKey: Map<string, string>;
      try {
        [rawConfig, peerNameByPublicKey] = await Promise.all([
          fetchWireguardRawConfig(),
          fetchPeerNameByPublicKey(),
        ]);
      } catch (err) {
        clearFetching();
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  ${clr("red", "!")}  ${message}\n`);
        continue;
      }
      clearFetching();

      const peers = parsePeersFromConfig(rawConfig, peerNameByPublicKey);

      if (targetNetwork.maskBits === 32) {
        const owner = findOwnerName(peers, targetNetwork.input);
        printSingleIpResult(targetNetwork.input, owner);
      } else {
        const conflicts = findConflictsInRange(peers, targetNetwork);
        printRangeResult(targetNetwork, conflicts);
      }

      console.log();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error(`\n  ${clr("red", "Error:")} ${message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

await main();
