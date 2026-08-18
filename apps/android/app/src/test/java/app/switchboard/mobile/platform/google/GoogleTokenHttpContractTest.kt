package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.domain.google.GoogleRefreshResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleTokenHttpContractTest {
    @Test
    fun `refresh request uses the exact token endpoint and optional-secret form`() {
        val withoutSecret = GoogleTokenHttpContract.request(credentials(clientSecret = null))
        val withSecret = GoogleTokenHttpContract.request(credentials(clientSecret = "desktop-secret"))

        assertEquals("https://oauth2.googleapis.com/token", withoutSecret.url)
        assertEquals(
            linkedMapOf(
                "client_id" to "client.apps.googleusercontent.com",
                "refresh_token" to "1//refresh",
                "grant_type" to "refresh_token",
            ),
            withoutSecret.fields,
        )
        assertFalse(withoutSecret.fields.containsKey("client_secret"))
        assertEquals("desktop-secret", withSecret.fields["client_secret"])
        assertFalse(credentials("desktop-secret").toString().contains("desktop-secret"))
        assertFalse(credentials("desktop-secret").toString().contains("1//refresh"))
        assertFalse(withSecret.toString().contains("desktop-secret"))
        assertFalse(withSecret.toString().contains("1//refresh"))
        assertFalse(
            app.switchboard.mobile.domain.google.GoogleClientConfig("client", "desktop-secret")
                .toString()
                .contains("desktop-secret"),
        )
    }

    @Test
    fun `successful body maps expiry and signed-in email`() {
        val idToken = jwtPayload("{\"email\":\"person@example.com\"}")

        val decoded = GoogleTokenHttpContract.decode(
            statusCode = 200,
            body = """{"access_token":"raw-access-secret","expires_in":3600,"id_token":"$idToken"}""",
            nowEpochMs = 1_000L,
        )

        assertEquals(
            GoogleRefreshResult.Success("raw-access-secret", 3_601_000L, "person@example.com"),
            decoded,
        )
        assertFalse(decoded.toString().contains("raw-access-secret"))
    }

    @Test
    fun `domain error wins even inside an HTTP response body`() {
        val decoded = GoogleTokenHttpContract.decode(
            statusCode = 400,
            body = """{"error":"invalid_grant","error_description":"Token revoked"}""",
            nowEpochMs = 1_000L,
        )

        assertEquals(GoogleRefreshResult.Failure("invalid_grant", "Token revoked"), decoded)
    }

    @Test
    fun `malformed success and bare HTTP failure remain typed and non-secret`() {
        assertEquals(
            GoogleRefreshResult.Failure("invalid_response"),
            GoogleTokenHttpContract.decode(200, "{}", 0),
        )
        assertEquals(
            GoogleRefreshResult.Failure("http_503"),
            GoogleTokenHttpContract.decode(503, "not json", 0),
        )
        assertNull(GoogleTokenHttpContract.emailFromIdToken("not-a-token"))
    }

    private fun credentials(clientSecret: String?) = GoogleCredentialBundle(
        clientId = "client.apps.googleusercontent.com",
        clientSecret = clientSecret,
        refreshToken = "1//refresh",
    )

    private fun jwtPayload(json: String): String {
        val payload = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(json.toByteArray())
        assertTrue(payload.isNotBlank())
        return "header.$payload.signature"
    }
}
