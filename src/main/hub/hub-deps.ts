/**
 * Dependency folders of a child worktree (flag `hub_children`).
 *
 * Found: every `node_modules` next to a `package.json` in the main checkout, up
 * to 3 levels down, plus the paths under `worktree.link` in the project's
 * launch config. The setting `hub.childDependencies` picks the first try per
 * folder, and the rules can only move it down the chain link -> clone ->
 * install -> none:
 *
 *   L1 native modules: a link is fine while nobody rebuilds them; the brief
 *      says so and `own_dependencies` gives the child its own copy first.
 *   L2 an install script (`preinstall`, `install`, `postinstall`) in the
 *      folder's `package.json`: clone. `prepare` does not count: it builds the
 *      package itself or sets up git hooks, outside `node_modules`, and a clone
 *      does not run it either.
 *   L3 the base commit's `package.json` or lockfile differs from the main
 *      checkout's: install. The installed tree (`node_modules/.package-lock.json`)
 *      differs from the main checkout's lockfile (not installed since a pull):
 *      clone, so the child has the packages the main checkout runs and can
 *      install over its own copy.
 *   L4 `workspaces` or `pnpm-workspace.yaml`: clone, since links to workspace
 *      packages would point at the main checkout's sources.
 *   L5 links only on macOS and Linux; elsewhere install.
 *
 * A `worktree.link` path links (L5 only) or is left out. After every child
 * turn `checkChildDeps` compares each link, the child's lockfile and the
 * installed-tree stamp with what they were at link time.
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile, rename, rm, unlink } from 'node:fs/promises'
import { platform as osPlatform } from 'node:os'
import { realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { HubDepsMode } from '@shared/hub'
import { parseLaunchConfigFile } from '@shared/launch-config'
import { cloneDependencyDirs, cloneFolderTo, findDependencyDirs } from '../git/dependency-clone'
import { forgetDependencyLink, linkDependencyFolder, linkTarget } from '../git/dependency-links'
import { readLaunchConfig } from '../launch-config/launch-config-store'
import { childProcessEnv } from '../shell-env'
import { createMainLogger } from '../logger'

const log = createMainLogger('hub:deps')
const execFileP = promisify(execFile)

const INSTALL_TIMEOUT_MS = 15 * 60_000
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'] as const
/** Files an install writes inside `node_modules`: a changed one means someone installed through the link. */
const INSTALL_STAMPS = ['.package-lock.json', '.modules.yaml', '.yarn-state.yml', '.yarn-integrity']

/** What the planner knows about one folder. */
export interface DepsFolderFacts {
  setting: HubDepsMode
  platform: NodeJS.Platform
  /** Listed under `worktree.link`, not a `node_modules`. */
  extra: boolean
  installScript: boolean
  workspaces: boolean
  hasLockfile: boolean
  /** L3: `package.json` and the lockfile at the base commit equal the main checkout's. */
  baseMatches: boolean
  /** L3: the installed tree matches the lockfile; null when the package manager keeps no record to compare. */
  installedMatches: boolean | null
}

/** L1 to L5: the first mode to try for a folder, and why it is not `link` when it is not. */
export function depsRule(f: DepsFolderFacts): { mode: HubDepsMode; reason: string | null } {
  const canLink = f.platform === 'darwin' || f.platform === 'linux'
  if (f.extra) {
    if (f.setting === 'none') return { mode: 'none', reason: null }
    return canLink ? { mode: 'link', reason: null } : { mode: 'none', reason: 'links need macOS or Linux' }
  }
  if (f.setting === 'none' || f.setting === 'install') return { mode: f.setting, reason: null }
  if (!canLink) return { mode: 'install', reason: 'links and clones need macOS or Linux' }
  if (!f.baseMatches)
    return { mode: 'install', reason: "the base commit's package.json or lockfile differs from the main checkout" }
  if (f.setting === 'clone') return { mode: 'clone', reason: null }
  if (f.workspaces) return { mode: 'clone', reason: 'the package uses workspaces' }
  if (f.installScript) return { mode: 'clone', reason: 'the package has an install script' }
  if (!f.hasLockfile) return { mode: 'clone', reason: 'no lockfile to check the folder against' }
  if (f.installedMatches === false)
    return { mode: 'clone', reason: "the installed packages differ from the main checkout's lockfile" }
  return { mode: 'link', reason: null }
}

