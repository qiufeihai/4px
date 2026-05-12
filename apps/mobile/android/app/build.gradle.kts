plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.fourpx.mobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.fourpx.mobile"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    val keystorePath = System.getenv("ANDROID_KEYSTORE_PATH") ?: ""
    val keystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
    val keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: ""
    val keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: ""
    val hasReleaseSigning =
        keystorePath.isNotBlank() &&
            keystorePassword.isNotBlank() &&
            keyAlias.isNotBlank() &&
            keyPassword.isNotBlank()

    if (hasReleaseSigning) {
        signingConfigs {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = keystorePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    lint {
        checkReleaseBuilds = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    // Optional local tun2socks artifact. Drop AAR at app/libs/tun2socks.aar.
    val tun2socksAar = file("libs/tun2socks.aar")
    if (tun2socksAar.exists()) {
        implementation(files(tun2socksAar))
    }
}
