# Toolchain for the Tauri 2 apps (apps/native), used by scripts/native.sh. Nothing is installed on the host.
#   target linux:   Rust + WebKitGTK + Bun -> Linux desktop bundles (.deb, .rpm, .AppImage)
#   target android: linux + JDK 17 + Android SDK/NDK + Rust Android targets -> .apk / .aab
# macOS, iOS and Windows bundles need their own OS (Xcode / MSVC): see docs/native/README.md.
FROM oven/bun:1.4 AS bun

FROM rust:1.90-bookworm AS linux
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      build-essential curl wget file patchelf rpm xdg-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV CARGO_HOME=/cache/cargo CARGO_TARGET_DIR=/cache/target APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true
# rustup lives in the image (/usr/local/rustup); CARGO_HOME (registry, git) is a cache volume.
ENV PATH=/usr/local/cargo/bin:$PATH

# target linux-test: runs the built app under a virtual display and drives it over WebDriver
# (tauri-driver + WebKitWebDriver): tests/native/smoke.ts
FROM linux AS linux-test
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth webkit2gtk-driver dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
RUN CARGO_HOME=/usr/local/cargo cargo install tauri-driver --locked --version 2.0.4 && rm -rf /usr/local/cargo/registry

FROM linux AS android
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_HOME=/opt/android-sdk
ENV NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
RUN mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q commandlinetools-linux-*.zip && mv cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
    && rm commandlinetools-linux-*.zip \
    && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
    && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
         "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018" >/dev/null \
    && chmod -R a+rwX $ANDROID_HOME
RUN rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
# the generated project (gen/android) compiles against SDK 37 / build-tools 36
RUN sdkmanager "platforms;android-37" "build-tools;36.0.0" >/dev/null && chmod -R a+rwX $ANDROID_HOME
ENV PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
# Gradle caches go to a volume too (GRADLE_USER_HOME) so rebuilds do not re-download.
ENV GRADLE_USER_HOME=/cache/gradle

# target android-test: headless emulator (needs /dev/kvm) to install the debug APK and drive its
# WebView over the Chrome DevTools protocol: tests/native/android-smoke.ts (scripts/native-test.sh android)
FROM android AS android-test
RUN sdkmanager "emulator" "system-images;android-35;google_apis;x86_64" >/dev/null \
    && echo no | avdmanager create avd -n test -k "system-images;android-35;google_apis;x86_64" -d pixel_6 \
    && mkdir -p /opt/avd && mv /root/.android/avd/* /opt/avd/ \
    && sed -i 's#/root/.android/avd#/opt/avd#' /opt/avd/test.ini \
    && chmod -R a+rwX /opt/avd $ANDROID_HOME
ENV ANDROID_AVD_HOME=/opt/avd PATH=$ANDROID_HOME/emulator:$PATH
