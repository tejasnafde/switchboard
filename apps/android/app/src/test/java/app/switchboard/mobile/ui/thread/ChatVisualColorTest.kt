package app.switchboard.mobile.ui.thread

import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class ChatVisualColorTest {
    private lateinit var saved: Locale

    @Before
    fun saveLocale() {
        saved = Locale.getDefault()
    }

    @After
    fun restoreLocale() {
        Locale.setDefault(saved)
    }

    @Test
    fun formatsAsciiHexUnderAnArabicDefaultLocale() {
        Locale.setDefault(Locale.forLanguageTag("ar-EG-u-nu-arab"))
        assertEquals("#0A1B2C", visualColorHex(0xFF0A1B2C.toInt()))
        assertEquals("#000000", visualColorHex(0xFF000000.toInt()))
        assertEquals("#FFFFFF", visualColorHex(-1))
    }
}
