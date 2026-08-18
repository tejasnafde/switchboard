package app.switchboard.mobile.platform.protocol

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl

fun legacyAuthenticatedUrl(url: String, rawToken: String): String {
    val parsed = parseWebSocketUrl(url)
    return parsed.restoreScheme(
        parsed.httpUrl
            .newBuilder()
            .removeAllQueryParameters(PAIR_QUERY_PARAMETER)
            .setQueryParameter(TOKEN_QUERY_PARAMETER, rawToken)
            .build(),
    )
}

fun withoutEmbeddedAuth(url: String): String {
    val parsed = parseWebSocketUrl(url)
    return parsed.restoreScheme(
        parsed.httpUrl
            .newBuilder()
            .removeAllQueryParameters(TOKEN_QUERY_PARAMETER)
            .removeAllQueryParameters(PAIR_QUERY_PARAMETER)
            .build(),
    )
}

private fun parseWebSocketUrl(url: String): ParsedWebSocketUrl {
    val scheme = when {
        url.startsWith("wss://", ignoreCase = true) -> WebSocketScheme.WSS
        url.startsWith("ws://", ignoreCase = true) -> WebSocketScheme.WS
        else -> throw IllegalArgumentException("Expected a ws or wss URL")
    }
    val httpUrl = when (scheme) {
        WebSocketScheme.WS -> "http://${url.substringAfter("://")}".toHttpUrl()
        WebSocketScheme.WSS -> "https://${url.substringAfter("://")}".toHttpUrl()
    }
    return ParsedWebSocketUrl(scheme, httpUrl)
}

private data class ParsedWebSocketUrl(
    val scheme: WebSocketScheme,
    val httpUrl: HttpUrl,
) {
    fun restoreScheme(url: HttpUrl): String {
        val rendered = url.toString()
        return when (scheme) {
            WebSocketScheme.WS -> "ws://${rendered.removePrefix("http://")}"
            WebSocketScheme.WSS -> "wss://${rendered.removePrefix("https://")}"
        }
    }
}

private enum class WebSocketScheme {
    WS,
    WSS,
}

private const val TOKEN_QUERY_PARAMETER = "token"
private const val PAIR_QUERY_PARAMETER = "pair"