const WEIGHT: Record<HubDepsMode, number> = { none: 0, link: 1, clone: 2, install: 3 }

/** The heaviest mode of a child's folders, for one word on the batch card. */
export function depsSummary(modes: readonly HubDepsMode[]): HubDepsMode {
  return modes.reduce<HubDepsMode>((a, m) => (WEIGHT[m] > WEIGHT[a] ? m : a), 'none')
}

export interface DepsFolderPlan {
  /** Relative to the checkout: `node_modules`, `apps/mobile/node_modules`, or a `worktree.link` path. */
  path: string
  /** The folder holding its `package.json` and lockfile; null for a `worktree.link` path. */
  pkgDir: string | null
  mode: HubDepsMode
  reason: string | null
}

/** One folder as the child has it. Stored in `hub_children.deps_json`. */
export interface DepsFolderState extends DepsFolderPlan {
  /** Link target, for the post-turn check. */
  target?: string
  /** Hash of the install record inside the target at link time. */
  stamp?: string | null
  /** Hash of the child's own lockfile at link time. */
  lock?: string | null
}

export interface ChildDepsState {
  folders: DepsFolderState[]
}

export function parseChildDeps(json: string | null): ChildDepsState {
  if (!json) return { folders: [] }
  try {
    const parsed = JSON.parse(json) as Partial<ChildDepsState>
    return { folders: Array.isArray(parsed.folders) ? parsed.folders : [] }
  } catch (err) {
    log.warn('unreadable deps_json; treating the child as having no dependency folders', err)
    return { folders: [] }
  }
}

export const linkedFolders = (s: ChildDepsState): DepsFolderState[] => s.folders.filter((f) => f.mode === 'link')

