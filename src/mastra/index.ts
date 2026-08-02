/**
 * Platform-deployable Mastra entry for MastraCode.
 *
 * This module is the ONE place deployment env is read. It maps today's env
 * vars onto explicit `MastraFactory` config — instances for behaviors (pubsub,
 * storage, vector), plain values for config (publicUrl, origins) — so anyone
 * reading the entry sees exactly which env var feeds which slot.
 * Everything else (feature readiness, route/middleware assembly, controller
 * construction) lives in `MastraFactory` (`@mastra/factory`).
 *
 * `mastra build` requires the entry to export a `Mastra` instance named
 * `mastra` constructed by a literal `new Mastra(...)` in THIS file (validated
 * by the deployer's `checkConfigExport` Babel plugin) — which is why the
 * factory returns constructor args from `prepare()` instead of the instance.
 * The Mastra CLI consumes this entry everywhere: `mastra dev`, `mastra build`,
 * and `mastra deploy` all bundle this module and let the deployer generate
 * the server.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LocalSandbox } from '@mastra/core/workspace';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { PgVector, PgFactoryStorage } from '@mastra/pg';
import { PlatformSandbox } from '@mastra/platform-workspace';
import { RailwaySandbox } from '@mastra/railway';
import { RedisStreamsPubSub } from '@mastra/redis-streams';
import { getDatabasePath } from '@mastra/code-sdk/utils/project';
import { DEFAULT_RETENTION } from '@mastra/code-sdk/utils/storage-maintenance';
import { MastraFactory } from '@mastra/factory';
import { GithubIntegration } from '@mastra/factory/integrations/github/integration';
import { LinearIntegration } from '@mastra/factory/integrations/linear/integration';
import type { IMastraAuthProvider } from '@mastra/core/server';
import { MastraAuthWorkos } from '@mastra/auth-workos';

/**
 * Parse a positive-integer env knob; anything else means "use the default".
 * Fractional values are rejected rather than floored — flooring `0.5` to `0`
 * would silently disable a capacity knob or turn an idle window into
 * immediate expiry.
 */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

