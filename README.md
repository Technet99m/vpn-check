# vpn-check

CLI app (Bun) to verify whether an IP is already used by a WireGuard peer. Queries wg-dashboard API.

## Setup

1. Copy `.env.example` to `.env`.
2. Set `WG_DASHBOARD_BASE_URL` to your dashboard base URL.
3. Set `WG_DASHBOARD_TOKEN` to your API token.
4. Set `WG_CONFIGURATION_NAME` (for example `wg0`).

## Run

Interactive REPL (prompts for IPs until you quit):

```bash
bun run src/index.ts
```

Single lookup (prints result and exits):

```bash
bun run src/index.ts 10.0.0.1
bun run src/index.ts 10.0.0.0/24
```

## Build binary (Windows)

```bash
bun run build
```

This creates:

```text
dist/vpn-check.exe
```

Run it directly:

```bash
./dist/vpn-check.exe
```

## Bake config into the binary

If you want the binary to run without a `.env`, set values in [src/baked-config.ts](src/baked-config.ts) and rebuild:

```ts
export const BAKED_WG_DASHBOARD_BASE_URL = "https://your-wg-dashboard";
export const BAKED_WG_DASHBOARD_TOKEN = "your-api-key";
export const BAKED_WG_DASHBOARD_TIMEOUT_MS = "10000";
export const BAKED_WG_CONFIGURATION_NAME = "wg0";
```

Then run:

```bash
bun run build
```

Runtime priority is:
1. Environment variable value
2. Baked value from `src/baked-config.ts`

## Build binary (current OS)

```bash
bun run build:current
```

You will be prompted:

```text
Enter IP to check (or q to quit):
```

Output:
- `Available` if no peer owns the IP.
- `Taken by: <peer name>` if the IP is already assigned.
- For CIDR input (for example `10.10.10.0/24`), each conflict is printed as `<allowed range> -> <peer name>`.

Print app version:

```bash
bun run src/index.ts --version
```

The peer name is parsed from keys like:

```text
ALice Laptop - CzMZhRjADmX3HmCx8PLQePSGoscEOPRg5+aOAk3/ZHA=
```

and shown as:

```text
ALice Laptop
```
