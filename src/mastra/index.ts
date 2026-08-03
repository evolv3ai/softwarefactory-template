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
import { defaultFactoryRules } from '@mastra/factory/rules/index';
import type {
  FactoryRuleBoard,
  FactoryRuleDecision,
  FactoryStageRuleContext,
  FactoryToolResultRuleContext,
} from '@mastra/factory/rules/index';
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

// ---------------------------------------------------------------------------
// Factory rule override (patch 5) — close the point where the built-in chain
// hands control back to a human.
//
// `MastraFactory` defaults to `builtInFactoryRules()`, whose chain ends at the
// door of Building: `submit_plan` returning "Plan approved." transitions the
// item to `execute`, and NOTHING is registered for entering that stage — no
// onEnter rule, and no execute-stage skill ships in the installed
// 0.2.2-alpha.4 (nor in the newest alpha published to npm). A plan session
// therefore transitions and ends its turn, and the item parks until somebody
// messages the session by hand. On a Railway sandbox that parking is
// destructive: the VM idles out after `MASTRACODE_SANDBOX_IDLE_MINUTES`.
//
// An override replaces an exact handler leaf and never composes with it, and
// `work.execute` is a stage the built-ins leave empty (BUILT_IN_DEFAULTS.work
// registers only `triage` and `planning`) — no default behaviour is removed.
// Effects are deferred by the dispatcher, per the bundled
// `configure-factory-rules` skill; the handler stays pure and allocation-cheap
// so it cannot approach the five-second evaluation budget.
//
// OPERATIONAL COST, accepted deliberately: a `sendMessage` decision is
// dispatched with requireDelivery, and on `idleBehavior: 'wake'` the dispatcher
// awaits `accepted.output.consumeStream()` — the WHOLE agent turn. `#tick` is
// single-flight, so while one item is building, no other rule decision and no
// pending start is dispatched anywhere in this deployment. The factory builds
// strictly one work item at a time; triage/review queue behind it.
// Do NOT "fix" this by switching to `idleBehavior: 'persist'`. That resolves to
// `{ action: 'persist' }`, which `awaitNotification(..., true)` rejects
// ("Factory notification did not reach the agent"), failing the decision
// through all 5 dispatcher attempts and delivering nothing at all. `wake` is
// the only idle behaviour that actually reaches an idle session.
//
// Deliberately NOT done here, after review:
//   * Autonomous merge. There is no trustworthy trigger for it in this rule
//     surface: `factory-review/SKILL.md` tells the reviewer to request
//     `stage: "done"` for BOTH verdicts, so entering review/done carries no
//     approval signal; the only repo identity a stage handler can see is
//     `context.item.url`, which routes/work-items.js validates as nothing more
//     than a <=2048-char string, so any org member could mint a work item
//     bearing an allowlisted URL; and `configure-factory-rules/SKILL.md`
//     forbids expressing deployment policy as instructions to an agent. If it
//     is wanted, it belongs in trusted server code gated on
//     `item.metadata.githubRepositoryId` (written by the pullRequestOpened
//     built-in from the webhook payload) with real check-conclusion and
//     mergeable-state reads.
//   * Mirroring a PR merge onto its originating issue card:
//     `configure-factory-rules` warns that Work and Review cards move
//     independently and Work must not be marked Done merely because a pull
//     request merged.
const FACTORY_RULE_VERSION = 'evolv3-autonomy-v3';

/**
 * The kickoff message. Built per item so it can name the work item and the
 * issue number the pull request has to close — the static version could not,
 * and the agent would have had to re-derive both from a phase snapshot that
 * carries neither.
 *
 * Every line here is a failure observed on the twelvepines smoke run: turns
 * that implemented and transitioned without ever committing, and a `git push`
 * that found no credentials because the GitHub token is injected per-`gh`
 * -process and never exported into the shell.
 */
