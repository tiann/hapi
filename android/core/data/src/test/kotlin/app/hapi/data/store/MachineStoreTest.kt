package app.hapi.data.store

import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachinesResponse
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.MockWebServer

class MachineStoreTest {

    private fun machinesJson(vararg machines: Machine): String =
        HapiJson.encodeToString(MachinesResponse(machines.toList()))

    private fun runMachineTest(
        block: suspend kotlinx.coroutines.test.TestScope.(MachineStore, MockWebServer) -> Unit,
    ) = runTest {
        val server = MockWebServer()
        server.start()
        try {
            block(MachineStore(apiFor(server), backgroundScope), server)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `refresh replaces the list in API order`() = runMachineTest { store, server ->
        server.enqueueJson(machinesJson(machine("m2"), machine("m1")))
        store.refresh()
        assertEquals(listOf("m2", "m1"), store.machines.value.map { it.id })
    }

    @Test
    fun `full machine payload upserts in place and appends new ones`() = runMachineTest { store, server ->
        server.enqueueJson(machinesJson(machine("m1"), machine("m2")))
        store.refresh()

        store.applyMachineEvent(
            machineUpdatedEvent("m1", HapiJson.encodeToString(machine("m1", host = "renamed")))
        )
        assertEquals("renamed", store.machines.value.first().metadata?.host)
        assertEquals(listOf("m1", "m2"), store.machines.value.map { it.id })

        store.applyMachineEvent(machineUpdatedEvent("m3", HapiJson.encodeToString(machine("m3"))))
        assertEquals(listOf("m1", "m2", "m3"), store.machines.value.map { it.id })
    }

    @Test
    fun `full machine payload with active false removes the row`() = runMachineTest { store, server ->
        server.enqueueJson(machinesJson(machine("m1"), machine("m2")))
        store.refresh()
        store.applyMachineEvent(
            machineUpdatedEvent("m1", HapiJson.encodeToString(machine("m1", active = false)))
        )
        assertEquals(listOf("m2"), store.machines.value.map { it.id })
    }

    @Test
    fun `null data removes the machine`() = runMachineTest { store, server ->
        server.enqueueJson(machinesJson(machine("m1"), machine("m2")))
        store.refresh()
        store.applyMachineEvent(machineUpdatedEvent("m1", "null"))
        assertEquals(listOf("m2"), store.machines.value.map { it.id })
    }

    @Test
    fun `patch with active false removes, other patches refetch`() = runMachineTest { store, server ->
        server.enqueueJson(machinesJson(machine("m1"), machine("m2")))
        store.refresh()

        store.applyMachineEvent(machineUpdatedEvent("m1", """{"active":false}"""))
        assertEquals(listOf("m2"), store.machines.value.map { it.id })

        // activeAt-only patch carries too little to upsert → refetch.
        server.enqueueJson(machinesJson(machine("m2"), machine("m3")))
        store.applyMachineEvent(machineUpdatedEvent("m2", """{"activeAt":123}"""))
        store.machines.first { list -> list.map { it.id } == listOf("m2", "m3") }
    }

    @Test
    fun `absent data refetches machines`() = runMachineTest { store, server ->
        server.enqueueJson(machinesJson(machine("m1")))
        store.applyMachineEvent(machineUpdatedEvent("m1", dataJson = null))
        store.machines.first { list -> list.map { it.id } == listOf("m1") }
    }

    @Test
    fun `machines round-trip through the snapshot`() = runTest {
        val dir = Files.createTempDirectory("machine-store").toFile()
        val server = MockWebServer()
        server.start()
        try {
            val store = MachineStore(apiFor(server), backgroundScope, dir)
            server.enqueueJson(machinesJson(machine("m1")))
            store.refresh()
            store.flushPersistence()

            val cold = MachineStore(apiFor(server), backgroundScope, dir)
            assertEquals(listOf("m1"), cold.machines.value.map { it.id })
        } finally {
            server.shutdown()
        }
    }
}
