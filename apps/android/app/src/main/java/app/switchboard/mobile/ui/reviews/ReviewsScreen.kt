package app.switchboard.mobile.ui.reviews

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.data.remote.ReviewsState
import app.switchboard.mobile.domain.reviews.PhonePrChecks
import app.switchboard.mobile.domain.reviews.PhonePrFilters
import app.switchboard.mobile.domain.reviews.PhonePrGroupBy
import app.switchboard.mobile.domain.reviews.PhonePrHostError
import app.switchboard.mobile.domain.reviews.PhonePrShow
import app.switchboard.mobile.domain.reviews.PhonePullRequests
import app.switchboard.mobile.domain.reviews.PrRow
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.components.SwitchboardEmptyState
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.SwitchboardDimensions
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.demo.DemoBadge

object ReviewsTestTags {
    const val TAB_PROJECTS = "connection-tab-projects"
    const val TAB_REVIEWS = "connection-tab-reviews"
    const val TAB_BADGE = "connection-tab-reviews-badge"
    const val LIST = "reviews-list"
    const val SEARCH = "reviews-search"
    const val FILTER_BUTTON = "reviews-filter-button"
    const val FILTER_DOT = "reviews-filter-dot"
    const val FILTER_SHEET = "reviews-filter-sheet"
    const val STALE_NOTE = "reviews-stale-note"
    const val HIDDEN_REPOS = "reviews-hidden-repos"
    const val EMPTY = "reviews-empty"
    const val SHOW_MERGED = "reviews-show-merged"
    fun row(key: String) = "reviews-row:$key"
    fun section(key: String) = "reviews-section:$key"
    fun chip(id: String) = "reviews-chip:$id"
    fun hostError(host: String) = "reviews-host-error:$host"
}

enum class ConnectionTab { Projects, Reviews }

