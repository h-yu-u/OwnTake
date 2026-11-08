import { readFile } from 'node:fs/promises';
import { TARGETS, artifactNames, assertReleaseTag } from './targets.mjs';

const PLATFORM_NAMES = Object.freeze({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' });
const RELEASE_BASE = 'https://github.com/h-yu-u/OwnTake/releases/download';

/** Human changes are reviewed with the source; download facts come from verified artifacts. */
export function formatReleaseNotes(release, changes) {
  assertReleaseTag(release.tag, release.version);
  changes = changes.replace(/\r\n/g, '\n');
  if (!changes.startsWith(`# OwnTake ${release.tag}\n`) || !changes.includes('<!-- lang:en -->') || !changes.includes('<!-- lang:zh -->')) {
    throw new Error('Release notes must name the exact version and contain English and Chinese changes');
  }
  if (/maintainer: replace|placeholder|TODO|待填写|占位文案/i.test(changes)) throw new Error('Release notes still contain placeholders');
  const link = name => `[${name}](${RELEASE_BASE}/${release.tag}/${name})`;
  const rows = TARGETS.map(target => {
    const [installer, archive] = artifactNames(target);
    const actual = release.artifacts.filter(file => file.target === target.id);
    if (actual.length !== 2 || !actual.some(file => file.name === installer) || !actual.some(file => file.name === archive)
      || actual.some(file => file.signing !== actual[0].signing)) throw new Error(`Incomplete release notes evidence for ${target.id}`);
    const architecture = target.arch === 'arm64' ? (target.platform === 'darwin' ? 'Apple Silicon' : 'ARM64') : (target.platform === 'darwin' ? 'Intel' : 'Intel / AMD 64-bit');
    return `| ${PLATFORM_NAMES[target.platform]} | ${architecture} | ${link(installer)} | ${link(archive)} | ${actual[0].signing} |`;
  });
  return [
    changes.trim(), '',
    '## Downloads / 下载与安装', '',
    '| Platform / 系统 | CPU | Installer / 安装包 | Portable / 便携归档 | Signing / 签名 |',
    '| --- | --- | --- | --- | --- |', ...rows, '',
    'Choose the installer for your system and CPU. `amd64` means Intel/AMD x64; `arm64` means ARM64. ZIP / tar.gz are portable alternatives.', '',
    '下载与你电脑系统和 CPU 对应的安装包即可。`amd64` 即 x64，`arm64` 即 ARM64；ZIP / tar.gz 是备用便携归档，无需另行下载 JSON 清单才能打开应用。', '',
    '## Verification / 校验与签名', '',
    `${link('SHA256SUMS')} · ${link('release-manifest.json')}`, '',
    'SHA256SUMS verifies the downloaded packages; release-manifest.json records the source commit, platform, file sizes, hashes and signing modes.', '',
    'macOS `ad-hoc` builds are not Apple-notarized. Windows `unsigned` builds have no trusted Authenticode publisher certificate. Each platform’s actual mode is shown above.', '',
    'SHA256SUMS 用于核对下载文件；release-manifest.json 记录源提交、平台、大小、摘要和签名状态。macOS 的 ad-hoc 包未通过 Apple 公证；Windows 的 unsigned 包没有可信发行者证书。具体状态见上表。', '',
    'All six native archives passed CPU architecture and extracted Electron startup, media export, shutdown and restart checks. Installer dialogs, upgrades and operating-system trust prompts require separate validation.', '',
    '六个平台归档均通过原生 CPU 架构检查及解包后的 Electron 启动、媒体导出、退出和重启检查；安装向导、升级及系统信任提示属于独立验收范围。', '',
    `Source commit / 源提交: [\`${release.commit}\`](https://github.com/h-yu-u/OwnTake/commit/${release.commit})`, '',
  ].join('\n');
}

export async function readVersionChanges(tag, version) {
  assertReleaseTag(tag, version);
  return readFile(new URL(`../../docs/releases/${tag}.md`, import.meta.url), 'utf8');
}
