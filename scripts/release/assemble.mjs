import { copyFile, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TARGETS, assertReleaseTag } from './targets.mjs';
import { digestFile, readManifest, verifyManifest, writeJson } from './integrity.mjs';

/** A complete release is all native targets from ONE exact source commit and version. */
export async function assembleRelease(input, output, tag) {
  const manifests = [];
  for (const entry of await readdir(input, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Release input must contain only native target artifact directories');
    const directory = join(input, entry.name);
    const files = await readdir(directory);
    const names = files.filter(name => /^manifest-.+\.json$/.test(name));
    if (names.length !== 1) throw new Error(`Expected one build manifest in ${entry.name}`);
    const manifest = await readManifest(join(directory, names[0]));
    const target = await verifyManifest(directory, manifest, { requireSmoke: true });
    const expectedFiles = [...manifest.files.map(file => file.name), `manifest-${target.id}.json`].sort();
    if (JSON.stringify([...files].sort()) !== JSON.stringify(expectedFiles)) throw new Error(`Unexpected files in ${entry.name}`);
    manifests.push({ directory, manifest });
  }
  const ids = manifests.map(item => item.manifest.target).sort();
  if (JSON.stringify(ids) !== JSON.stringify(TARGETS.map(item => item.id).sort())) throw new Error('Release is incomplete or contains duplicate target builds');
  const { commit, version } = manifests[0].manifest;
  assertReleaseTag(tag, version);
  if (!manifests.every(item => item.manifest.commit === commit && item.manifest.version === version)) throw new Error('Mixed commits or versions are not a release');
  // Refuse stale output and never overwrite a previous release assembly.
  await mkdir(output, { recursive: false });
  try {
    const artifacts = [];
    for (const { directory, manifest } of manifests) {
      for (const file of manifest.files) {
        await copyFile(join(directory, file.name), join(output, file.name));
        const copied = await digestFile(join(output, file.name));
        if (copied.sha256 !== file.sha256 || copied.size !== file.size) throw new Error(`Artifact changed during assembly: ${file.name}`);
        artifacts.push({ target: manifest.target, signing: manifest.signing, ...file });
      }
    }
    artifacts.sort((a, b) => a.name.localeCompare(b.name));
    const release = { schema: 1, tag, version, commit, nativeSmokePassed: true, artifacts };
    await writeJson(join(output, 'release-manifest.json'), release);
    await writeFile(join(output, 'SHA256SUMS'), artifacts.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
    await writeFile(join(output, 'release-notes.md'), [
      `# OwnTake ${tag}`, '',
      '<!-- lang:zh -->', '## 下载与安装',
      '文件名采用 `owntake-系统-架构`；amd64 = Intel/AMD 64 位，arm64 = Apple Silicon/ARM64。',
      'macOS 使用 DMG；Windows 使用 EXE 安装程序；Linux 使用 AppImage。ZIP / tar.gz 是备用便携归档。',
      'FFmpeg、ffprobe、字幕字体和模型 API Key 不包含在应用包中；首次启动请到设置中配置。',
      '人物一致性、供应商账号权限和真实收费调用不属于打包验收；安装包不包含你的数据或凭据。', '',
      '## 校验和与签名',
      '安装前核对 SHA256SUMS。未配置发行者证书的包明确标为 ad-hoc / unsigned；这不等于通过 Apple 公证或 Windows 可信签名。', '',
      '| 文件 | 签名状态 |', '| --- | --- |',
      ...artifacts.map(file => `| \`${file.name}\` | ${file.signing} |`), '',
      '<!-- lang:en -->', '## Install',
      'Choose DMG (macOS), EXE (Windows), or AppImage (Linux). amd64 means Intel/AMD x64; arm64 means Apple Silicon/ARM64.',
      'FFmpeg, ffprobe, fonts and model credentials are configured separately. Verify SHA256SUMS before installation.',
      'All six native archive builds passed architecture and extracted Electron startup/lifecycle checks. Installer UI flows and trusted signing are separate acceptance checks.', '',
      '## Changes / 版本变化',
      '**Maintainer: replace this section with concrete user-visible changes before publishing the draft.**',
      '**发布草稿前填写本版本可感知的新增、修复、升级注意事项；不要把测试数量当作产品变化。**', '',
      `Source commit: \`${commit}\``, '',
    ].join('\n'));
    return release;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { input: { type: 'string', default: 'package-downloads' }, output: { type: 'string', default: 'release-ready' }, tag: { type: 'string' } }, strict: true });
  if (!values.tag) throw new Error('--tag is required');
  const release = await assembleRelease(resolve(values.input), resolve(values.output), values.tag);
  console.log(`[release] ${release.artifacts.length} checked artifacts for ${release.tag} (${release.commit})`);
}