// Distributed pub/sub: when `REDIS_URL` is set, events (streams, workflows,
// signals) ride Redis Streams so multiple web server processes can share one
// event bus. RedisStreamsPubSub also implements LeaseProvider, so the factory
// marks it cross-process and the controller drops its file-based thread locks
// in favor of pubsub-coordinated leases. Without `REDIS_URL` (bare local dev)
// the in-process default applies.
const redisUrl = process.env.REDIS_URL;
const pubsub = redisUrl ? new RedisStreamsPubSub({ url: redisUrl }) : undefined;
if (redisUrl) {
  // Redact credentials before logging (REDIS_URL may embed a password).
  let redisTarget = 'redis';
  try {
    const parsed = new URL(redisUrl);
    redisTarget = `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Unparseable URL — RedisStreamsPubSub will surface the real error; keep the log generic.
  }
  console.log(`[PubSub] REDIS_URL set — event bus on Redis Streams (${redisTarget}), cross-process leases enabled.`);
}

// Factory dev is auth-less by default. Production can opt out explicitly;
// otherwise MastraFactory installs its platform-backed auth provider.
const authDisabled = process.env.MASTRACODE_AUTH_DISABLED === '1';
let auth: IMastraAuthProvider | null | undefined;

if (authDisabled) {
  auth = null;
} else if (process.env.WORKOS_API_KEY?.trim() && process.env.WORKOS_CLIENT_ID?.trim()) {
  // WORKOS_* env vars present → use WorkOS AuthKit instead of the default
  // MastraAuthStudio (which proxies to platform.mastra.ai). MastraAuthWorkos
  // reads apiKey/clientId/redirectUri/cookiePassword from env on its own.
  auth = new MastraAuthWorkos();
}

// Direct GitHub App fallback: when the platform-backed integration isn't in
// play (self-hosted / local deploys), a complete GITHUB_APP_* env group wires
// a GithubIntegration so the app still gets a real GitHub connection — Connect
// GitHub in onboarding, the repo picker, and webhooks. A partial group stays
// disabled so the status route can report exactly what's missing.
const githubAppId = process.env.GITHUB_APP_ID?.trim();
const githubPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
const githubClientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
const githubClientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
const githubAppSlug = process.env.GITHUB_APP_SLUG?.trim();
const github =
  githubAppId && githubPrivateKey && githubClientId && githubClientSecret && githubAppSlug
    ? new GithubIntegration({
        appId: githubAppId,
        privateKey: githubPrivateKey,
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        slug: githubAppSlug,
        webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET?.trim() || undefined,
      })
    : undefined;

// Direct Linear OAuth fallback for self-hosted / local deploys. As with the
// GitHub fallback, only a complete credential group enables the integration;
// partial configuration remains available to the diagnostics routes.
const linearClientId = process.env.LINEAR_CLIENT_ID?.trim();
const linearClientSecret = process.env.LINEAR_CLIENT_SECRET?.trim();
const linear =
  linearClientId && linearClientSecret
    ? new LinearIntegration({
        clientId: linearClientId,
        clientSecret: linearClientSecret,
      })
    : undefined;

// Host env exposed to local sandboxes: an allow-list only, so app secrets
// (GITHUB_APP_PRIVATE_KEY, WORKOS_API_KEY, DATABASE_URL, …) never leak into
// commands run against untrusted repo checkouts. PATH is always added by the
// core LocalSandbox itself; the rest keeps git and TLS working normally.
const LOCAL_SANDBOX_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

function localSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of LOCAL_SANDBOX_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

const PLATFORM_SANDBOX_ENV_KEYS = ['MASTRA_ENVIRONMENT_ID', 'MASTRA_PROJECT_ID', 'MASTRA_PLATFORM_SECRET_KEY'] as const;
const hasPlatformSandboxEnv = PLATFORM_SANDBOX_ENV_KEYS.every(key => Boolean(process.env[key]?.trim()));

// Sandbox provider selection: Railway is an explicit opt-in via
// MASTRACODE_SANDBOX_PROVIDER=railway — a stray RAILWAY_API_TOKEN alone must not
// silently start billing cloud VMs, and selecting railway without credentials
// fails the boot loudly. The only env passed to RailwaySandbox is a static
// PATH literal (patch 4c, SANDBOX_PATH below) — nothing host-derived, so host
// secrets stay out of the VM — and token/environmentId come from the
// constructor's own RAILWAY_API_TOKEN / RAILWAY_ENVIRONMENT_ID fallback. With
// the provider unset,
// use PlatformSandbox only when its complete identity is configured, otherwise
// fall back to LocalSandbox for single-user development.
const sandboxProvider = process.env.MASTRACODE_SANDBOX_PROVIDER?.trim().toLowerCase();
// Custom base image for Railway sandboxes (patches 4b/4c): Go and Rust at
// pinned versions plus clippy, cargo-deny and unzip, so factory sessions can
// run cargo/go gates in-VM, and the base image's mise-managed node toolchain
// symlinked into /usr/local/bin (NODE_STEP below). Template builds are
// content-addressed on the recipe (per the Railway SDK docs) — identical
// recipes are cache hits, so the build cost is paid once per recipe change,
// not per sandbox. The cache key does NOT include the underlying base image:
// a cached recipe keeps serving an image built on an old base even after
// Railway rolls a new one (observed 2026-08-02).
// MASTRACODE_SANDBOX_TEMPLATE=off falls back to the stock image (kill switch
// for when a toolchain download source breaks template builds).
const sandboxTemplate = process.env.MASTRACODE_SANDBOX_TEMPLATE?.trim().toLowerCase() ?? 'toolchains';
const GO_STEP = 'curl -fsSL https://go.dev/dl/go1.26.5.linux-amd64.tar.gz | tar -C /usr/local -xz && ln -s /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/';
const RUST_STEP = 'curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile default --default-toolchain 1.97.1 && ln -s /root/.cargo/bin/* /usr/local/bin/';
const DENY_STEP = 'curl -fsSL https://github.com/EmbarkStudios/cargo-deny/releases/download/0.20.2/cargo-deny-0.20.2-x86_64-unknown-linux-musl.tar.gz | tar -xz -C /tmp && install /tmp/cargo-deny-0.20.2-x86_64-unknown-linux-musl/cargo-deny /root/.cargo/bin/ && ln -s /root/.cargo/bin/cargo-deny /usr/local/bin/';
// Patch 4c (2026-08-02): the Railway base image went mise-managed — node, pnpm
// and corepack live under /root/.local/share/mise and stopped resolving in the
// non-login `sh -c` context that runs worktree setup commands, agent
// execute_command calls and sandbox filesystem ops (exit 127 "pnpm: not
// found"). Template-built VMs additionally run commands with NO PATH in the
// environment at all, which breaks corepack's self-lookup and every child
// process a package manager spawns — plain symlinks are not enough. NODE_STEP
// therefore writes wrapper scripts into /usr/local/bin (found via the shell's
// built-in default PATH) that export a usable PATH and exec the mise
// binaries; node is also copied to /usr/bin for `#!/usr/bin/env node`
// shebangs, whose execvp fallback searches /bin:/usr/bin. test -x fails the
// image build loudly if the mise layout drifts; the trailing version calls
// execute through the wrappers (pnpm exercises the env-shebang chain), so a
// broken wrapper also fails the build.
const NODE_STEP = 'd=/root/.local/share/mise/installs/node/lts/bin; P=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$d; for b in node npm npx corepack pnpm pnpx yarn; do test -x $d/$b || exit 1; printf \'#!/bin/sh\\nPATH="${PATH:-%s}"\\nexport PATH\\nexec %s "$@"\\n\' "$P" "$d/$b" > /usr/local/bin/$b && chmod 755 /usr/local/bin/$b || exit 1; done && cp /usr/local/bin/node /usr/bin/node && /usr/local/bin/node --version && /usr/local/bin/pnpm --version && /usr/local/bin/corepack --version';
// A static PATH is also baked at sandbox creation for completeness — but the
// factory fleet always passes its own env ({ GH_TOKEN }) to clone()
// (fleet.js #build), and RailwaySandbox.clone resolves `options.env ??
// this._env`, so this constructor env is DISPLACED on every fleet VM. The
// NODE_STEP wrappers above are the mechanism that actually reaches fleet
// sessions; this literal only covers non-fleet creates. Nothing host-derived
// either way, preserving patch 4's no-host-secrets invariant.
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/share/mise/installs/node/lts/bin';
if (
  sandboxProvider === 'railway' &&
  !(process.env.RAILWAY_API_TOKEN?.trim() && process.env.RAILWAY_ENVIRONMENT_ID?.trim())
) {
  throw new Error(
    'MASTRACODE_SANDBOX_PROVIDER=railway requires RAILWAY_API_TOKEN and RAILWAY_ENVIRONMENT_ID.',
  );
}
const sandbox =
  sandboxProvider === 'railway'
    ? new RailwaySandbox({
        idleTimeoutMinutes: positiveInt(process.env.MASTRACODE_SANDBOX_IDLE_MINUTES) ?? 30,
        env: { PATH: SANDBOX_PATH },
        ...(sandboxTemplate !== 'off'
          ? { template: t => t.withPackages('unzip').run(GO_STEP).run(RUST_STEP).run(DENY_STEP).run(NODE_STEP) }
          : {}),
      })
    : hasPlatformSandboxEnv
      ? new PlatformSandbox()
      : new LocalSandbox({
          workingDirectory:
            process.env.MASTRACODE_LOCAL_SANDBOX_ROOT?.trim() || join(homedir(), '.mastracode', 'web', 'sandboxes'),
          env: localSandboxEnv(),
        });

// One FactoryStorage backend powers agent storage, the factory app tables,
// the distributed project lock, and better-auth. `DATABASE_URL` set →
// Postgres (the paired PgVector rides the same database for recall search).
// Unset (bare local dev) → libSQL on the same local file the SDK's default
// storage resolution uses, running the FULL app surface (auth, intake,
// audit, work-items, integrations) — no features silently off.
//
// `APP_DATABASE_URL` is the deprecated legacy name — still honored as a
// fallback so existing checkouts keep working, but new setups should use
// `DATABASE_URL` (matches the platform's managed env-var sync for attached
// databases, so `mastra deploy` populates it automatically).
const databaseUrl = process.env.DATABASE_URL?.trim() || process.env.APP_DATABASE_URL?.trim() || undefined;
if (process.env.APP_DATABASE_URL?.trim() && !process.env.DATABASE_URL?.trim()) {
  console.warn(
    '[mastracode-web] APP_DATABASE_URL is deprecated — rename it to DATABASE_URL. ' +
      'The old name is honored as a fallback for now, but new deploys should use DATABASE_URL.',
  );
}
const localDevelopmentMode = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
if (!databaseUrl && !localDevelopmentMode) {
  throw new Error('DATABASE_URL is required outside local development and tests.');
}

const storage = databaseUrl
  ? new PgFactoryStorage({
      id: 'mastra-code-storage',
      connectionString: databaseUrl,
      retention: DEFAULT_RETENTION,
    })
  : new LibSQLFactoryStorage({
      id: 'mastra-code-storage',
      url: `file:${getDatabasePath()}`,
      retention: DEFAULT_RETENTION,
    });
const vector = databaseUrl ? new PgVector({ id: 'mastra-code-vectors', connectionString: databaseUrl }) : undefined;

const integrations = [...(github ? [github] : []), ...(linear ? [linear] : [])];

export const factory = new MastraFactory({
  auth,
  integrations,
  sandbox: {
    machine: sandbox,
    // Remote checkout base (nested `owner/name` per repo). LocalSandbox ignores
    // this in-sandbox path and uses its host workingDirectory instead.
    workdir: process.env.MASTRACODE_SANDBOX_WORKDIR,
    // Per-replica cap on concurrently provisioned sandboxes. Unset → unlimited.
    maxSandboxes: positiveInt(process.env.MASTRACODE_MAX_SANDBOXES),
  },
  // Agent state (threads, messages, memory, OM, recall vectors) lives in the
  // single app Postgres alongside the github/app tables — one shared DB (and
  // pg pool) for all users, separated by `resourceId` scoping. Unset (bare
  // local dev) → default storage resolution applies (local libSQL file).
  storage,
  vector,
  pubsub,
  // Browser-facing origin. On the platform the SPA is hosted separately, so
  // this MUST be set to the public API origin.
  publicUrl: process.env.MASTRACODE_PUBLIC_URL,
  // Allowed cross-origin SPA origins (comma-separated). The SPA is served from
  // a separate static host, so credentialed requests must be explicitly allowed.
  allowedOrigins: (process.env.MASTRACODE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean),
  // Deployment-stable secret for OAuth `state` signing (GitHub/Linear connect
  // flows). Same resolution the state signer used before it moved into the
  // factory: webhook secret first, then the WorkOS cookie password. Unset →
  // per-process random secret (single-process local dev only).
  stateSecret: process.env.GITHUB_APP_WEBHOOK_SECRET || process.env.WORKOS_COOKIE_PASSWORD || undefined,
});

// Construct the server-owned Mastra HERE so the `new Mastra(...)` literal lives
// in the entry file (see module docs). `prepare()` returns the constructor args
// carrying the controller (via `agentControllers`), storage, and the assembled
// `server` config (middleware + apiRoutes + cors).
const prepared = await factory.prepare();
export const mastra = new Mastra({
  ...prepared,
});

// Post-construct boot: initialize the controller (which now inherits this
// instance's storage) and start its workers. Runs at module load via top-level
// await, so the deployer imports a fully-booted instance.
await factory.finalize();
