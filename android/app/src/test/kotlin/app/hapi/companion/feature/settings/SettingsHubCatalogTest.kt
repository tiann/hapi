package app.hapi.companion.feature.settings

import app.hapi.companion.Routes
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The settings hub's category list is data: gating and ordering live here, so
 * later slices (Display/Chat/Voice/Machines) extend the catalog and these
 * tests keep the owner contract honest.
 */
class SettingsHubCatalogTest {

    @Test
    fun `owners see general usage and storage in catalog order`() {
        val routes = SettingsHubCatalog.visibleEntries(SettingsHubState(isOwner = true))
            .map { it.route }

        assertEquals(
            listOf(Routes.SETTINGS_GENERAL, Routes.SETTINGS_USAGE, Routes.SETTINGS_STORAGE),
            routes,
        )
    }

    @Test
    fun `non-owners see only the ungated general category`() {
        val routes = SettingsHubCatalog.visibleEntries(SettingsHubState(isOwner = false))
            .map { it.route }

        assertEquals(listOf(Routes.SETTINGS_GENERAL), routes)
    }

    @Test
    fun `general stays visible regardless of ownership`() {
        val general = SettingsHubCatalog.entries.first { it.route == Routes.SETTINGS_GENERAL }

        assertTrue(general.isVisible(SettingsHubState(isOwner = true)))
        assertTrue(general.isVisible(SettingsHubState(isOwner = false)))
    }

    @Test
    fun `catalog routes are unique so hub rows never shadow each other`() {
        val routes = SettingsHubCatalog.entries.map { it.route }

        assertEquals(routes.size, routes.toSet().size)
    }

    @Test
    fun `every hub row carries a summary`() {
        SettingsHubCatalog.entries.forEach { entry ->
            assertNotNull(entry.descriptionRes, "${entry.route} needs a hub summary")
        }
    }
}
