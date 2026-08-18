package app.switchboard.mobile.domain.google

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GoogleCredentialImportTest {
    @Test
    fun `canonical desktop JSON trims fields and keeps an optional client secret`() {
        assertEquals(
            GoogleCredentialBundle(
                clientId = "client.apps.googleusercontent.com",
                clientSecret = "desktop-secret",
                refreshToken = "1//refresh",
            ),
            GoogleCredentialImport.parse(
                """ {"clientId":" client.apps.googleusercontent.com ","clientSecret":" desktop-secret ","refreshToken":" 1//refresh "} """,
                fallbackClient = null,
            ),
        )
    }

    @Test
    fun `bare refresh token requires an existing canonical client`() {
        assertNull(GoogleCredentialImport.parse("1//refresh", fallbackClient = null))
        assertEquals(
            GoogleCredentialBundle(
                clientId = "android.apps.googleusercontent.com",
                refreshToken = "1//refresh",
            ),
            GoogleCredentialImport.parse(
                " 1//refresh ",
                fallbackClient = GoogleClientConfig("android.apps.googleusercontent.com"),
            ),
        )
    }

    @Test
    fun `malformed or incomplete credential JSON is rejected without exposing fragments`() {
        assertNull(GoogleCredentialImport.parse("not-json", fallbackClient = null))
        assertNull(
            GoogleCredentialImport.parse(
                """{"clientId":"client","refreshToken":""}""",
                fallbackClient = null,
            ),
        )
    }
}
