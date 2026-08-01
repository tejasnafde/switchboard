/**
 * Metro must see the repo root so screens can import the transport-agnostic
 * contract layer (src/shared) - the same ws-protocol/ws-transport/types the
 * desktop renderer uses. Only src/shared is imported; it has no electron or
 * react imports by design.
 */
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [path.join(repoRoot, 'src', 'shared')]
config.resolver.extraNodeModules = {
  '@shared': path.join(repoRoot, 'src', 'shared'),
}
module.exports = config
