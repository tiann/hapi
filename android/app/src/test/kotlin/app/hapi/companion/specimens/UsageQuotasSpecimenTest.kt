package app.hapi.companion.specimens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import app.hapi.companion.feature.settings.QuotaUiState
import app.hapi.companion.feature.settings.UsageQuotasSection
import app.hapi.protocol.wire.AgentQuotaAccount
import app.hapi.protocol.wire.AgentQuotaBucket
import app.hapi.protocol.wire.UsageMachineQuotas
import app.hapi.protocol.wire.UsageQuotasResponse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "en-w412dp-h915dp-xxhdpi")
class UsageQuotasSpecimenTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun reportsProviderWindowsAndUnavailability() {
        val accounts = listOf(
            AgentQuotaAccount(
                agent = "cursor", available = true, status = "ok",
                planLabel = "Pro", creditsLabel = "USD 10",
                buckets = listOf(AgentQuotaBucket("Monthly", 42.75, 57.25, 1789000000000)),
            ),
            AgentQuotaAccount("future-cli", true, "unauthenticated", emptyList()),
        )
        val machines = listOf(
            UsageMachineQuotas("1", "Laptop", true, accounts),
            UsageMachineQuotas("2", "Desktop", false, emptyList()),
        )
        compose.setContent {
            Specimen(SpecimenTheme.Light) {
                UsageQuotasSection(QuotaUiState(UsageQuotasResponse(machines), loading = false)) {}
            }
        }
        compose.onNodeWithText("Cursor").assertIsDisplayed()
        compose.onNodeWithText("43% remaining (57% used)").assertIsDisplayed()
        compose.onNodeWithText("Resets ", substring = true).assertIsDisplayed()
        compose.onNodeWithText("future-cli").assertIsDisplayed()
        compose.onNodeWithText("Not signed in").assertIsDisplayed()
        compose.onNodeWithText("Update the runner", substring = true).assertIsDisplayed()
        compose.captureSpecimen("usage-quotas", SpecimenTheme.Light)
    }
}
