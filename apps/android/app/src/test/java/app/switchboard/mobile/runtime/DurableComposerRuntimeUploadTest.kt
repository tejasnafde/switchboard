package app.switchboard.mobile.runtime

import app.switchboard.mobile.data.composer.ComposerAttachmentStageResult
import app.switchboard.mobile.data.composer.ComposerAttachmentStager
import app.switchboard.mobile.data.composer.ComposerDraftCoordinator
import app.switchboard.mobile.data.composer.ComposerDraftLoadResult
import app.switchboard.mobile.data.composer.ComposerDraftStorageResult
import app.switchboard.mobile.data.composer.ComposerDraftStore
import app.switchboard.mobile.data.composer.ComposerFileUploader
import app.switchboard.mobile.data.composer.ComposerUploadResult
import app.switchboard.mobile.data.outbox.AttachmentStageResult
import app.switchboard.mobile.data.outbox.AttachmentStager
import app.switchboard.mobile.data.outbox.OutboxImageMaterialization
import app.switchboard.mobile.data.outbox.OutboxLoadResult
import app.switchboard.mobile.data.outbox.OutboxObserver
import app.switchboard.mobile.data.outbox.OutboxRetryScheduler
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.data.outbox.OutboxStorageResult
import app.switchboard.mobile.data.outbox.OutboxStore
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerFiles
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.composer.UploadedFile
import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.StagedAttachment
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DurableComposerRuntimeUploadTest {
    private val key = ComposerDraftKey("mac-a", "thread-a")
    private val worker = Executors.newSingleThreadExecutor()
    private val outboxStore = FakeOutboxStore()
    private val uploader = DeferredUploader()
    private val draftStore = MemoryDraftStore()
    private val runtime = DurableComposerRuntime(
        coordinator = ComposerDraftCoordinator(draftStore, NoImages),
        outbox = OutboxRuntime(
            store = outboxStore,
            attachmentStager = PassThroughStager,
            imageMaterializer = { OutboxImageMaterialization.Success(emptyList()) },
            clients = { null },
            capabilities = { null },
            clock = { 1L },
            scheduler = NoScheduler,
            ids = { "origin-${outboxStore.inserted.size + 1}" },
            observer = SilentObserver,
        ).also { it.onStartupReady() },
        worker = worker,
    )

    @After
    fun tearDown() = runtime.close()

    @Test
    fun `send waits while a file uploads and then carries it`() {
        runtime.save(ComposerDraft(key, text = "read this"))
        runtime.addAttachments(key, listOf(ComposerImageSource("content://spec", "application/pdf", "spec.pdf")), uploader)
        drain()
        assertEquals(listOf("spec.pdf"), runtime.uploads.value[key])

        runtime.submitSavedDraft(key)
        drain()
        assertTrue(outboxStore.inserted.isEmpty())

        uploader.finish(0, "/saved/spec.pdf")
        drain()
        assertNull(runtime.uploads.value[key])
        runtime.submitSavedDraft(key)
        drain()
        val sent = outboxStore.inserted.single()
        assertEquals("read this", sent.text)
        assertEquals("/saved/spec.pdf", ComposerFiles.uploaded(sent.attachments.single().privateUri, sent.attachments.single().mimeType)?.path)
    }

    @Test
    fun `two pastes in flight get different names and upload one at a time`() {
        runtime.attachPastedText(key, "first", uploader) {}
        runtime.attachPastedText(key, "second", uploader) {}
        drain()

        assertEquals(listOf("pasted-text-1.txt"), uploader.names)
        assertEquals(listOf("pasted-text-1.txt", "pasted-text-2.txt"), runtime.uploads.value[key])

        uploader.finish(0, "/saved/pasted-text-1.txt")
        drain()
        assertEquals(listOf("pasted-text-1.txt", "pasted-text-2.txt"), uploader.names)
        assertEquals(listOf("pasted-text-2.txt"), runtime.uploads.value[key])
    }

    @Test
    fun `send is held from the pick, before the worker reads it`() {
        val gate = CountDownLatch(1)
        worker.execute { gate.await() }
        runtime.addAttachments(key, listOf(ComposerImageSource("content://spec", "application/pdf", "spec.pdf")), uploader)

        assertTrue(runtime.uploading(key))
        gate.countDown()
        drain()
        assertTrue(runtime.uploading(key))
        uploader.finish(0, "/saved/spec.pdf")
        drain()
        assertFalse(runtime.uploading(key))
    }

    @Test
    fun `a paste that uploads but cannot be saved returns the reason`() {
        val reasons = mutableListOf<String>()
        runtime.attachPastedText(key, "text", uploader) { reasons += it }
        drain()

        draftStore.failSave = true
        uploader.finish(0, "/saved/pasted-text-1.txt")
        drain()

        assertEquals(listOf("disk full"), reasons)
        assertFalse(runtime.uploading(key))
    }

    @Test
    fun `a refused paste ends its upload and returns the reason`() {
        val reasons = mutableListOf<String>()
        runtime.attachPastedText(key, "text", uploader) { reasons += it }
        drain()

        uploader.refuse(0, "pasted-text-1.txt was not attached: It could not be saved.")
        drain()

        assertEquals(listOf("pasted-text-1.txt was not attached: It could not be saved."), reasons)
        assertNull(runtime.uploads.value[key])
    }

    /** Runs every task queued so far, including the ones those tasks queue. */
    private fun drain() {
        repeat(3) { worker.submit {}.get() }
    }

    private class DeferredUploader : ComposerFileUploader {
        val names = mutableListOf<String>()
        private val callbacks = mutableListOf<(ComposerUploadResult) -> Unit>()

        override fun upload(source: ComposerImageSource, callback: (ComposerUploadResult) -> Unit) {
            names += source.displayName
            callbacks += callback
        }

        override fun uploadText(name: String, text: String, callback: (ComposerUploadResult) -> Unit) {
            names += name
            callbacks += callback
        }

        fun finish(index: Int, path: String) =
            callbacks[index](ComposerUploadResult.Uploaded(UploadedFile(names[index], path, names[index])))

        fun refuse(index: Int, line: String) = callbacks[index](ComposerUploadResult.Refused(line))
    }

    private class MemoryDraftStore : ComposerDraftStore {
        var failSave = false
        override fun load() = ComposerDraftLoadResult.Success(emptyList())
        override fun save(draft: ComposerDraft) =
            if (failSave) ComposerDraftStorageResult.Failure("disk full") else ComposerDraftStorageResult.Success
        override fun delete(key: ComposerDraftKey) = ComposerDraftStorageResult.Success
    }

    private object NoImages : ComposerAttachmentStager {
        override fun stage(sources: List<ComposerImageSource>, existing: List<ComposerAttachment>) =
            ComposerAttachmentStageResult.Failure("no images in this test")

        override fun discard(attachments: List<ComposerAttachment>) = Unit
    }

    private class FakeOutboxStore : OutboxStore {
        val inserted = mutableListOf<QueuedTurn>()
        override fun insert(turn: QueuedTurn): OutboxStorageResult {
            inserted += turn
            return OutboxStorageResult.Success
        }
        override fun update(turn: QueuedTurn) = OutboxStorageResult.Success
        override fun replace(turn: QueuedTurn) = OutboxStorageResult.Success
        override fun delete(origin: String) = OutboxStorageResult.Success
        override fun load() = OutboxLoadResult.Success(emptyList())
    }

    private object PassThroughStager : AttachmentStager {
        override fun stage(attachments: List<AttachmentDraft>) = AttachmentStageResult.Success(
            attachments.map { StagedAttachment(requireNotNull(it.privateSourcePath), it.mimeType) },
        )

        override fun discard(attachments: List<StagedAttachment>) = Unit
    }

    private object NoScheduler : OutboxRetryScheduler {
        override fun schedule(origin: String, delayMs: Long, callback: () -> Unit) = Unit
        override fun cancel(origin: String) = Unit
    }

    private object SilentObserver : OutboxObserver {
        override fun onDurablyEnqueued(turn: QueuedTurn) = Unit
        override fun onAcknowledged(turn: QueuedTurn) = Unit
        override fun onTerminal(turn: QueuedTurn, reason: String) = Unit
        override fun onAmbiguous(turn: QueuedTurn, reason: String) = Unit
        override fun onStorageBlocked(turn: QueuedTurn, reason: String) = Unit
        override fun onHydrationFailure(reason: String) = Unit
    }
}
