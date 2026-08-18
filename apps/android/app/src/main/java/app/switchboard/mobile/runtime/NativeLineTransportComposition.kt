package app.switchboard.mobile.runtime

import app.switchboard.mobile.domain.google.GoogleTokenCoordinator
import app.switchboard.mobile.domain.google.GoogleTokenExchange
import app.switchboard.mobile.platform.google.GoogleNativeCredentialStore
import app.switchboard.mobile.platform.iap.GoogleIapAccessTokenProvider
import app.switchboard.mobile.platform.iap.IapRelayDialer
import app.switchboard.mobile.platform.iap.IapRelaySocketFactory
import app.switchboard.mobile.platform.protocol.LineDialer
import app.switchboard.mobile.platform.protocol.RoutingLineDialer
import app.switchboard.mobile.platform.protocol.TransportScheduler

internal fun composeNativeLineDialer(
    direct: LineDialer,
    googleCredentials: GoogleNativeCredentialStore,
    tokenExchange: GoogleTokenExchange,
    relaySocketFactory: IapRelaySocketFactory,
    scheduler: TransportScheduler,
    nowEpochMs: () -> Long,
): LineDialer {
    val googleTokens = GoogleTokenCoordinator(
        credentials = googleCredentials,
        exchange = tokenExchange,
        nowEpochMs = nowEpochMs,
    )
    val iapTokens = GoogleIapAccessTokenProvider(
        readCredentials = googleCredentials::readStatus,
        requestGoogleToken = googleTokens::requestAccessToken,
    )
    return RoutingLineDialer(
        directWebSocketDialer = direct,
        cloudIapDialer = IapRelayDialer(
            tokenProvider = iapTokens,
            relaySocketFactory = relaySocketFactory,
            scheduler = scheduler,
        ),
    )
}