function executeInstructions(context: FactoryStageRuleContext): string {
  const issueNumber = context.item.url?.match(/\/issues\/(\d+)(?:$|[/?#])/)?.[1];
  return [
    `Proceed with the approved plan for this work item: implement it AND publish the result.`,
    `Work item: ${context.item.title}${context.item.url ? ` (${context.item.url})` : ''}`,
    'You are autonomous here. Do not wait for human input, and do not end your turn with unpublished work.',
    '',
    '1. Implement the change in the session workspace. Pass an explicit cwd to every execute_command call.',
    '2. Run the repository quality gates. Report pre-existing failures you did not cause instead of fixing unrelated breakage.',
    '3. Publish. Commit early — an idle sandbox can be reclaimed, and uncommitted work goes with it:',
    '   - Commit on the branch this workspace is ALREADY checked out on. The Factory created it for you from the base',
    '     branch; do not invent a new name, and ignore general guidance about "feat/" or "fix/" prefixes — it does not',
    '     apply here. Confirm with "git rev-parse --abbrev-ref HEAD" rather than assuming.',
    '   - Plain git push has no credentials: origin is a plain https URL and the GitHub token reaches only the gh',
    '     process. Push with an askpass helper, using absolute paths because these commands run with no PATH:',
    "       printf '#!/bin/sh\\nexec /usr/bin/gh auth token\\n' > /tmp/askpass && chmod 755 /tmp/askpass",
    '       GIT_ASKPASS=/tmp/askpass git push -u origin HEAD',
    '     If the push is rejected for the branch NAME specifically, retry once on "sandbox/<same-name>"; do not spend',
    '     turns on "gh auth setup-git", which has been observed not to work here.',
    `   - Open a pull request against the repository default branch${issueNumber ? `, with "Closes #${issueNumber}" in the body` : ''}.`,
    '4. Only after the pull request exists, request the transition to the review stage.',
    '',
    'If publishing is impossible, say so plainly and leave the item in execute. Never report success without a pushed branch and an open pull request.',
  ].join('\n');
}

function beginExecution(context: FactoryStageRuleContext): FactoryRuleDecision | void {
  // Fire ONLY on the plan-approval path. On a human board drag
  // (`cause: 'board_drag'`) FactoryTransitionService unshifts its own
  // sendMessage with `role: roleForStage('work','execute')` === 'work' and
  // `prepareBinding: true`; because this handler returns a sendMessage rather
  // than an invokeSkill, that decision is not absorbed as a precedingMessage,
  // and the two differently-roled decisions would mint two sessions and two
  // Railway VMs on one work item. `submit_plan` -> advanceApprovedPlan carries
  // `cause: 'tool_result_rule'`.
  if (context.cause !== 'tool_result_rule') return;
  return {
    type: 'sendMessage',
    // Keyed on item + revision, not the inherited ingress chain: that chain
    // already runs ~200 of the 256-char idempotencyKey budget, and an overflow
    // throws inside the handler, which transition() commits as `rule_error` —
    // the item would never enter execute at all. Revision advances on every
    // transition, so this stays distinct per entry into the stage.
    idempotencyKey: `execute-kickoff:${context.item.id}:${context.itemRevision}`,
    // Reuse the planning binding rather than minting a role of its own: the
    // plan session already holds the approved plan and the materialized
    // worktree, and this is the same session a human nudge would land on.
    role: 'plan',
    message: executeInstructions(context),
    // The plan turn has ended by now, so the binding is idle by definition.
    // No `prepareBinding`: on this path the plan binding is live in-process, so
    // it would only matter after a pm2 restart with a kickoff still queued —
    // where it would silently mint a fresh, plan-less session on a new VM and
    // tell it to "proceed with the approved plan" it cannot see. Failing loudly
    // with "No active Factory binding for role plan." is the better outcome.
    idleBehavior: 'wake',
  };
}

// ---------------------------------------------------------------------------
// Transition reminder (patch 6) — catch the stage boundary an agent forgot.
//
// Every stage handoff depends on the agent remembering to call
// `factory_transition_work_item` as its terminal step. Measured on twelvepines
// 2026-08-03: TWO OF THREE triage sessions ran a full investigation, marked a
// checklist item literally named "transition work item" as completed, and
// ended the turn without ever invoking the tool (0 invocations in the thread).
// The turn ends *successfully*, so nothing retries it and the item parks with
// a finished session — the same dead end patch 5 fixed one stage later, but
// reachable at every boundary and nondeterministic.
//
// `task_check` returning all-complete is the closest thing the runtime has to
// a "the agent thinks it is done" hook, so that is where the reminder lands.
// It arrives mid-turn, while the agent can still act on it.
//
// Loop-safe by construction: the key is per (item, revision), and
// `factory_deferred_decisions` carries a unique index on the tenant+key with
// UniqueViolationError swallowed at insert — so repeated `task_check` calls in
// one revision produce exactly one reminder. A successful transition bumps the
// revision, which is what re-arms it for the next stage.
function awaitsTransition(board: FactoryRuleBoard, stages: readonly string[]): boolean {
  // `execute` is deliberately excluded: patch 5's kickoff already governs it,
  // and a reminder there could push an agent to transition before it has
  // pushed a branch and opened the pull request.
  return board === 'work' ? stages.includes('triage') || stages.includes('planning') : stages.includes('review');
}

function remindToTransition(context: FactoryToolResultRuleContext): FactoryRuleDecision | void {
  if (context.result.status !== 'success' || context.actor.type !== 'agent') return;
  if (!awaitsTransition(context.board, context.item.stages)) return;
  const value = context.result.value;
  const content =
    typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) ? value.content : undefined;
  if (typeof content !== 'string' || !content.includes('All tasks completed: YES')) return;
  return {
    type: 'sendMessage',
    idempotencyKey: `transition-reminder:${context.item.id}:${context.itemRevision}`,
    role: context.actor.role,
    message: [
      `Your task list reports every task complete, but this work item is still in "${context.item.stages.join(', ')}" on the ${context.board} board — no stage transition has been recorded.`,
      '',
      `Marking a checklist entry "completed" does not perform the transition. If this stage's work is genuinely done, call factory_transition_work_item now with expectedRevision ${context.itemRevision}; nothing else will advance the item, and a turn that ends here strands it.`,
      '',
      'If work remains, disregard this and carry on.',
    ].join('\n'),
    idleBehavior: 'wake',
  };
}

// ---------------------------------------------------------------------------
// Triage auto-advance (patch 7) — stop depending on the agent for bookkeeping.
//
// Measured on twelvepines: THREE OF FOUR triage sessions finished their
// investigation and ended the turn without calling
// `factory_transition_work_item`. Issue #9 is the clearest case — it marked
// all four substantive tasks `completed`, set a fifth task literally named
// "Request Factory stage transition" to `in_progress`, wrote its handoff, and
// stopped. Patch 6's reminder could not even arm there, because that session
// never called `task_check`; tool usage varies run to run, so no
// single-tool nudge is a reliable net.
//
// `task_update` IS called by every session (it is how the checklist moves) and
// its result carries a structured `tasks` array, so this rule reads state
// rather than parsing prose. When every substantive task is complete and the
// only thing left is the transition itself, the deployment performs the
// transition — a `transition` decision, which is the sanctioned mechanism
// (`configure-factory-rules`: "Request follow-up transitions through
// FactoryRuleDecision. Never mutate stage storage directly.").
//
// Preferred over another reminder because it removes the LLM from a step that
// carries no judgement: the investigation is already in the thread, and
// planning continues in that same thread either way.
interface AgentTask {
  id?: unknown;
  status?: unknown;
  content?: unknown;
}

function transitionish(task: AgentTask): boolean {
  const text = `${typeof task.id === 'string' ? task.id : ''} ${typeof task.content === 'string' ? task.content : ''}`;
  return /transition|hand ?off|advance stage/i.test(text);
}

function triageWorkIsDone(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length < 2) return false;
  const substantive = tasks.filter(task => !transitionish(task as AgentTask));
  // Guard against a checklist that is nothing but bookkeeping, and against
  // firing while real investigation work is still outstanding.
  if (substantive.length === 0) return false;
  return substantive.every(task => (task as AgentTask).status === 'completed');
}

function advanceFinishedTriage(context: FactoryToolResultRuleContext): FactoryRuleDecision | void {
  if (context.result.status !== 'success') return;
  if (context.actor.type !== 'agent' || context.actor.role !== 'triage') return;
  if (context.board !== 'work' || context.item.stages.length !== 1 || context.item.stages[0] !== 'triage') return;
  if (!triageWorkIsDone(context.result.value)) return;
  return {
    type: 'transition',
    idempotencyKey: `triage-autoadvance:${context.item.id}:${context.itemRevision}`,
    board: 'work',
    stage: 'planning',
    // Attached messages are delivered after the transition commits and are
    // skipped when the item has no active binding, so unlike a bare
    // `sendMessage` this cannot fail the decision on a post-restart miss.
    message: {
      text: [
        'Your triage checklist showed every investigation task complete, so the Factory advanced this work item to planning for you.',
        'The stage transition is bookkeeping the deployment now handles; you do not need to call factory_transition_work_item for it.',
        'Continue with planning in this session.',
      ].join('\n'),
      role: 'triage',
    },
  };
}

const rules = defaultFactoryRules({
  version: FACTORY_RULE_VERSION,
  overrides: {
    tools: {
      // Additive: BUILT_IN_DEFAULTS.tools registers only `submit_plan`.
      task_check: { onResult: remindToTransition },
      task_update: { onResult: advanceFinishedTriage },
    },
    work: {
      execute: {
        // `issue` only. `linearIssue` and `manual` are deliberately absent:
        // the binding path runs `factoryRuleBranch`, which throws for anything
        // that is not a GitHub issue/PR, so those leaves could only ever burn
        // 5 dispatcher attempts and go terminal. The message body is
        // GitHub-shaped for the same reason.
        issue: { onEnter: beginExecution },
      },
    },
  },
});

export const factory = new MastraFactory({
  auth,
  integrations,
  rules,
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
