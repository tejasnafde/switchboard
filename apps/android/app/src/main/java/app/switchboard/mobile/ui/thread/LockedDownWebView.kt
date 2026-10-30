package app.switchboard.mobile.ui.thread

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi

private const val TAG = "LockedDownWebView"

/**
 * Refuses every navigation and survives the loss of the renderer. All app
 * WebViews share one renderer process, and the system kills it under memory
 * pressure; a client that does not handle that ends the whole app. [onGone]
 * runs once the renderer is gone: the caller must drop and destroy the view.
 */
internal open class LockedDownWebViewClient(private val onGone: () -> Unit) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

    // The system calls this only on API 26 and later.
    @RequiresApi(Build.VERSION_CODES.O)
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        Log.w(TAG, "web renderer gone, crashed=${detail.didCrash()}")
        onGone()
        return true
    }
}

/**
 * A WebView with JavaScript on but no file, content or network access, no
 * storage or cache, no new windows, no location, no autoplay, no Safe
 * Browsing and no JavaScript interface.
 */
@SuppressLint("SetJavaScriptEnabled")
internal fun lockedDownWebView(context: Context, client: LockedDownWebViewClient): WebView =
    WebView(context).apply {
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // Their defaults were true before API 30.
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            blockNetworkLoads = true
            domStorageEnabled = false
            @Suppress("DEPRECATION")
            databaseEnabled = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
            // Safe Browsing sends URL hashes out; these pages have no network URL to check.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = false
        }
        webViewClient = client
    }
