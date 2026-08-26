import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    // New-session form draft + prefs persist as JSON blobs in DataStore (B-M3d).
    alias(libs.plugins.kotlin.serialization)
    // com.google.gms.google-services is applied CONDITIONALLY below (B-M4a):
    // the plugin hard-fails when app/google-services.json is missing, and the
    // repo must build green without any Firebase project configured.
}

// FCM (B-M4a): official builds inject google-services.json in CI; self-builders
// drop in their own (see ../README.md "Firebase / push"); everyone else builds
// without it — Firebase then never initializes and PushBinding reports push as
// unavailable, so every push code path no-ops cleanly.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

// Release signing: an UPLOAD key only — Play App Signing holds the real
// distribution key, so a lost upload key is recoverable via Play Console.
// Resolved from gradle properties (user-global ~/.gradle/gradle.properties
// or -P), environment (CI secrets), or android/local.properties (the
// conventional gitignored home for machine-local secrets — NOT part of
// gradle's own property chain, hence loaded explicitly):
//   hapiUploadKeystore          / HAPI_UPLOAD_KEYSTORE           keystore path (~ ok)
//   hapiUploadKeystorePassword  / HAPI_UPLOAD_KEYSTORE_PASSWORD
//   hapiUploadKeyAlias          / HAPI_UPLOAD_KEY_ALIAS          default "upload"
//   hapiUploadKeyPassword       / HAPI_UPLOAD_KEY_PASSWORD       default: store password
// All unset → release builds unsigned; the repo needs no secrets to build.
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingSecret(property: String, env: String): String? =
    (findProperty(property) as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv(env)?.takeIf { it.isNotBlank() }
        ?: localProperties.getProperty(property)?.takeIf { it.isNotBlank() }

val uploadKeystorePath = signingSecret("hapiUploadKeystore", "HAPI_UPLOAD_KEYSTORE")
    ?.replaceFirst(Regex("^~"), System.getProperty("user.home"))

android {
    namespace = "app.hapi.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "run.hapi.companion"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        // Tracks the hapi CLI/hub release train.
        versionName = "0.28.0"
    }

    signingConfigs {
        if (uploadKeystorePath != null) {
            create("release") {
                storeFile = File(uploadKeystorePath)
                storePassword = signingSecret("hapiUploadKeystorePassword", "HAPI_UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = signingSecret("hapiUploadKeyAlias", "HAPI_UPLOAD_KEY_ALIAS") ?: "upload"
                keyPassword = signingSecret("hapiUploadKeyPassword", "HAPI_UPLOAD_KEY_PASSWORD")
                    ?: signingSecret("hapiUploadKeystorePassword", "HAPI_UPLOAD_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // null when no upload key is configured → unsigned release.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        // About screen surfaces BuildConfig.VERSION_NAME (B-M4e).
        buildConfig = true
    }

    testOptions {
        unitTests.all { test ->
            // Chat pipeline smoke tests replay golden fixtures from the repo
            // root (same wiring as :core:protocol / :core:data).
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
    implementation(project(":core:protocol"))
    implementation(project(":core:data"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    // Per-app locales (B-M5a): AppCompatActivity + setApplicationLocales
    // (autoStoreLocales service is declared in the manifest).
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    // QR pairing (ScanContract activity-result API; no Play Services).
    implementation(libs.zxing.android.embedded)

    // Generated images (chat, B-M2d2): loader wired in HubGraph over the
    // authed + disk-cached hub image client.
    implementation(libs.coil.compose)

    // FCM push + notification actions (B-M4a). firebase-messaging is always on
    // the classpath; whether it *activates* depends on google-services.json
    // (conditional plugin above) — PushBinding gates every use at runtime.
    implementation(libs.firebase.messaging)
    implementation(libs.androidx.work.runtime.ktx)
    constraints {
        // Version floor only: firebase-messaging → play-services-base drags in
        // androidx.fragment 1.1.0, whose broken permission-result routing makes
        // lintVital reject any ActivityResult use (MainActivity's
        // POST_NOTIFICATIONS prompt). Nothing in the app uses fragments.
        implementation(libs.androidx.fragment)
    }

    // Markdown rendering (B-M2d1). commonmark comes through :core:protocol's
    // `api` too; declared here because ui/markdown walks the AST types directly.
    implementation(libs.commonmark)
    implementation(libs.commonmark.ext.gfm.tables)
    implementation(libs.commonmark.ext.gfm.strikethrough)
    implementation(libs.highlights)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // JVM unit tests (ViewModel combine logic with fake stores).
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
}
