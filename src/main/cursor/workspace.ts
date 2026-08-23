import { existsSync, readFileSync } from 'fs'
import { dirname, join, posix, win32 } from 'path'
import { fileURLToPath } from 'url'
import { createMainLogger } from '../logger'

const log = createMainLogger('cursor:workspace')

interface CursorWorkspaceMetadata {
  folder?: unknown
  workspace?: unknown
}

interface CodeWorkspaceFolder {
  path?: unknown
  uri?: unknown
}

interface CodeWorkspace {
  folders?: unknown
}

export function decodeCursorFileUri(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    return fileURLToPath(url)
  } catch (error) {
    log.warn('could not decode Cursor file URI', {
      error: error instanceof Error ? error.name : typeof error,
    })
    return null
  }
}

export function cursorPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return win32.resolve(left).toLocaleLowerCase('en-US')
      === win32.resolve(right).toLocaleLowerCase('en-US')
  }
  return posix.resolve(left) === posix.resolve(right)
}

function stripJsonComments(input: string): string {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]
    const next = input[index + 1]

    if (lineComment) {
      if (current === '\n' || current === '\r') {
        lineComment = false
        output += current
      }
      continue
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false
        index += 1
      } else if (current === '\n' || current === '\r') {
        output += current
      }
      continue
    }
    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
      continue
    }
    if (current === '"') {
      inString = true
      output += current
    } else if (current === '/' && next === '/') {
      lineComment = true
      index += 1
    } else if (current === '/' && next === '*') {
      blockComment = true
      index += 1
    } else {
      output += current
    }
  }
  return output
}

function readJson(path: string, comments = false): unknown {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(comments ? stripJsonComments(raw) : raw)
  } catch (error) {
    log.warn('could not read Cursor workspace metadata', {
      path,
      error: error instanceof Error ? error.name : typeof error,
    })
    return null
  }
}

function workspaceFileMatchesProject(workspacePath: string, projectPath: string): boolean {
  const parsed = readJson(workspacePath, true) as CodeWorkspace | null
  if (!parsed || !Array.isArray(parsed.folders)) return false
  const workspaceDir = dirname(workspacePath)
  return parsed.folders.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const folder = entry as CodeWorkspaceFolder
    if (typeof folder.path === 'string') {
      const resolver = process.platform === 'win32' ? win32.resolve : posix.resolve
      return cursorPathsEqual(resolver(workspaceDir, folder.path), projectPath)
    }
    if (typeof folder.uri === 'string') {
      const decoded = decodeCursorFileUri(folder.uri)
      return decoded !== null && cursorPathsEqual(decoded, projectPath)
    }
    return false
  })
}

export function workspaceStorageMatchesProject(storageDir: string, projectPath: string): boolean {
  const metadata = readJson(join(storageDir, 'workspace.json')) as CursorWorkspaceMetadata | null
  if (!metadata) return false

  if (typeof metadata.folder === 'string') {
    const folderPath = decodeCursorFileUri(metadata.folder)
    return folderPath !== null && cursorPathsEqual(folderPath, projectPath)
  }

  if (typeof metadata.workspace === 'string') {
    const workspacePath = decodeCursorFileUri(metadata.workspace)
    return workspacePath !== null && workspaceFileMatchesProject(workspacePath, projectPath)
  }

  return false
}
