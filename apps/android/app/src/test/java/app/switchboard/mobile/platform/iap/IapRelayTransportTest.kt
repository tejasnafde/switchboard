package app.switchboard.mobile.platform.iap

import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.AuthenticatedWsCoordinator
import app.switchboard.mobile.platform.protocol.LineCallbacks
import app.switchboard.mobile.platform.protocol.LineConnection
import app.switchboard.mobile.platform.protocol.LineEndpoint
import app.switchboard.mobile.platform.protocol.LineTarget
import app.switchboard.mobile.platform.protocol.TransportScheduler
import app.switchboard.mobile.platform.protocol.ProtocolObserver
import app.switchboard.mobile.platform.protocol.ResumeCursorStore
import app.switchboard.mobile.platform.protocol.SessionCredentialStore
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.ConnectionPhase
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.protocol.ResumeCursor
import app.switchboard.mobile.protocol.RuntimeEventPayload
import app.switchboard.mobile.protocol.WsFrame
import app.switchboard.mobile.protocol.WsProtocol
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IapRelayTransportTest {
    @Test
    fun `request preserves the exact Cloud IAP relay contract without leaking the bearer token`() {
        val request = IapRelayRequestPolicy.build(
            IapTarget("project id", "asia-south1-b", "work-vm", 8766, "nic1"),
            "google-secret",
        )

        assertEquals(
            "wss://tunnel.cloudproxy.app/v4/connect" +
                "?project=project%20id&port=8766&newWebsocket=True" +
                "&zone=asia-south1-b&instance=work-vm&interface=nic1",
            request.url,
        )
        assertEquals("Bearer google-secret", request.header("Authorization"))
        assertEquals("bot:iap-tunneler", request.header("Origin"))
        assertEquals("switchboard-mobile", request.header("User-Agent"))
        assertEquals("relay.tunnel.cloudproxy.app", request.header("Sec-WebSocket-Protocol"))
        assertFalse(request.toString().contains("google-secret"))
    }

    @Test
    fun `connect success authenticates TCP first flushes FIFO and only then exposes line open`() {
        val fixture = Fixture(maxQueuedLines = 3, maxQueuedUtf8Bytes = 64)
        val connection = fixture.open()

        assertTrue(connection.send("queued-one"))
        assertTrue(connection.send("queued-two"))
        fixture.tokens.succeed("google-token")
        fixture.relay.openLatest()

        assertTrue(fixture.callbacks.events.isEmpty())
        fixture.relay.binaryLatest(connectSuccess("session-7"))

        assertEquals(listOf("open"), fixture.callbacks.events)
        assertEquals(
            listOf(
                "{\"k\":\"auth\",\"token\":\"backend-secret\"}\n",
                "queued-one\n",
                "queued-two\n",
            ),
            fixture.relay.latestDataPayloads().map { it.toString(StandardCharsets.UTF_8) },
        )
    }

    @Test
    fun `pre-ready queue overflow is a typed terminal failure and clears queued work`() {
        val fixture = Fixture(maxQueuedLines = 1)
        val connection = fixture.open()

        assertTrue(connection.send("queued"))
        assertFalse(connection.send("overflow"))
        fixture.tokens.succeedEvenIfCancelled("late-token")

        assertEquals(listOf("failure:IAP relay pre-ready queue is full"), fixture.callbacks.events)
        assertTrue(fixture.tokens.cancelled)
        assertTrue(fixture.relay.opens.isEmpty())
    }

    @Test
    fun `outbound lines use 16 KiB relay chunks and inbound split UTF8 NDJSON ACKs every 32 KiB`() {
        val fixture = Fixture()
        val connection = fixture.ready()
        fixture.relay.clearSent()

        assertTrue(connection.send("x".repeat(16_384)))
        assertEquals(listOf(16_384, 1), fixture.relay.latestDataPayloads().map(ByteArray::size))

        val line = "{\"text\":\"hi 👋\"}\n"
        val encoded = line.toByteArray(StandardCharsets.UTF_8)
        val split = encoded.indexOfFirst { it.toInt() < 0 } + 2
        fixture.relay.binaryLatest(IapRelayCodec.encodeData(encoded.copyOfRange(0, split)))
        fixture.relay.binaryLatest(IapRelayCodec.encodeData(encoded.copyOfRange(split, encoded.size)))
        assertEquals(listOf("{\"text\":\"hi 👋\"}"), fixture.callbacks.lines)

        fixture.relay.binaryLatest(IapRelayCodec.encodeData(ByteArray(16_384)))
        fixture.relay.binaryLatest(IapRelayCodec.encodeData(ByteArray(16_384)))
        assertEquals(listOf(32_787L), fixture.relay.latestAcknowledgements())
    }

    @Test
    fun `timeout clears queued work closes relay and fences late callbacks`() {
        val fixture = Fixture()
        val connection = fixture.open()
        assertTrue(connection.send("must-drop"))
        fixture.tokens.succeed("google-token")
        val relay = fixture.relay.latest()

        fixture.scheduler.runNext()

        assertTrue(relay.closed)
        assertEquals(listOf("failure:IAP relay connect timed out"), fixture.callbacks.events)
        fixture.relay.openLatest()
        fixture.relay.binaryLatest(connectSuccess("late"))
        assertEquals(listOf("failure:IAP relay connect timed out"), fixture.callbacks.events)
        assertTrue(fixture.relay.latestDataPayloads().isEmpty())
    }

    @Test
    fun `closing before token completion cancels acquisition and ignores stale completion`() {
        val fixture = Fixture()
        val connection = fixture.open()

        connection.close()
        fixture.tokens.succeedEvenIfCancelled("stale-token")

        assertTrue(fixture.tokens.cancelled)
        assertEquals(0, fixture.relay.opens.size)
        assertTrue(fixture.callbacks.events.isEmpty())
    }

    @Test
    fun `malformed relay or UTF8 fails once and drops all later socket events`() {
        val fixture = Fixture()
        fixture.ready()
        val relay = fixture.relay.latest()

        fixture.relay.binaryLatest(IapRelayCodec.encodeData(byteArrayOf(0xc3.toByte(), 0x28)))
        fixture.relay.failureLatest(IllegalStateException("later"))

        assertTrue(relay.closed)
        assertEquals(1, fixture.callbacks.events.count { it.startsWith("failure:") })
        assertTrue(fixture.callbacks.events.last().contains("invalid UTF-8 stream"))
    }

    @Test
    fun `relay close validates terminal NDJSON instead of silently dropping a partial line`() {
        val fixture = Fixture()
        fixture.ready()
        fixture.relay.binaryLatest(IapRelayCodec.encodeData("partial".toByteArray()))

        fixture.relay.closeLatest()

        assertEquals(listOf("open", "failure:unterminated NDJSON line"), fixture.callbacks.events)
    }

    @Test
    fun `relay readiness opens existing coordinator but backend ready still gates application sends`() {
        val tokens = FakeTokenProvider()
        val relay = FakeRelaySocketFactory()
        val scheduler = FakeScheduler()
        val dialer = IapRelayDialer(tokens, relay, scheduler)
        val coordinator = AuthenticatedWsCoordinator(
            dialer = dialer,
            scheduler = scheduler,
            cursorStore = object : ResumeCursorStore {
                override fun load(connectionId: String): ResumeCursor? = null
                override fun save(connectionId: String, cursor: ResumeCursor) = Unit
            },
            credentialStore = object : SessionCredentialStore {
                override fun saveAndVerifySession(
                    connectionId: String,
                    expectedOldRef: String?,
                    session: String,
                ) = true

                override fun retireLegacyCredentials(connectionId: String) = Unit
            },
            observer = object : ProtocolObserver {
                override fun onRuntimeEvent(connectionId: String, event: RuntimeEventPayload) = Unit
                override fun onReplayGap(connectionId: String, previous: ResumeCursor?, current: ResumeCursor) = Unit
                override fun onProtocolError(connectionId: String, wire: String) = Unit
            },
        )

        coordinator.connect(iapLineTarget())
        tokens.succeed("google-token")
        relay.openLatest()
        assertFalse(coordinator.isApplicationSendAllowed)
        assertTrue(relay.latestDataPayloads().isEmpty())

        relay.binaryLatest(connectSuccess("session"))
        assertFalse(coordinator.isApplicationSendAllowed)
        assertEquals(
            listOf("auth", "hello"),
            relay.latestDataPayloads().map { payload ->
                WsProtocol.decode(payload.toString(StandardCharsets.UTF_8).trim())?.let {
                    when (it) {
                        is WsFrame.Hello -> "hello"
                        else -> "protocol"
                    }
                } ?: "auth"
            },
        )

        val ready = WsProtocol.encode(WsFrame.Ready("epoch", 4, 0, false)) + "\n"
        relay.binaryLatest(IapRelayCodec.encodeData(ready.toByteArray(StandardCharsets.UTF_8)))
        assertEquals(ConnectionPhase.Ready, coordinator.phase)
        assertTrue(coordinator.isApplicationSendAllowed)
    }

    private class Fixture(
        maxQueuedLines: Int = 8,
        maxQueuedUtf8Bytes: Int = 64 * 1024,
    ) {
        val tokens = FakeTokenProvider()
        val relay = FakeRelaySocketFactory()
        val scheduler = FakeScheduler()
        val callbacks = RecordingCallbacks()
        private val dialer = IapRelayDialer(
            tokenProvider = tokens,
            relaySocketFactory = relay,
            scheduler = scheduler,
            connectTimeoutMs = 5_000,
            maxQueuedLines = maxQueuedLines,
            maxQueuedUtf8Bytes = maxQueuedUtf8Bytes,
        )

        fun open(): LineConnection = dialer.open(
            LineTarget(
                deviceId = "device-1",
                connectionId = "connection-1",
                endpoint = LineEndpoint.CloudIap(
                    IapTarget("project", "zone", "instance", 8766),
                ),
                credential = Credential.LegacySharedToken("backend-secret"),
            ),
            callbacks,
        )

        fun ready(): LineConnection = open().also {
            tokens.succeed("google-token")
            relay.openLatest()
            relay.binaryLatest(connectSuccess("session"))
        }
    }

    private fun iapLineTarget() = LineTarget(
        deviceId = "device-1",
        connectionId = "connection-1",
        endpoint = LineEndpoint.CloudIap(IapTarget("project", "zone", "instance", 8766)),
        credential = Credential.LegacySharedToken("backend-secret"),
    )

    private class FakeTokenProvider : IapAccessTokenProvider {
        private var callback: ((IapAccessTokenResult) -> Unit)? = null
        var cancelled = false

        override fun request(callback: (IapAccessTokenResult) -> Unit): Cancelable {
            this.callback = callback
            return Cancelable { cancelled = true }
        }

        fun succeed(token: String) {
            if (!cancelled) callback?.invoke(IapAccessTokenResult.Available(token))
        }

        fun succeedEvenIfCancelled(token: String) {
            callback?.invoke(IapAccessTokenResult.Available(token))
        }
    }

    private class FakeRelaySocketFactory : IapRelaySocketFactory {
        data class Open(
            val request: IapRelayRequest,
            val callbacks: IapRelaySocketCallbacks,
            val socket: FakeRelaySocket = FakeRelaySocket(),
        )

        val opens = mutableListOf<Open>()

        override fun open(
            request: IapRelayRequest,
            callbacks: IapRelaySocketCallbacks,
        ): IapRelaySocket = Open(request, callbacks).also(opens::add).socket

        fun latest(): FakeRelaySocket = opens.last().socket
        fun openLatest() = opens.last().callbacks.onOpen(opens.last().socket)
        fun binaryLatest(bytes: ByteArray) = opens.last().callbacks.onBinary(opens.last().socket, bytes)
        fun failureLatest(error: Throwable) = opens.last().callbacks.onFailure(opens.last().socket, error)
        fun closeLatest() = opens.last().callbacks.onClosed(opens.last().socket, DisconnectCause.Server)
        fun clearSent() = latest().sent.clear()

        fun latestDataPayloads(): List<ByteArray> = latest().sent.mapNotNull(::dataPayload)

        fun latestAcknowledgements(): List<Long> = latest().sent.mapNotNull(::acknowledgement)

        private fun dataPayload(frame: ByteArray): ByteArray? {
            if (frame.size < 6) return null
            val buffer = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN)
            if ((buffer.short.toInt() and 0xffff) != 4) return null
            val length = buffer.int
            return ByteArray(length).also(buffer::get)
        }

        private fun acknowledgement(frame: ByteArray): Long? {
            if (frame.size != 10) return null
            val buffer = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN)
            if ((buffer.short.toInt() and 0xffff) != 7) return null
            return buffer.long
        }
    }

    private class FakeRelaySocket : IapRelaySocket {
        val sent = mutableListOf<ByteArray>()
        var closed = false

        override fun send(bytes: ByteArray): Boolean = !closed && sent.add(bytes.copyOf())

        override fun close() {
            closed = true
        }
    }

    private class RecordingCallbacks : LineCallbacks {
        val events = mutableListOf<String>()
        val lines = mutableListOf<String>()

        override fun onOpen(connection: LineConnection) {
            events += "open"
        }

        override fun onText(text: String) {
            lines += text
        }

        override fun onClosed(cause: DisconnectCause) {
            events += "closed:$cause"
        }

        override fun onFailure(error: Throwable) {
            events += "failure:${error.message}"
        }
    }

    private class FakeScheduler : TransportScheduler {
        data class Task(val block: () -> Unit, var cancelled: Boolean = false) : Cancelable {
            override fun cancel() {
                cancelled = true
            }
        }

        private val tasks = mutableListOf<Task>()

        override fun schedule(delayMs: Long, block: () -> Unit): Cancelable =
            Task(block).also(tasks::add)

        fun runNext() {
            tasks.first { !it.cancelled }.also { it.cancelled = true }.block()
        }
    }
}

private fun connectSuccess(sessionId: String): ByteArray {
    val bytes = sessionId.toByteArray(StandardCharsets.UTF_8)
    return ByteBuffer.allocate(6 + bytes.size)
        .order(ByteOrder.BIG_ENDIAN)
        .putShort(1)
        .putInt(bytes.size)
        .put(bytes)
        .array()
}
