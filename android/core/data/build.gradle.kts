import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Android library: transport + persistence layer (see DataModule.kt for the plan).
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "app.hapi.data"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.all { test ->
            // Golden fixtures live at the repo root (outside the Gradle root
            // dir); the pagination conformance suite replays them against the
            // real MessageWindowStore (same wiring as :core:protocol).
            test.systemProperty(
                "hapi.fixtures.dir",
                rootDir.parentFile.resolve("shared/fixtures").absolutePath,
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    api(project(":core:protocol"))
    // OkHttp types (OkHttpClient, Authenticator) appear in the public API
    // surface (HubSession, TokenAuthenticator constructors).
    api(libs.okhttp)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp.sse)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.turbine)
}
