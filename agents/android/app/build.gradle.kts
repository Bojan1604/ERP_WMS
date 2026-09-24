plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Potpisivanje izdanja: ključ iz okoline (CI tajne). Bez njih se gradi samo debug.
val ksPath: String? = System.getenv("ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() && file(it).exists() }

android {
    namespace = "hr.erpwms.mdm.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "hr.erpwms.mdm.agent"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("AGENT_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("AGENT_VERSION_NAME") ?: "1.0.0"
    }

    signingConfigs {
        if (ksPath != null) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (ksPath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // Bez AndroidX, Firebase i Play Services — samo okvir Androida i Kotlin.
    testImplementation("junit:junit:4.13.2")
    // android.jar sadrži samo „stubove" za org.json; za JVM testove prava implementacija
    testImplementation("org.json:json:20240303")
}
