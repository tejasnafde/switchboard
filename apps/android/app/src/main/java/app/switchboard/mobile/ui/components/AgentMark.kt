package app.switchboard.mobile.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.R

/**
 * The marks of the agents a chat can run on. The drawables are generated from
 * `src/shared/agent-marks.ts` by `tests/unit/android-agent-mark-drawables.test.ts`,
 * so the three apps draw the same artwork; do not edit them by hand.
 */
object AgentMarks {
    /** The mark of an agent, or null when it has no published one. */
    fun drawableFor(agentType: String?): Int? = when (agentType) {
        "claude", "claude-code" -> R.drawable.agent_mark_claude_code
        "codex" -> R.drawable.agent_mark_codex
        "opencode" -> R.drawable.agent_mark_opencode
        "gemini" -> R.drawable.agent_mark_gemini
        "vibe" -> R.drawable.agent_mark_vibe
        "cline" -> R.drawable.agent_mark_cline
        "copilot" -> R.drawable.agent_mark_copilot
        else -> null
    }

    /** True when a row draws this agent, so it does not need to name it in text as well. */
    fun has(agentType: String?): Boolean = drawableFor(agentType) != null
}

/**
 * The agent's mark, in one colour. It draws nothing for an agent with no mark.
 * The row around it names the agent, so the mark itself carries no description.
 */
@Composable
fun AgentMark(agentType: String?, tint: Color, modifier: Modifier = Modifier) {
    val drawable = AgentMarks.drawableFor(agentType) ?: return
    Icon(
        painter = painterResource(drawable),
        contentDescription = null,
        tint = tint,
        modifier = modifier.size(14.dp),
    )
}
