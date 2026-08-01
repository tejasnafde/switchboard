/**
 * Swipe from the left edge to go back, with the screen following the finger.
 *
 * Android's own back gesture only exists on gesture navigation, so this also
 * covers three-button navigation, and it gives the same feel on both platforms.
 */
import { useMemo, useRef } from 'react'
import { Animated, PanResponder, type PanResponderInstance } from 'react-native'
import { edgeSwipeCommits, shouldClaimEdgeSwipe } from '../lib/gestures'

export function useEdgeSwipeBack(onBack: () => void): {
  panHandlers: PanResponderInstance['panHandlers']
  translateX: Animated.Value
} {
  const translateX = useRef(new Animated.Value(0)).current
  const startX = useRef(0)

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Never claim on start: that would swallow every tap in the feed.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (e, g) => {
          startX.current = e.nativeEvent.pageX - g.dx
          return shouldClaimEdgeSwipe(startX.current, g.dx, g.dy)
        },

        onPanResponderMove: (_e, g) => {
          // Rightward only, so an overshoot cannot drag the screen off-centre.
          translateX.setValue(Math.max(0, g.dx))
        },

        onPanResponderRelease: (_e, g) => {
          if (edgeSwipeCommits(g.dx, g.vx)) {
            onBack()
            // Reset behind the transition, or returning to this screen later
            // would start it mid-slide.
            translateX.setValue(0)
            return
          }
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
          }).start()
        },

        onPanResponderTerminate: () => {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start()
        },
      }),
    [onBack, translateX],
  )

  return { panHandlers: responder.panHandlers, translateX }
}
