package app.switchboard.mobile.platform.iap

import app.switchboard.mobile.domain.google.GoogleAccessTokenResult
import app.switchboard.mobile.platform.google.GoogleCredentialReadResult
import app.switchboard.mobile.platform.protocol.Cancelable
import java.util.concurrent.atomic.AtomicBoolean

class GoogleIapAccessTokenProvider(
    private val readCredentials: () -> GoogleCredentialReadResult,
    private val requestGoogleToken: ((GoogleAccessTokenResult) -> Unit) -> Unit,
) : IapAccessTokenProvider {
    override fun request(callback: (IapAccessTokenResult) -> Unit): Cancelable {
        val cancelled = AtomicBoolean(false)
        fun deliver(result: IapAccessTokenResult) {
            if (!cancelled.get()) callback(result)
        }

        when (readCredentials()) {
            GoogleCredentialReadResult.Absent -> deliver(IapAccessTokenResult.SignedOut)
            is GoogleCredentialReadResult.Blocked -> deliver(IapAccessTokenResult.Blocked)
            is GoogleCredentialReadResult.Available -> requestGoogleToken { result ->
                deliver(
                    when (result) {
                        is GoogleAccessTokenResult.Available -> IapAccessTokenResult.Available(result.accessToken)
                        is GoogleAccessTokenResult.RetryableFailure ->
                            IapAccessTokenResult.RetryableFailure(result.reason)
                        GoogleAccessTokenResult.SignedOut -> IapAccessTokenResult.SignedOut
                    },
                )
            }
        }
        return Cancelable { cancelled.set(true) }
    }
}
