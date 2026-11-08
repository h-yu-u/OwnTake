/** Release identifiers match Magpie; Electron's internal x64 stays an implementation detail. */
export const TARGETS = Object.freeze([
  { id: 'darwin-arm64', platform: 'darwin', arch: 'arm64', runner: 'macos-15', formats: ['dmg', 'zip'], archive: 'zip', executable: 'OwnTake' },
  { id: 'darwin-amd64', platform: 'darwin', arch: 'x64', runner: 'macos-15-intel', formats: ['dmg', 'zip'], archive: 'zip', executable: 'OwnTake' },
  { id: 'windows-amd64', platform: 'win32', arch: 'x64', runner: 'windows-2025', formats: ['nsis', 'zip'], archive: 'zip', executable: 'OwnTake.exe' },
  { id: 'windows-arm64', platform: 'win32', arch: 'arm64', runner: 'windows-11-arm', formats: ['nsis', 'zip'], archive: 'zip', executable: 'OwnTake.exe' },
  { id: 'linux-amd64', platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04', formats: ['AppImage', 'tar.gz'], archive: 'tar.gz', executable: 'owntake' },
  { id: 'linux-arm64', platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm', formats: ['AppImage', 'tar.gz'], archive: 'tar.gz', executable: 'owntake' },
].map(target => Object.freeze({ ...target, formats: Object.freeze(target.formats) })));

export function targetById(id) {
  const target = TARGETS.find(item => item.id === id);
  if (!target) throw new Error(`Unsupported release target: ${id}`);
  return target;
}
export function nativeTarget(platform = process.platform, arch = process.arch) {
  const target = TARGETS.find(item => item.platform === platform && item.arch === arch);
  if (!target) throw new Error(`Unsupported native platform: ${platform}/${arch}`);
  return target;
}
export function artifactNames(target) {
  return target.formats.map(format => `owntake-${target.id}.${format === 'nsis' ? 'exe' : format}`);
}
export function assertNative(target, platform = process.platform, arch = process.arch) {
  if (target.platform !== platform || target.arch !== arch) {
    throw new Error(`Build and test ${target.id} on its native runner; this host is ${platform}/${arch}`);
  }
}
export function assertVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error('Version must be a numeric SemVer, optionally with a prerelease suffix');
  }
  return version;
}
export function assertReleaseTag(tag, version) {
  assertVersion(version);
  if (tag !== `v${version}`) throw new Error(`Tag must exactly match package.json: v${version}`);
  return tag;
}
