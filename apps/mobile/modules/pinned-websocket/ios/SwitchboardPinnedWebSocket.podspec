Pod::Spec.new do |s|
  s.name = 'SwitchboardPinnedWebSocket'
  s.version = '1.0.0'
  s.summary = 'Certificate-pinned WebSocket for Switchboard pairing'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Switchboard'
  s.homepage = 'https://github.com/tejasnafde/switchboard'
  s.source = { :git => s.homepage }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
