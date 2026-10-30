package app.hapi.data.sse

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import java.io.Closeable

/** One monitor per active hub; no internet-validation or metering gate. */
class AndroidNetworkMonitor(context: Context, private val onRoute: (NetworkRoute) -> Unit) : Closeable {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var current: Network? = manager.activeNetwork

    private fun publish(network: Network?, properties: LinkProperties? = network?.let(manager::getLinkProperties)) {
        onRoute(NetworkRoute(
            networkId = network?.networkHandle,
            interfaceName = properties?.interfaceName,
            routes = properties?.routes?.map { it.toString() }?.toSet().orEmpty(),
            addresses = properties?.linkAddresses?.map { it.toString() }?.toSet().orEmpty(),
        ))
    }

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            current = network
            // API 26+ delivers link properties immediately after availability.
            // Wait for that snapshot: querying here can race, publishing a
            // partial route and reconnecting twice for a single network change.
        }

        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
            if (network == current) publish(network, properties)
        }

        override fun onLost(network: Network) {
            if (network == current) {
                current = null
                publish(null)
            }
        }
    }

    init {
        publish(current)
        manager.registerDefaultNetworkCallback(callback)
    }

    override fun close() = manager.unregisterNetworkCallback(callback)
}
