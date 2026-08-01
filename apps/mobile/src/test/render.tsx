/**
 * Minimal render helper for component tests.
 *
 * Uses react-test-renderer directly rather than @testing-library/react-native:
 * RNTL 14 returns an empty render result under this React 19 / RN 0.86 / jest-expo
 * combination, including for a bare <View>, so the failure is the library and not
 * the setup. The platform's own renderer works, and the queries below are all
 * these tests need.
 *
 * These assert what RENDERS for a given state. Gesture and decision logic is
 * tested as pure functions in the root vitest suite, because PanResponder
 * derives its gesture state from real touch history that cannot be faked by
 * calling the handlers.
 */
import React from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'

/** react-test-renderer's node type, re-exported so tests can annotate. */
export type Node = ReactTestInstance

export interface Rendered {
  root: ReactTestInstance
  /** Every node carrying this accessibilityLabel; [] when absent. */
  allByLabel: (label: string | RegExp) => ReactTestInstance[]
  /** First node with this accessibilityLabel, or throws with what WAS found. */
  byLabel: (label: string | RegExp) => ReactTestInstance
  /** Mocked Ionicons render as testID `icon-<name>`; this lists chosen names. */
  iconNames: () => string[]
  /** Every rendered string, flattened - useful for copy assertions. */
  texts: () => string[]
  /**
   * How many host nodes of this type rendered, e.g. 'ActivityIndicator'.
   *
   * Host nodes only, identified by `typeof type === 'string'`. A composite of
   * the same name sits directly above its host in the tree, so counting both
   * would double every result.
   */
  countHostType: (name: string) => number
}

function matches(value: unknown, label: string | RegExp): boolean {
  if (typeof value !== 'string') return false
  return typeof label === 'string' ? value === label : label.test(value)
}

/**
 * Mounted trees awaiting cleanup.
 *
 * Without this a decorative Animated.loop keeps firing on real timers after its
 * test finishes, and once jest tears down the module registry the next tick
 * crashes the whole worker inside react-native's Easing. Unmounting after each
 * test stops the loop with the component that owns it.
 */
const mounted: TestRenderer.ReactTestRenderer[] = []

afterEach(() => {
  while (mounted.length > 0) {
    const renderer = mounted.pop()
    act(() => renderer?.unmount())
  }
})

export function renderComponent(element: React.ReactElement): Rendered {
  let tree: TestRenderer.ReactTestRenderer | undefined
  act(() => {
    tree = TestRenderer.create(element)
  })
  const renderer = tree as TestRenderer.ReactTestRenderer
  mounted.push(renderer)
  const root = renderer.root

  const allByLabel = (label: string | RegExp): ReactTestInstance[] =>
    root.findAll((n) => matches(n.props?.accessibilityLabel, label), { deep: false })

  return {
    root,
    allByLabel,
    byLabel: (label) => {
      const found = allByLabel(label)
      if (found.length === 0) {
        // Same `deep: false` as the query above, deliberately: a diagnostic
        // that lists labels the query could never have returned sends the
        // reader looking for a bug that is not there.
        const seen = root
          .findAll((n) => typeof n.props?.accessibilityLabel === 'string', { deep: false })
          .map((n) => String(n.props.accessibilityLabel))
        throw new Error(`no node labelled ${String(label)}; labels present: ${seen.join(' | ') || '(none)'}`)
      }
      return found[0]
    },
    iconNames: () =>
      root
        // Without `deep: false` every icon is listed twice, because the mock's
        // testID rides on both the composite and the host it renders.
        .findAll((n) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('icon-'), {
          deep: false,
        })
        .map((n) => String(n.props.testID).replace('icon-', '')),
    countHostType: (name) => root.findAll((n) => typeof n.type === 'string' && n.type === name).length,
    texts: () => {
      const out: string[] = []
      const walk = (node: ReactTestInstance): void => {
        for (const child of node.children) {
          if (typeof child === 'string') out.push(child)
          else walk(child)
        }
      }
      walk(root)
      return out
    },
  }
}