/** The brief's lines about dependencies, or null when there is nothing to say. */
export function depsBriefLine(s: ChildDepsState): string | null {
  if (s.folders.length === 0 || s.folders.every((f) => f.mode === 'none' && !f.reason))
    return 'This worktree has no dependency folders. Install them if the task needs them.'
  const lines: string[] = []
  const linked = linkedFolders(s).map((f) => `\`${f.path}\``)
  if (linked.length > 0)
    lines.push(
      `${linked.join(', ')} here ${linked.length === 1 ? 'is' : 'are'} linked read-only to the main checkout. ` +
        'Do not install, remove or rebuild packages. If you need to, call own_dependencies first. ' +
        'Tool caches inside them (.vite, .cache) are shared with other chats.',
    )
  for (const f of s.folders)
    if (f.mode !== 'link' && f.reason)
      lines.push(`\`${f.path}\` is ${f.mode === 'none' ? 'not set up' : 'your own copy'}: ${f.reason}.`)
  return lines.length > 0 ? lines.join('\n') : null
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not read ${path}`, err)
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (err) {
    log.debug(`${path} is absent: ${(err as NodeJS.ErrnoException).code}`)
    return false
  }
}

const inPkg = (pkgDir: string, file: string) => (pkgDir ? `${pkgDir}/${file}` : file)

async function lockfileOf(root: string, pkgDir: string): Promise<(typeof LOCKFILES)[number] | null> {
  for (const name of LOCKFILES) if (await exists(join(root, inPkg(pkgDir, name)))) return name
  return null
}

/** Whether `.package-lock.json` (what npm installed) agrees with the lockfile, entry by entry. */
export function npmTreeMatches(lockText: string, installedText: string): boolean {
  type Packages = Record<string, { version?: string; optional?: boolean }>
  let lock: Packages
  let installed: Packages
  try {
    lock = (JSON.parse(lockText) as { packages?: Packages }).packages ?? {}
    installed = (JSON.parse(installedText) as { packages?: Packages }).packages ?? {}
  } catch (err) {
    log.debug('a lockfile did not parse', err)
    return false
  }
  for (const [key, entry] of Object.entries(installed)) if (lock[key]?.version !== entry.version) return false
  for (const [key, entry] of Object.entries(lock)) {
    if (!key.startsWith('node_modules/') || entry.optional) continue
    if (installed[key]?.version !== entry.version) return false
  }
  return true
}

async function gitShow(cwd: string, sha: string, path: string): Promise<string | null> {
  try {
    return (await execFileP('git', ['-C', cwd, 'show', `${sha}:./${path}`], { maxBuffer: 64 * 1024 * 1024 })).stdout
  } catch (err) {
    log.debug(`${path} is not in ${sha}`, err)
    return null
  }
}

async function folderFacts(
  main: string,
  baseSha: string,
  pkgDir: string,
  setting: HubDepsMode,
  platform: NodeJS.Platform,
): Promise<DepsFolderFacts> {
  const pkgText = await readText(join(main, inPkg(pkgDir, 'package.json')))
  let pkg: { scripts?: Record<string, unknown>; workspaces?: unknown } = {}
  try {
    pkg = pkgText ? JSON.parse(pkgText) : {}
  } catch (err) {
    log.warn(`unreadable package.json in ${pkgDir || '.'}`, err)
  }
  const lockName = await lockfileOf(main, pkgDir)
  const lockText = lockName ? await readText(join(main, inPkg(pkgDir, lockName))) : null
  const sameAtBase = async (file: string, disk: string | null) =>
    disk !== null && (await gitShow(main, baseSha, inPkg(pkgDir, file))) === disk
  const baseMatches =
    (await sameAtBase('package.json', pkgText)) && (lockName === null || (await sameAtBase(lockName, lockText)))
  let installedMatches: boolean | null = null
  if (lockName === 'package-lock.json' || lockName === 'npm-shrinkwrap.json') {
    const installed = await readText(join(main, inPkg(pkgDir, 'node_modules/.package-lock.json')))
    installedMatches = installed !== null && lockText !== null && npmTreeMatches(lockText, installed)
  }
  return {
    setting,
    platform,
    extra: false,
    installScript: ['preinstall', 'install', 'postinstall'].some((name) => Boolean(pkg.scripts?.[name])),
    workspaces: pkg.workspaces !== undefined || (await exists(join(main, inPkg(pkgDir, 'pnpm-workspace.yaml')))),
    hasLockfile: lockName !== null,
    baseMatches,
    installedMatches,
  }
}

function extraLinkPaths(main: string): string[] {
  const yaml = readLaunchConfig(main)
  if (!yaml) return []
  try {
    return parseLaunchConfigFile(yaml).worktree?.link ?? []
  } catch (err) {
    log.warn(`launch config of ${main} did not parse; no worktree.link paths`, err)
    return []
  }
}

/** What each folder of a child at `baseSha` would get. Reads files; changes nothing. */
export async function planChildDeps(
  main: string,
  baseSha: string,
  setting: HubDepsMode,
  platform: NodeJS.Platform = osPlatform(),
): Promise<DepsFolderPlan[]> {
  const plans: DepsFolderPlan[] = []
  for (const path of await findDependencyDirs(main)) {
    const pkgDir = path === 'node_modules' ? '' : path.slice(0, -'/node_modules'.length)
    const rule = depsRule(await folderFacts(main, baseSha, pkgDir, setting, platform))
    plans.push({ path, pkgDir, ...rule })
  }
  for (const path of extraLinkPaths(main)) {
    if (plans.some((p) => p.path === path) || !(await exists(join(main, path)))) continue
    const rule = depsRule({
      setting,
      platform,
      extra: true,
      installScript: false,
      workspaces: false,
      hasLockfile: false,
      baseMatches: true,
      installedMatches: null,
    })
    plans.push({ path, pkgDir: null, ...rule })
  }
  return plans
}

async function installStamp(folder: string): Promise<string | null> {
  for (const name of INSTALL_STAMPS) {
    try {
      return sha(await readFile(join(folder, name)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.debug(`could not read ${name} in ${folder}`, err)
    }
  }
  return null
}

async function lockHash(root: string, pkgDir: string | null): Promise<string | null> {
  if (pkgDir === null) return null
  const name = await lockfileOf(root, pkgDir)
  if (!name) return null
  const text = await readText(join(root, inPkg(pkgDir, name)))
  return text === null ? null : sha(text)
}

const INSTALL_COMMANDS: Record<(typeof LOCKFILES)[number], [string, string[]]> = {
  'package-lock.json': ['npm', ['ci']],
  'npm-shrinkwrap.json': ['npm', ['ci']],
  'pnpm-lock.yaml': ['pnpm', ['install', '--frozen-lockfile']],
  'yarn.lock': ['yarn', ['install', '--immutable']],
}

/** A frozen install in the child's package folder. */
async function frozenInstall(worktree: string, pkgDir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const lock = await lockfileOf(worktree, pkgDir)
  if (!lock) return { ok: false, reason: 'no lockfile for a frozen install' }
  const [cmd, args] = INSTALL_COMMANDS[lock]
  try {
    await execFileP(cmd, args, {
      cwd: join(worktree, pkgDir),
      env: childProcessEnv(),
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true }
  } catch (err) {
    const reason = `${cmd} ${args.join(' ')} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
    log.warn(`install in ${join(worktree, pkgDir)}: ${reason}`)
    return { ok: false, reason }
  }
}

