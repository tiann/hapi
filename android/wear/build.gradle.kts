import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "app.hapi.companion.wear"
    compileSdk = 36

    defaultConfig {
        // Wear's applicationId MUST equal the phone app's (:app) exact
        // applicationId — the GMS Data Layer resolves the paired node's
        // listener by package name + signing cert; a mismatch here fails
        // delivery silently ("Didn't find package").
        applicationId = "run.hapi.companion"
        minSdk = 30 // Wear OS 3+ (API 30), matches androidx.wear.compose's floor.
        targetSdk = 36
        versionCode = providers.gradleProperty("hapiVersionCode").map { value ->
            value.toInt().also { require(it > 0) { "hapiVersionCode must be positive" } }
        }.orElse(1).get()
        versionName = providers.gradleProperty("hapiVersionName").orElse("0.30.7").get()
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // PushPayload/PushType/PushSeverity parsing (reused verbatim — the watch
    // decodes the same relayed data map the phone's FCM service decodes).
    implementation(project(":core:protocol"))
    implementation(project(":core:data"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    // Data Layer (phone <-> watch bridge): NodeClient/MessageClient/DataClient.
    implementation(libs.play.services.wearable)
    // RemoteInputIntentHelper: proactive mic/keyboard reply sheet.
    implementation(libs.androidx.wear.input)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.wear.compose.material)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.compose.navigation)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
}