/** The per-connection bottom bar: Projects and Reviews, with the Needs you count on Reviews. */
@Composable
fun ConnectionTabBar(selected: ConnectionTab, needsYou: Int, onSelect: (ConnectionTab) -> Unit) {
    Column(modifier = Modifier.background(Surface).navigationBarsPadding()) {
        HorizontalDivider()
        Row(modifier = Modifier.fillMaxWidth()) {
            ConnectionTab.entries.forEach { tab ->
                val active = tab == selected
                val tint = if (active) Accent else TextDim
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 56.dp)
                        .clickable(role = Role.Tab) { onSelect(tab) }
                        .testTag(if (tab == ConnectionTab.Projects) ReviewsTestTags.TAB_PROJECTS else ReviewsTestTags.TAB_REVIEWS)
                        .semantics {
                            this.selected = active
                            contentDescription = if (tab == ConnectionTab.Reviews && needsYou > 0) {
                                "Reviews, $needsYou need you"
                            } else {
                                tab.name
                            }
                        }
                        .padding(vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Box {
                        if (tab == ConnectionTab.Projects) {
                            Icon(Icons.AutoMirrored.Filled.List, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
                        } else {
                            ReviewsGlyphIcon(ReviewsGlyph.PullRequest, tint, size = 22.dp)
                            if (needsYou > 0) {
                                Box(
                                    modifier = Modifier
                                        .align(Alignment.TopEnd)
                                        .offset(x = 9.dp, y = (-5).dp)
                                        .size(16.dp)
                                        .clip(CircleShape)
                                        .background(Red)
                                        .testTag(ReviewsTestTags.TAB_BADGE),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        needsYou.coerceAtMost(99).toString(),
                                        color = Color.White,
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                }
                            }
                        }
                    }
                    Text(tab.name, color = tint, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun ReviewsScreen(
    state: ReviewsState,
    connectionLabel: String,
    now: Long,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onQuery: (String) -> Unit,
    onFilters: (PhonePrFilters) -> Unit,
    onUnhideRepos: () -> Unit,
    onOpen: (PrSummary) -> Unit,
    modifier: Modifier = Modifier,
) {
    var showMerged by rememberSaveable { mutableStateOf(false) }
    var sheetOpen by rememberSaveable { mutableStateOf(false) }
    val presentation = ReviewsPresenter.present(state, connectionLabel, now, showMerged)
    val filters = state.filters
    Column(modifier = modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Row(
            modifier = Modifier.statusBarsPadding().padding(start = 4.dp, top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack, modifier = Modifier.size(SwitchboardDimensions.minimumTouchTarget)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
        }
        Column(modifier = Modifier.padding(horizontal = SwitchboardDimensions.screenHorizontalPadding)) {
            Text(
                "Reviews",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.semantics { heading() },
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    presentation.subtitle,
                    color = TextDim,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                DemoBadge(Modifier.padding(start = 6.dp))
            }
        }
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextField(
                value = state.query,
                onValueChange = onQuery,
                placeholder = { Text("Filter pull requests") },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = TextDim) },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = SurfaceRaised,
                    unfocusedContainerColor = SurfaceRaised,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier
                    .weight(1f)
                    .testTag(ReviewsTestTags.SEARCH)
                    .semantics { contentDescription = "Filter pull requests" },
            )
            Spacer(Modifier.width(8.dp))
            Box {
                IconButton(
                    onClick = { sheetOpen = true },
                    modifier = Modifier
                        .size(SwitchboardDimensions.minimumTouchTarget)
                        .clip(RoundedCornerShape(12.dp))
                        .background(SurfaceRaised)
                        .testTag(ReviewsTestTags.FILTER_BUTTON)
                        .semantics {
                            contentDescription = if (presentation.filtersActive) "Filters, some active" else "Filters"
                        },
                ) {
                    ReviewsGlyphIcon(ReviewsGlyph.Filter, MaterialTheme.colorScheme.onSurface)
                }
                if (presentation.filtersActive) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(6.dp)
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(Accent)
                            .testTag(ReviewsTestTags.FILTER_DOT),
                    )
                }
            }
        }
        if (state.data != null) {
            QuickChips(filters, presentation.needsYou, onFilters)
        }
        PullToRefreshBox(
            isRefreshing = state.loading && state.data != null,
            onRefresh = onRefresh,
            modifier = Modifier.weight(1f),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().testTag(ReviewsTestTags.LIST),
                contentPadding = PaddingValues(bottom = 24.dp),
            ) {
                items(presentation.hostErrors, key = { "host-error:${it.host}" }) { error ->
                    HostErrorCard(error, onRefresh)
                }
                presentation.staleNote?.let { note ->
                    item(key = "stale") {
                        Row(
                            modifier = Modifier
                                .padding(horizontal = 16.dp, vertical = 6.dp)
                                .testTag(ReviewsTestTags.STALE_NOTE),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            ReviewsGlyphIcon(ReviewsGlyph.Waiting, Amber, size = 14.dp)
                            Spacer(Modifier.width(6.dp))
                            Text(note, color = Amber, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                when (val body = presentation.body) {
                    ReviewsBody.Loading -> item(key = "loading") { CenterNote("Reading pull requests from the desktop") }
                    is ReviewsBody.Failure -> item(key = "failure") {
                        HostErrorCard(PhonePrHostError("all", "Couldn't read pull requests", body.message), onRefresh)
                    }
                    ReviewsBody.NoMatch -> item(key = "no-match") { CenterNote("No pull requests match") }
                    is ReviewsBody.NothingOpen -> item(key = "empty") {
                        Column(modifier = Modifier.testTag(ReviewsTestTags.EMPTY)) {
                            SwitchboardEmptyState(
                                title = ReviewsPresenter.EMPTY_TITLE,
                                body = ReviewsPresenter.EMPTY_BODY,
                                icon = { ReviewsGlyphIcon(ReviewsGlyph.Ready, Green, size = 28.dp) },
                            )
                            if (body.merged > 0) {
                                TextButton(
                                    onClick = { showMerged = true },
                                    modifier = Modifier
                                        .align(Alignment.CenterHorizontally)
                                        .testTag(ReviewsTestTags.SHOW_MERGED),
                                ) { Text("${body.merged} merged this week ›", color = Accent) }
                            }
                        }
                    }
                    is ReviewsBody.Sections -> body.sections.forEach { section ->
                        item(key = "section:${section.key}") {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp)
                                    .testTag(ReviewsTestTags.section(section.key)),
                            ) {
                                SectionLabel(section.title, modifier = Modifier.weight(1f))
                                Text(section.rows.size.toString(), color = TextDim, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                        items(section.rows, key = { "${section.key}:${it.pr.ref.key}" }) { row ->
                            PullRequestRow(row, now, onClick = { onOpen(row.pr) })
                            HorizontalDivider(modifier = Modifier.padding(start = 48.dp))
                        }
                    }
                }
                presentation.hiddenReposLabel?.let { label ->
                    item(key = "hidden-repos") {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 12.dp)
                                .testTag(ReviewsTestTags.HIDDEN_REPOS),
                            horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("$label · ", color = TextDim, style = MaterialTheme.typography.labelSmall)
                            TextButton(onClick = onUnhideRepos, enabled = !state.unhiding) { Text("Show", color = Accent) }
                        }
                        state.unhideError?.let { CenterNote(it, Red) }
                    }
                }
            }
        }
    }
    if (sheetOpen) {
        ModalBottomSheet(onDismissRequest = { sheetOpen = false }, containerColor = Surface) {
            FilterSheet(
                filters = filters,
                repos = presentation.repos,
                hiddenCount = presentation.hiddenCount,
                onFilters = onFilters,
            )
        }
    }
}

@Composable
private fun QuickChips(filters: PhonePrFilters, needsYou: Int, onFilters: (PhonePrFilters) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        PhonePrShow.entries.forEach { show ->
            FilterChip(
                selected = filters.show == show,
                onClick = { onFilters(filters.copy(show = show)) },
                label = { Text(ReviewsPresenter.chipLabel(show, needsYou)) },
                modifier = Modifier.testTag(ReviewsTestTags.chip(show.wire)),
            )
        }
        FilterChip(
            selected = filters.groupBy == PhonePrGroupBy.Repository,
            onClick = {
                onFilters(
                    filters.copy(
                        groupBy = if (filters.groupBy == PhonePrGroupBy.Repository) PhonePrGroupBy.Status else PhonePrGroupBy.Repository,
                    ),
                )
            },
            label = { Text("By repo") },
            modifier = Modifier.testTag(ReviewsTestTags.chip("by-repo")),
        )
    }
}

@Composable
private fun PullRequestRow(row: PrRow, now: Long, onClick: () -> Unit) {
    val pr = row.pr
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = SwitchboardDimensions.rowMinimumHeight)
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .testTag(ReviewsTestTags.row(pr.ref.key)),
        verticalAlignment = Alignment.Top,
    ) {
        ReviewsGlyphIcon(row.status.icon.glyph(), row.status.icon.tint(), modifier = Modifier.padding(top = 2.dp))
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                pr.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row {
                Text(
                    "${pr.ref.repo.label} #${pr.ref.number}",
                    color = TextDim,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                )
                if (row.status.phrase.isNotEmpty()) {
                    Text(
                        " · ${row.status.phrase}",
                        color = ReviewsPresenter.phraseTone(row.status).color().let { if (it == TextDim) MaterialTheme.colorScheme.onSurface else it },
                        style = MaterialTheme.typography.labelMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(PhonePullRequests.ageLabel(pr.updatedAt, now), color = TextDim, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun HostErrorCard(error: PhonePrHostError, onRetry: () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .testTag(ReviewsTestTags.hostError(error.host)),
        shape = RoundedCornerShape(SwitchboardDimensions.compactRadius),
        color = Red.copy(alpha = 0.10f),
        border = BorderStroke(1.dp, Red.copy(alpha = 0.5f)),
    ) {
        Column(modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ReviewsGlyphIcon(ReviewsGlyph.Failed, Red, size = 16.dp)
                Spacer(Modifier.width(8.dp))
                Text(error.title, color = Red, style = MaterialTheme.typography.titleSmall)
            }
            Text(error.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
            TextButton(onClick = onRetry) { Text("Try again", color = Accent) }
        }
    }
}

@Composable
private fun CenterNote(text: String, color: Color = TextDim) {
    Text(
        text,
        color = color,
        textAlign = TextAlign.Center,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.fillMaxWidth().padding(24.dp),
    )
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun FilterSheet(
    filters: PhonePrFilters,
    repos: List<app.switchboard.mobile.domain.reviews.PhonePrRepo>,
    hiddenCount: Int,
    onFilters: (PhonePrFilters) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 24.dp)
            .testTag(ReviewsTestTags.FILTER_SHEET),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Filters", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
            TextButton(onClick = { onFilters(PhonePullRequests.DEFAULT_FILTERS) }) { Text("Reset", color = Accent) }
        }
        SheetLabel("Group by")
        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            PhonePrGroupBy.entries.forEachIndexed { index, groupBy ->
                SegmentedButton(
                    selected = filters.groupBy == groupBy,
                    onClick = { onFilters(filters.copy(groupBy = groupBy)) },
                    shape = SegmentedButtonDefaults.itemShape(index, PhonePrGroupBy.entries.size),
                ) { Text(groupBy.label) }
            }
        }
        SheetLabel("Show")
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
            PhonePrShow.entries.forEach { show ->
                FilterChip(selected = filters.show == show, onClick = { onFilters(filters.copy(show = show)) }, label = { Text(show.label) })
            }
        }
        SheetLabel("Checks")
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
            PhonePrChecks.entries.forEach { checks ->
                FilterChip(
                    selected = filters.checks == checks,
                    onClick = { onFilters(filters.copy(checks = checks)) },
                    label = { Text(checks.label) },
                )
            }
        }
        if (repos.isNotEmpty()) {
            SheetLabel("Repositories")
            repos.forEach { repo ->
                val included = repo.key !in filters.excludedRepos
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = SwitchboardDimensions.minimumTouchTarget)
                        .clickable(role = Role.Checkbox) { onFilters(PhonePullRequests.toggleExcludedRepo(filters, repo.key)) }
                        .semantics { selected = included },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(repo.label, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                    if (included) Icon(Icons.Default.Check, contentDescription = "Shown", tint = Accent)
                }
                HorizontalDivider()
            }
        }
        SwitchRow("Show drafts", filters.showDrafts) { onFilters(filters.copy(showDrafts = it)) }
        SwitchRow(
            if (hiddenCount > 0) "Hidden pull requests · $hiddenCount" else "Hidden pull requests",
            filters.showHidden,
        ) { onFilters(filters.copy(showHidden = it)) }
    }
}

@Composable
private fun SheetLabel(text: String) {
    SectionLabel(text, modifier = Modifier.padding(top = 16.dp, bottom = 8.dp))
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