/** One folder: try the planned mode, then each fallback after it. */
async function prepareFolder(main: string, worktree: string, plan: DepsFolderPlan): Promise<DepsFolderState> {
  let mode = plan.mode
  let reason = plan.reason
  if (mode === 'link') {
    const linked = await linkDependencyFolder(main, worktree, plan.path)
    if (linked.ok)
      return {
        ...plan,
        target: linked.target,
        stamp: await installStamp(linked.target),
        lock: await lockHash(worktree, plan.pkgDir),
      }
    reason = `link failed: ${linked.reason}`
    mode = plan.pkgDir === null ? 'none' : 'clone'
  }
  if (mode === 'clone') {
    if (await cloneDependencyDirs(main, worktree, { dir: plan.path, isEnabled: () => true }))
      return { ...plan, mode, reason }
    reason = 'a copy-on-write clone is not possible here'
    mode = 'install'
  }
  if (mode === 'install' && plan.pkgDir !== null) {
    const installed = await frozenInstall(worktree, plan.pkgDir)
    if (installed.ok) return { ...plan, mode, reason }
    reason = installed.reason
  }
  return { ...plan, mode: 'none', reason }
}

/** Makes every planned folder before the child's first turn. Never throws: a folder that fails ends as `none`. */
export async function prepareChildDeps(
  main: string,
  worktree: string,
  plans: readonly DepsFolderPlan[],
): Promise<ChildDepsState> {
  const folders: DepsFolderState[] = []
  for (const plan of plans) {
    try {
      folders.push(await prepareFolder(main, worktree, plan))
    } catch (err) {
      log.warn(`dependency folder ${plan.path} failed`, err)
      folders.push({ ...plan, mode: 'none', reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { folders }
}

/** What changed in a child's linked folders since link time; empty when nothing did. */
export async function checkChildDeps(worktree: string, state: ChildDepsState): Promise<string[]> {
  const problems: string[] = []
  for (const f of linkedFolders(state)) {
    if ((await linkTarget(worktree, f.path)) !== f.target) {
      problems.push(`${f.path} is no longer the link to the main checkout`)
      continue
    }
    if (f.target && (await installStamp(f.target)) !== (f.stamp ?? null))
      problems.push(`the packages in ${f.path} were installed or removed`)
    if ((await lockHash(worktree, f.pkgDir)) !== (f.lock ?? null))
      problems.push(`the lockfile next to ${f.path} changed`)
  }
  return problems
}

async function unlinkIfLink(at: string): Promise<void> {
  try {
    await unlink(at)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

async function ownFolder(
  main: string,
  worktree: string,
  f: DepsFolderState,
): Promise<{ mode: HubDepsMode; reason: string | null }> {
  const at = join(worktree, f.path)
  const staging = `${at}.sb-own-${randomBytes(4).toString('hex')}`
  let mode: HubDepsMode = 'none'
  let reason: string | null = null
  if (await cloneFolderTo(join(main, f.path), staging, worktree)) {
    try {
      await unlinkIfLink(at)
      await rename(staging, at)
    } catch (err) {
      await rm(staging, { recursive: true, force: true })
      throw err
    }
    mode = 'clone'
  } else {
    await unlinkIfLink(at)
    reason = 'a copy-on-write clone is not possible here'
  }
  await forgetDependencyLink(worktree, f.path)
  const lockDiffers = f.pkgDir !== null && (await lockHash(worktree, f.pkgDir)) !== (await lockHash(main, f.pkgDir))
  if (f.pkgDir !== null && (mode === 'none' || lockDiffers)) {
    const installed = await frozenInstall(worktree, f.pkgDir)
    if (installed.ok) mode = 'install'
    else reason = installed.reason
  }
  return { mode, reason }
}

/**
 * `own_dependencies`: replaces each linked folder with the child's own clone
 * (a frozen install when no clone is possible, or when the child's lockfile
 * differs from the main checkout's). The clone is made beside the link first,
 * so the folder is missing only between one unlink and one rename.
 */
export async function ownChildDeps(
  main: string,
  worktree: string,
  state: ChildDepsState,
): Promise<{ state: ChildDepsState; lines: string[] }> {
  const lines: string[] = []
  const folders: DepsFolderState[] = []
  for (const f of state.folders) {
    if (f.mode !== 'link') {
      folders.push(f)
      continue
    }
    const { target: _t, stamp: _s, lock: _l, ...plain } = f
    try {
      const owned = await ownFolder(main, worktree, f)
      folders.push({ ...plain, ...owned })
      lines.push(
        owned.mode === 'none'
          ? `${f.path}: unlinked, but no copy could be made (${owned.reason}). Install it yourself.`
          : `${f.path}: now your own ${owned.mode === 'clone' ? 'copy' : 'install'}.`,
      )
    } catch (err) {
      log.warn(`own_dependencies: ${f.path} in ${worktree} failed`, err)
      folders.push(f)
      lines.push(
        `${f.path}: the swap failed (${err instanceof Error ? err.message : String(err)}). Check it before you install.`,
      )
    }
  }
  return { state: { folders }, lines }
}

/** Absolute link paths of each open child, for the file-write guard. One book per process. */
const guardBook = new Map<string, string[]>()

export function trackDependencyLinks(childId: string, worktree: string, state: ChildDepsState): void {
  const roots = new Set([resolve(worktree)])
  try {
    roots.add(realpathSync.native(worktree))
  } catch (err) {
    log.debug(`could not resolve ${worktree}: ${(err as NodeJS.ErrnoException).code}`)
  }
  guardBook.set(
    childId,
    [...roots].flatMap((root) => linkedFolders(state).map((f) => resolve(root, f.path))),
  )
}

export function untrackDependencyLinks(childId: string): void {
  guardBook.delete(childId)
}

/**
 * The linked folder `absPath` is in, or null. A write there would edit the
 * main checkout's folder, which the main checkout and every other child use.
 */
export function linkedDependencyAt(absPath: string): string | null {
  const path = resolve(absPath)
  for (const links of guardBook.values())
    for (const link of links) if (path === link || path.startsWith(link + sep)) return link
  return null
}
