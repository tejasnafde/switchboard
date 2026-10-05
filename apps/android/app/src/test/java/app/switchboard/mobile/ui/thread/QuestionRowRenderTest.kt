package app.switchboard.mobile.ui.thread

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.QuestionOption
import app.switchboard.mobile.domain.thread.ThreadQuestion
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the real question card at phone widths with Robolectric's native
 * graphics, so the layout is measured by the same text engine a phone uses.
 * PNGs land in build/question-shots/ for a person to look at; the asserts
 * hold the one rule that broke: an option label keeps most of the card width.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class QuestionRowRenderTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val longDescription =
        "Rewrites the whole module around a new interface, migrates every caller in the same change, " +
            "and deletes the old entry points once nothing imports them any more."

    private fun question(id: String, multiSelect: Boolean, vararg options: Pair<String, String?>) = ThreadQuestion(
        id = id,
        header = "Approach",
        question = "How should the agent handle the refactor of the provider registry?",
        options = options.map { (label, description) -> QuestionOption(label, description) },
        multiSelect = multiSelect,
    )

    private val cases = listOf(
        "short-label" to FeedItem.Question(
            "q1", "r1",
            listOf(question("a", false, "Yes" to longDescription, "No" to longDescription)),
        ),
        "long-label" to FeedItem.Question(
            "q1", "r1",
            listOf(
                question(
                    "a", false,
                    "Rewrite the registry around a single adapter interface" to longDescription,
                    "Keep the registry and patch the two failing call sites" to longDescription,
                ),
            ),
        ),
        "four-options" to FeedItem.Question(
            "q1", "r1",
            listOf(
                question(
                    "a", false,
                    "Small patch" to "Touch only the failing call site.",
                    "Medium" to longDescription,
                    "Full rewrite of the module" to longDescription,
                    "Skip for now" to null,
                ),
            ),
        ),
        "multi-select" to FeedItem.Question(
            "q1", "r1",
            listOf(
                question(
                    "a", true,
                    "Unit tests" to longDescription,
                    "Integration tests against the real backend" to longDescription,
                    "Docs" to "Update AGENTS.md.",
                ),
            ),
        ),
        "two-questions" to FeedItem.Question(
            "q1", "r1",
            listOf(
                question("a", false, "Yes" to longDescription, "No" to "Leave it."),
                question("b", true, "Android" to longDescription, "iOS" to longDescription),
            ),
        ),
        "answered-typed" to FeedItem.Question(
            "q1", "r1",
            listOf(question("a", false, "Yes" to longDescription, "No" to "Leave it.")),
            answers = listOf(listOf("Neither, ask me again after the release")),
        ),
    )

    @Test
    fun everyCaseKeepsOptionLabelsReadableAtPhoneWidths() {
        var case by mutableStateOf(cases.first().second)
        var widthDp by mutableStateOf(411)
        var fontScale by mutableStateOf(1f)
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                SwitchboardTheme {
                    Box(Modifier.width(widthDp.dp).testTag("card")) {
                        QuestionRow(case, QuestionSelections.empty(), {}, submitting = false, onAction = {})
                    }
                }
            }
        }
        val out = File("build/question-shots").apply { mkdirs() }
        for ((name, item) in cases) for (width in listOf(360, 411)) for (scale in listOf(1f, 1.3f)) {
            case = item
            widthDp = width
            fontScale = scale
            compose.waitForIdle()
            item.questions.forEachIndexed { q, question ->
                question.options.indices.forEach { o ->
                    val layouts = mutableListOf<TextLayoutResult>()
                    compose.onNodeWithTag(ThreadTestTags.questionOptionLabel(item.requestId, q, o), useUnmergedTree = true)
                        .fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
                    val text = layouts.single().layoutInput.text
                    val perLine = text.length / layouts.single().lineCount
                    // The screenshot bug: one character per line beside a long description.
                    assertTrue("$name ${width}dp x$scale option $o: $perLine chars per line", perLine >= minOf(12, text.length))
                }
            }
            File(out, "$name-${width}dp-x$scale.png").outputStream().use {
                snapshot().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }

    // captureToImage() times out on its second call under Robolectric,
    // so draw the content view and crop to the card.
    private fun snapshot(): Bitmap {
        val view = compose.activity.findViewById<ViewGroup>(android.R.id.content)
        val full = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(full))
        val bounds = compose.onNodeWithTag("card").fetchSemanticsNode().boundsInRoot
        return Bitmap.createBitmap(full, 0, 0, bounds.width.toInt(), bounds.height.toInt())
    }

    @Test
    fun tappingOptionsBuildsTheAnswerTheDesktopSends() {
        val item = cases.first { it.first == "two-questions" }.second
        var selections by mutableStateOf(QuestionSelections.empty())
        val actions = mutableListOf<ThreadUiAction>()
        compose.setContent {
            SwitchboardTheme {
                QuestionRow(item, selections, { selections = it }, submitting = false, onAction = { actions += it })
            }
        }
        val submit = compose.onNodeWithText("Submit answers")
        submit.assertIsNotEnabled()
        compose.onNodeWithTag(ThreadTestTags.questionOption("r1", 0, 0)).performClick()
        compose.onNodeWithTag(ThreadTestTags.questionOption("r1", 0, 1)).performClick()
        submit.assertIsNotEnabled()
        compose.onNodeWithTag(ThreadTestTags.questionOption("r1", 1, 1)).performClick()
        compose.onNodeWithTag(ThreadTestTags.questionOption("r1", 1, 0)).performClick()
        submit.assertIsEnabled()
        // Typed text replaces the first question's pick, as on the desktop.
        compose.onNodeWithTag(ThreadTestTags.questionOther("r1", 0)).performTextInput("Neither, ask me later")
        compose.onNodeWithTag(ThreadTestTags.questionOption("r1", 0, 1)).assertIsNotSelected()
        submit.performClick()
        // Multi select keeps click order, as QuestionCard.tsx does.
        assertEquals(
            listOf(ThreadUiAction.AnswerQuestion("r1", listOf(listOf("Neither, ask me later"), listOf("iOS", "Android")))),
            actions,
        )
    }
}
