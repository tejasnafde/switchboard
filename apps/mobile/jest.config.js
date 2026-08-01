/**
 * Component tests for the mobile app.
 *
 * WHY a second runner. The root vitest suite covers `src/shared` and the app's
 * pure `lib/*` modules, but it cannot load anything that imports react-native -
 * RN ships Flow-typed source that vitest will not transform. That is precisely
 * why so much logic was extracted out of `.tsx` files, and it left everything
 * above the render boundary untested. jest-expo carries the RN transform and the
 * native-module mocks, so screens and components can actually be rendered.
 *
 * Division of labour: vitest for pure logic (fast, no RN), jest for `.tsx`.
 * Tests live in `__tests__` so vitest's `tests/unit/**` glob never picks them up.
 */
module.exports = {
  preset: 'jest-expo',
  // The app reaches src/shared through this alias in babel and tsconfig; jest
  // resolves modules itself, so it needs telling separately.
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/../../src/shared/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}'],
  // transformIgnorePatterns is deliberately NOT set. jest-expo's preset already
  // supplies the allow-list, plus two entries that stop babel transforming
  // babel's own preset (react-native-reanimated/plugin and
  // @react-native/babel-preset). Overriding it here replaced all three with one
  // hand-copied, already-stale line rather than extending it.
  clearMocks: true,
}
