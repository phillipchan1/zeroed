import AVFoundation
import Capacitor
import Foundation

/// The interval timer's cues, played natively.
///
/// The web view can't do this job: WKWebView audio is muted by Silent Mode,
/// and the web's own way around that stops the athlete's music. Here the app
/// session is `.playback` (heard in Silent Mode) with `.duckOthers` (music
/// dips under a cue rather than stopping), and it is active only while a cue
/// plays — when the last one ends the session is released and the music comes
/// back up.
@objc(ZeroedCuesPlugin)
public class ZeroedCuesPlugin: CAPPlugin, CAPBridgedPlugin, AVAudioPlayerDelegate {
    public let identifier = "ZeroedCuesPlugin"
    public let jsName = "ZeroedCues"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "preload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise)
    ]

    private var players: [String: AVAudioPlayer] = [:]
    private var sounding = Set<String>()
    private var releaseWork: DispatchWorkItem?

    @objc func preload(_ call: CAPPluginCall) {
        let names = call.getArray("names", String.self) ?? []
        DispatchQueue.main.async {
            // The category goes in first, and the session stays inactive: the
            // app's default category (solo ambient) doesn't mix, so anything
            // that touches the hardware before this would stop the music the
            // moment the athlete taps Start.
            try? self.configureCategory()
            for name in names { _ = self.player(for: name) }
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), Self.isCueName(name) else {
            call.reject("Unknown cue")
            return
        }
        DispatchQueue.main.async {
            guard let player = self.player(for: name) else {
                call.reject("Cue \(name) is not bundled")
                return
            }
            do {
                try self.activateSession()
            } catch {
                call.reject("Audio session unavailable: \(error.localizedDescription)")
                return
            }
            self.releaseWork?.cancel()
            self.releaseWork = nil
            player.currentTime = 0
            if player.play() {
                self.sounding.insert(name)
                call.resolve()
            } else {
                self.scheduleRelease()
                call.reject("Cue \(name) did not play")
            }
        }
    }

    @objc func release(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.players.values.forEach { $0.stop() }
            self.players.removeAll()
            self.sounding.removeAll()
            self.deactivateSession()
            call.resolve()
        }
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            if let name = self.players.first(where: { $0.value === player })?.key {
                self.sounding.remove(name)
            }
            if self.sounding.isEmpty { self.scheduleRelease() }
        }
    }

    // MARK: - session

    // Setting the category on an inactive session touches nobody else's audio;
    // only activating it does.
    private func configureCategory() throws {
        let session = AVAudioSession.sharedInstance()
        if session.category != .playback || !session.categoryOptions.contains(.duckOthers) {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
        }
    }

    private func activateSession() throws {
        try configureCategory()
        try AVAudioSession.sharedInstance().setActive(true)
    }

    // Held a moment past the last cue, so a 3-2-1 ducks the music once rather
    // than pumping it every second.
    private func scheduleRelease() {
        releaseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.sounding.isEmpty else { return }
            self.deactivateSession()
        }
        releaseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }

    private func deactivateSession() {
        releaseWork?.cancel()
        releaseWork = nil
        DispatchQueue.global(qos: .userInitiated).async {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    // MARK: - players

    private func player(for name: String) -> AVAudioPlayer? {
        if let existing = players[name] { return existing }
        guard Self.isCueName(name), let url = Self.url(for: name) else { return nil }
        guard let player = try? AVAudioPlayer(contentsOf: url) else { return nil }
        player.delegate = self
        player.volume = 1.0
        // No prepareToPlay() here: it acquires the audio hardware, which
        // activates the session — ducking the music for a second before any
        // cue has sounded. play() prepares the player when its cue is due.
        players[name] = player
        return player
    }

    private static func url(for name: String) -> URL? {
        let bundles = [Bundle(for: ZeroedCuesPlugin.self), Bundle.main]
        for bundle in bundles {
            if let url = bundle.url(forResource: name, withExtension: "wav") { return url }
            if let url = bundle.url(forResource: name, withExtension: "wav", subdirectory: "Sounds") { return url }
        }
        return nil
    }

    private static func isCueName(_ name: String) -> Bool {
        return !name.isEmpty && name.count <= 32
            && name.allSatisfy { $0.isLowercase || $0.isNumber || $0 == "-" }
    }
}
