import { View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { agentMark, agentMarkLabel } from '@shared/agent-marks'
import { colors } from '../theme'

/**
 * The agent's own mark, in one colour, from the same path data the desktop
 * draws (`@shared/agent-marks`). It renders nothing for an agent with no
 * published mark, so a row can keep the text label it had.
 */
export function AgentMark({ agent }: { agent: string | null | undefined }) {
  const mark = agentMark(agent)
  if (!mark) return null
  return (
    <View accessibilityRole="image" accessibilityLabel={agentMarkLabel(agent)}>
      <Svg width={SIZE} height={SIZE} viewBox={mark.viewBox}>
        {mark.paths.map((d) => (
          <Path key={d} d={d} fill={colors.textDim} fillRule={mark.fillRule} />
        ))}
      </Svg>
    </View>
  )
}

const SIZE = 14
