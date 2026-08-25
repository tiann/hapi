package app.hapi.companion.di

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider

/**
 * The process singleton graph, provided at the root of the composition by
 * MainActivity (from [app.hapi.companion.HapiApp]). `staticCompositionLocalOf`
 * because the instance never changes for the life of the process.
 */
val LocalAppGraph = staticCompositionLocalOf<AppGraph> {
    error("LocalAppGraph is not provided — wrap the composition in MainActivity")
}

/**
 * Minimal factory for hand-wired ViewModels:
 * `viewModel(factory = viewModelFactory { PairingViewModel(graph.…) })`.
 * The lambda runs once per store scope; [modelClass] is trusted to match
 * because each call site constructs exactly the type it requests.
 */
fun <VM : ViewModel> viewModelFactory(create: () -> VM): ViewModelProvider.Factory =
    object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = create() as T
    }
