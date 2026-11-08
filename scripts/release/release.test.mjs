import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TARGETS, artifactNames, assertNative, assertReleaseTag, nativeTarget, targetById } from './targets.mjs';
import { builderConfiguration, signingMode } from './config.mjs';
import { assertExecutableArchitecture, digestFile, verifyManifest, writeJson } from './integrity.mjs';
import { assembleRelease } from './assemble.mjs';

const commit = 'a'.repeat(40);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'owntake-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'inputs');
  await mkdir(input);
  for (const target of TARGETS) {
    const directory = join(input, target.id);
    await mkdir(directory);
    const files = [];
    for (const name of artifactNames(target)) {
      await writeFile(join(directory, name), Buffer.from(`fixture only: ${name}`));
      files.push({ name, ...await digestFile(join(directory, name)) });
    }
    await writeJson(join(directory, `manifest-${target.id}.json`), {
      schema: 1, target: target.id, version: '0.1.0', commit, sourceDirty: false,
      signing: signingMode(target), files,
      smoke: { status: 'passed', platform: target.platform, arch: target.arch, archive: `owntake-${target.id}.${target.archive}` },
    });
  }
  return { root, input, output: join(root, 'ready') };
}

test('six native targets use unique Magpie-style names and explicit formats', () => {
  assert.deepEqual(TARGETS.map(t => t.id).sort(), ['darwin-amd64','darwin-arm64','linux-amd64','linux-arm64','windows-amd64','windows-arm64']);
  const names = TARGETS.flatMap(artifactNames);
  assert.equal(names.length, 12);
  assert.equal(new Set(names).size, 12);
  assert.ok(names.every(name => !name.includes('x64') && !name.includes('0.1')));
  assert.equal(nativeTarget('win32','x64').id, 'windows-amd64');
  assert.throws(() => targetById('../other'), /Unsupported/);
  assert.throws(() => assertNative(targetById('darwin-amd64'), 'darwin', 'arm64'), /native runner/);
});
test('builder keeps trusted signing explicit and never auto-publishes', () => {
  for (const target of TARGETS) {
    const config = builderConfiguration(target);
    assert.equal(config.publish, null);
    assert.equal(config.artifactName, `owntake-${target.id}.\${ext}`);
    assert.ok(config.files.includes('!node_modules/**/*'));
  }
  const mac = targetById('darwin-arm64');
  assert.equal(builderConfiguration(mac).mac.identity, '-');
  assert.equal(builderConfiguration(mac).mac.notarize, false);
  assert.throws(() => signingMode(mac, { CSC_LINK: 'present' }), /partial configuration/);
  const signed = builderConfiguration(mac, { CSC_LINK: 'present', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' });
  assert.equal(signed.mac.notarize, true); assert.equal(signed.forceCodeSigning, true);
  assert.equal(builderConfiguration(targetById('windows-amd64')).nsis.deleteAppDataOnUninstall, false);
});
test('tag validation rejects shell fragments, mismatched versions and newline injection', () => {
  assert.equal(assertReleaseTag('v0.1.0-rc.1','0.1.0-rc.1'), 'v0.1.0-rc.1');
  for (const tag of ['main','v0.2.0','v0.1.0\nref=evil','v0.1.0;echo hi']) assert.throws(() => assertReleaseTag(tag,'0.1.0'));
});
test('binary validation checks real ELF, PE and Mach-O architecture bytes', () => {
  for (const target of TARGETS) {
    const bytes = Buffer.alloc(512);
    if (target.platform === 'darwin') { bytes.writeUInt32LE(0xfeedfacf,0); bytes.writeUInt32LE(target.arch==='arm64'?0x0100000c:0x01000007,4); }
    else if (target.platform === 'linux') { Buffer.from([127,69,76,70,2,1]).copy(bytes); bytes.writeUInt16LE(target.arch==='arm64'?183:62,18); }
    else { bytes.write('MZ'); bytes.writeUInt32LE(128,0x3c); bytes.write('PE\0\0',128); bytes.writeUInt16LE(target.arch==='arm64'?0xaa64:0x8664,132); }
    assertExecutableArchitecture(bytes,target);
    const other = TARGETS.find(item => item.platform === target.platform && item.arch !== target.arch);
    assert.throws(() => assertExecutableArchitecture(bytes,other), /does not match/);
  }
});
test('assembly verifies all twelve exact artifacts and preserves signing disclosure', async t => {
  const f = await fixture(t);
  const result = await assembleRelease(f.input,f.output,'v0.1.0');
  assert.equal(result.artifacts.length,12); assert.equal(result.commit,commit);
  assert.equal((await readFile(join(f.output,'SHA256SUMS'),'utf8')).trim().split('\n').length,12);
  assert.match(await readFile(join(f.output,'release-notes.md'),'utf8'), /lang:zh/);
  await assert.rejects(() => assembleRelease(f.input,f.output,'v0.1.0'), /EEXIST/);
});
test('missing target, wrong commit, untested build and corrupted binary all block assembly', async t => {
  const f = await fixture(t);
  const target = TARGETS[0], directory = join(f.input,target.id), path = join(directory,`manifest-${target.id}.json`);
  const original = JSON.parse(await readFile(path,'utf8'));
  for (const patch of [{ commit:'b'.repeat(40) },{ sourceDirty:true },{ smoke:{status:'pending'} }]) {
    await writeJson(path,{...original,...patch});
    await assert.rejects(() => assembleRelease(f.input,f.output,'v0.1.0'));
  }
  await writeJson(path,original);
  await writeFile(join(directory,original.files[0].name),'tampered');
  await assert.rejects(() => assembleRelease(f.input,f.output,'v0.1.0'), /hash mismatch/);
  await rm(directory,{recursive:true,force:true});
  await assert.rejects(() => assembleRelease(f.input,f.output,'v0.1.0'), /incomplete/);
});
test('manifest cannot smuggle extra or duplicate paths into a release', async t => {
  const f = await fixture(t), target = TARGETS[0], directory = join(f.input,target.id);
  const original = JSON.parse(await readFile(join(directory,`manifest-${target.id}.json`),'utf8'));
  for (const files of [[...original.files,original.files[0]],original.files.map((file,i)=>i?file:{...file,name:'../secret'})]) {
    await assert.rejects(() => verifyManifest(directory,{...original,files}), /Unexpected/);
  }
});
