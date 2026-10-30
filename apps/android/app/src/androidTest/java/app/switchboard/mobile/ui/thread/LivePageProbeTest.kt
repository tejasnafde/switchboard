package app.switchboard.mobile.ui.thread

import android.app.Instrumentation
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.switchboard.mobile.domain.thread.HtmlLivePhone
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs a probe page in the real live WebView on a device. The page tries
 * every way out it can and prints `PROBE <name> BLOCKED|LEAK|SENT` on the
 * console. A listener on the device's loopback counts any connection that
 * arrives: this is the proof for WebSocket, beacons, CSS loads and
 * navigation, which the page cannot observe. Any LEAK line, any connection,
 * any started activity or a page that never finishes fails the test.
 */
@RunWith(AndroidJUnit4::class)
class LivePageProbeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var server: ServerSocket
    private val connections = Collections.synchronizedList(mutableListOf<String>())
    private val lines = Collections.synchronizedList(mutableListOf<String>())
    private val stops = Collections.synchronizedList(mutableListOf<LiveStop>())
    private val done = CountDownLatch(1)
    private lateinit var activities: Instrumentation.ActivityMonitor

    @Before
    fun listen() {
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                try {
                    server.accept().use { socket ->
                        socket.soTimeout = 1_000
                        val first = runCatching { socket.getInputStream().bufferedReader().readLine() }.getOrNull()
                        connections += first ?: "(no request line)"
                    }
                } catch (e: SocketException) {
                    // The server closed at the end of the test.
                    break
                }
            }
        }.apply { isDaemon = true }.start()
        // Matches every activity start and blocks it: an intent: or market: link must start none.
        activities = instrumentation.addMonitor(null as android.content.IntentFilter?, null, true)
    }

    @After
    fun close() {
        server.close()
        instrumentation.removeMonitor(activities)
    }

    @Test
    fun noRequestLeavesTheLivePage() {
        val listener = object : LivePageListener {
            override fun onReport(report: HtmlLivePhone.Report) {
                if (report !is HtmlLivePhone.Report.Error) return
                lines += report.text
                if (report.text == "PROBE done") done.countDown()
            }

            override fun onStop(reason: LiveStop) {
                stops += reason
            }
        }
        var view: WebView? = null
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                view = liveWebView(activity, newLiveToken(), probePage(server.localPort), listener)
                activity.setContentView(view)
            }
            val finished = done.await(60, TimeUnit.SECONDS)
            // Late loads (a beacon, a refresh) get a moment to reach the listener.
            Thread.sleep(2_000)
            scenario.onActivity { view?.destroy() }
            val report = "lines=$lines connections=$connections stops=$stops"
            assertTrue("the probe page never finished: $report", finished)
            assertEquals("leaks: $report", emptyList<String>(), lines.filter { it.endsWith(" LEAK") })
            assertEquals("connections to the device listener: $report", emptyList<String>(), connections.toList())
            assertEquals("activities started: $report", 0, activities.hits)
            assertEquals("the page stopped: $report", emptyList<LiveStop>(), stops.toList())
            for (name in EXPECTED) {
                assertTrue("$name did not report: $report", lines.any { it.startsWith("PROBE $name ") })
            }
        }
    }

    private companion object {
        val EXPECTED = listOf(
            "fetch-internet", "fetch-emulator-host", "fetch-loopback", "xhr", "websocket", "websocket-internet",
            "eventsource", "beacon", "img", "css-url", "css-import", "font-face", "fetch-file", "fetch-content",
            "rtc", "webkit-rtc", "bridge", "window-open", "location", "intent", "market", "meta-refresh", "form-post",
        )

        /** The probe. Loopback URLs carry the item name, so a connection names what leaked. */
        fun probePage(port: Int) = """
<p id="out">probe</p>
<script>
const L = 'http://127.0.0.1:$port'
const say = (name, state) => console.error('PROBE ' + name + ' ' + state)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = (name, start) => new Promise((resolve) => {
  let over = false
  const end = (state) => { if (!over) { over = true; say(name, state); resolve() } }
  setTimeout(() => end('BLOCKED'), 3000)
  try { start(() => end('LEAK'), () => end('BLOCKED')) } catch (e) { end('BLOCKED') }
})
const viaFetch = (name, url) => settle(name, (leak, blocked) => fetch(url, { mode: 'no-cors' }).then(leak, blocked))
const viaXhr = (name, url) => settle(name, (leak, blocked) => {
  const x = new XMLHttpRequest(); x.open('GET', url); x.onload = leak; x.onerror = blocked; x.send()
})
const viaSocket = (name, url) => settle(name, (leak, blocked) => {
  const s = new WebSocket(url); s.onopen = leak; s.onerror = blocked
})
const viaEvents = (name, url) => settle(name, (leak, blocked) => {
  const s = new EventSource(url); s.onopen = leak; s.onerror = () => { s.close(); blocked() }
})
const viaImage = (name, url) => settle(name, (leak, blocked) => {
  const i = new Image(); i.onload = leak; i.onerror = blocked; i.src = url
})
const viaStyle = (name, css) => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); say(name, 'SENT') }
const constructs = (name, make) => { try { make(); say(name, 'LEAK') } catch (e) { say(name, 'BLOCKED') } }
;(async () => {
  await viaFetch('fetch-internet', 'https://example.com/')
  await viaFetch('fetch-emulator-host', 'http://10.0.2.2/')
  await viaFetch('fetch-loopback', L + '/fetch')
  await viaXhr('xhr', L + '/xhr')
  await viaSocket('websocket', 'ws://127.0.0.1:$port/ws')
  await viaSocket('websocket-internet', 'wss://example.com/')
  await viaEvents('eventsource', L + '/eventsource')
  try { navigator.sendBeacon(L + '/beacon', 'x') } catch (e) {}
  say('beacon', 'SENT')
  await viaImage('img', L + '/img.png')
  viaStyle('css-url', 'body{background:url(' + L + '/css-url.png)}')
  viaStyle('css-import', '@import url(' + L + '/import.css);')
  viaStyle('font-face', '@font-face{font-family:p;src:url(' + L + '/font.woff2)} #out{font-family:p}')
  await viaFetch('fetch-file', 'file:///proc/self/status')
  await viaFetch('fetch-content', 'content://settings/system')
  constructs('rtc', () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:$port' }] }))
  constructs('webkit-rtc', () => new webkitRTCPeerConnection({ iceServers: [] }))
  say('bridge', typeof window.ReactNativeWebView === 'undefined' && typeof window.Android === 'undefined' ? 'BLOCKED' : 'LEAK')
  // Accepted rest risk (T3): recorded, never a failure.
  try {
    const f = document.createElement('iframe'); document.body.appendChild(f)
    new f.contentWindow.RTCPeerConnection({ iceServers: [] }); say('rtc-iframe', 'OPEN')
  } catch (e) { say('rtc-iframe', 'CLOSED') }
  try { window.open(L + '/window-open') } catch (e) {}
  say('window-open', 'SENT')
  try { location.href = L + '/location' } catch (e) {}
  say('location', 'SENT')
  try { location.href = 'intent://scan/#Intent;scheme=zxing;end' } catch (e) {}
  say('intent', 'SENT')
  try { location.href = 'market://details?id=app.switchboard' } catch (e) {}
  say('market', 'SENT')
  const meta = document.createElement('meta'); meta.httpEquiv = 'refresh'; meta.content = '0;url=' + L + '/meta-refresh'
  document.head.appendChild(meta)
  say('meta-refresh', 'SENT')
  const form = document.createElement('form'); form.method = 'post'; form.action = L + '/form'
  document.body.appendChild(form)
  try { form.submit() } catch (e) {}
  say('form-post', 'SENT')
  // Still here after every navigation: none of them left the page.
  await wait(2000)
  console.error('PROBE done')
})()
</script>
"""
    }
}
