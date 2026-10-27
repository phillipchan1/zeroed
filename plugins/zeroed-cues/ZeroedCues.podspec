require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ZeroedCues'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => package['license'], :text => 'Private to Zeroed.' }
  s.homepage = 'https://github.com/phillipchan1/zeroed'
  s.author = package['author']
  s.source = { :git => 'https://github.com/phillipchan1/zeroed.git', :tag => package['version'] }
  s.source_files = 'ios/Sources/**/*.swift'
  # The cue WAVs, rendered from src/engine/cueSound.ts by `npm run cues:render`.
  s.resources = 'ios/Sources/ZeroedCuesPlugin/Sounds/*.wav'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
