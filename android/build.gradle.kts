// Root build file: declares plugin versions for all modules (applied per-module).
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    // Resolved here so :app can `apply(plugin = …)` it conditionally — the
    // plugin hard-fails without app/google-services.json, which self-builds
    // legitimately don't have (see :app build file + README "Firebase / push").
    alias(libs.plugins.google.services) apply false
}
