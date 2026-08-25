import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Pure Kotlin/JVM module: hub wire types, chat pipeline, pagination/window logic,
// patch application, BindLink parsing. NO Android dependencies -- tests run in
// milliseconds on any JVM and validate against shared/fixtures/** golden files.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    api(libs.kotlinx.serialization.json)

    // CommonMark parsing lives in this pure-JVM module so parser configuration
    // (GFM extensions, disabled indented code blocks) is covered by millisecond
    // JVM tests together with the source-level transforms that feed it.
    // `api`: :app walks the commonmark AST directly in the Compose renderer.
    api(libs.commonmark)
    api(libs.commonmark.ext.gfm.tables)
    api(libs.commonmark.ext.gfm.strikethrough)
    api(libs.commonmark.ext.autolink)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
}

tasks.test {
    // Golden fixtures live at the repo root (outside the Gradle root dir).
    // Track K (M2) drops conformance fixtures into shared/fixtures/; protocol
    // tests read them via this system property -- no build changes needed then.
    systemProperty("hapi.fixtures.dir", rootDir.parentFile.resolve("shared/fixtures").absolutePath)
}
