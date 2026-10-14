import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const project = resolve(import.meta.dirname, '..')
const expectedName = '@cqaiclub/cqai-club-smart-home-plugin'
const expectedRepository = 'https://github.com/cqai-club/cqai-club-smart-home-plugin'
const registry = 'https://registry.npmjs.org'
const args = process.argv.slice(2)
const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const readRegistry = async () => {
  const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return null
  assert.ok(response.ok, `npm registry returned HTTP ${response.status}`)
  return response.json()
}

assert.equal(pkg.name, expectedName, 'npm scope/name must match the CQAI Club package')
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'version must be a release version')
assert.equal(pkg.packageManager, 'pnpm@10.34.5', 'use the pinned package manager')
const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
assert.equal(repository?.replace(/^git\+/, '').replace(/\.git$/, ''), expectedRepository, 'repository must match the public provenance source')
assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-host-webserver'], '0.2.0-rc.2')
assert.equal(pkg.publishConfig?.access, 'public')
assert.equal(pkg.publishConfig?.registry?.replace(/\/$/, ''), registry)

if (args[0] === '--verify-published') {
  assert.equal(args.length, 2, 'usage: --verify-published path/to/package.tgz')
  // npm may accept a first publish before its public registry has finished processing it.
  const deadline = Date.now() + 10 * 60_000
  const expectedIntegrity = integrity(await readFile(resolve(project, args[1])))
  let available = false
  do {
    const published = await readRegistry()
    if (published) {
      assert.equal(published.dist?.integrity, expectedIntegrity, 'published package differs from the audited tarball')
      const archive = await fetch(published.dist.tarball, { signal: AbortSignal.timeout(30_000) })
      if (archive.status !== 404) {
        assert.ok(archive.ok, `npm tarball returned HTTP ${archive.status}`)
        assert.equal(integrity(Buffer.from(await archive.arrayBuffer())), expectedIntegrity, 'downloaded npm tarball differs from the audited tarball')
        available = true
        break
      }
    }
    if (Date.now() >= deadline) break
    console.log('npm has not finished making this version available; checking again in 5 seconds')
    await delay(5_000)
  } while (true)
  assert.ok(available, `npm package ${pkg.name}@${pkg.version} is not yet available to install`)
  console.log(`Verified npm metadata and downloaded tarball for ${pkg.name}@${pkg.version} against the audited package`)
  process.exit(0)
}

let tag
let checkRegistry = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tag') { tag = args[++i]; assert.ok(tag, '--tag requires a value') }
  else if (args[i] === '--check-registry') checkRegistry = true
  else throw new Error(`Unknown argument: ${args[i]}`)
}
if (tag !== undefined) assert.equal(tag, `v${pkg.version}`, 'git tag must match package.json version')
if (process.env.GITHUB_REPOSITORY) assert.equal(process.env.GITHUB_REPOSITORY, 'cqai-club/cqai-club-smart-home-plugin')

const market = JSON.parse(await readFile(join(project, 'market-entry.json'), 'utf8'))
const pluginManifest = JSON.parse(await readFile(join(project, 'dsh.plugin.json'), 'utf8'))
assert.equal(pluginManifest.name, pkg.name, 'DSH manifest must use the published package name')
assert.equal(pluginManifest.version, pkg.version, 'DSH manifest version must match package.json')
assert.ok((await readFile(join(project, 'cordis.patch.yml'), 'utf8')).includes(`name: '${pkg.name}'`), 'bundle patch must load the published package')
assert.equal(market.packageName, pkg.name, 'marketplace entry must point to the published package')
assert.equal(market.repositoryUrl, expectedRepository)
assert.equal(market.compatibilityApiVersion, '0.2.0-rc.2')
assert.ok(Array.isArray(market.compatibilityHosts) && market.compatibilityHosts.length > 0)

const releaseDir = join(project, '.release')
await mkdir(releaseDir, { recursive: true })
// Checks are run explicitly before this script. Pack once, then publish that same audited archive.
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', releaseDir], { cwd: project, encoding: 'utf8', timeout: 60_000 }))
assert.equal(packed.length, 1)
const info = packed[0]
assert.equal(info.name, pkg.name)
assert.equal(info.version, pkg.version)
assert.equal(basename(info.filename), info.filename, 'archive name must be a filename')
const tarball = join(releaseDir, info.filename)
const allowedRootFiles = new Set(['package.json', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
const requiredFiles = ['package.json', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'lib/index.js', 'lib/index.d.ts', 'lib/client.js']
const files = info.files.map(file => file.path).sort()
assert.equal(new Set(files).size, files.length, 'archive contains duplicate entries')
for (const file of files) {
  assert.ok(!file.split('/').some(part => part === '..' || part.startsWith('.')), `forbidden hidden/traversal path: ${file}`)
  assert.ok(allowedRootFiles.has(file) || /^lib\/[\w./-]+\.(?:js|mjs|cjs|d\.ts|map)$/.test(file), `unexpected package file: ${file}; HA/Python/credentials/databases/logs must stay outside the package`)
}
for (const file of requiredFiles) assert.ok(files.includes(file), `missing runtime/documentation file: ${file}`)
assert.ok((await readFile(join(project, 'lib/client.js'), 'utf8')).includes(`id: "${pkg.name}"`), 'client ModuleLoader registration must match the package name')
assert.equal(info.bundled?.length ?? 0, 0, 'dependencies must not be vendored into the package')
const archiveFiles = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n').sort()
assert.deepEqual(archiveFiles, files.map(file => `package/${file}`).sort(), 'tarball file list differs from npm pack audit')
const packedPkg = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8', timeout: 30_000 }))
assert.equal(packedPkg.name, pkg.name)
assert.equal(packedPkg.version, pkg.version)
const digest = integrity(await readFile(tarball))
assert.equal(info.integrity, digest, 'npm pack integrity differs from tarball bytes')
let publish = true
if (checkRegistry) {
  const existing = await readRegistry()
  if (existing) {
    assert.equal(existing.dist?.integrity, digest, 'this npm version already exists with different contents; bump the version before publishing')
    publish = false
  }
}
const audit = { name: pkg.name, version: pkg.version, ...(tag === undefined ? {} : { tag }), filename: info.filename, integrity: digest, size: info.size, unpackedSize: info.unpackedSize, files, bundledDependencies: [], publish }
await writeFile(join(releaseDir, 'package-audit.json'), `${JSON.stringify(audit, null, 2)}\n`)
await copyFile(join(project, 'market-entry.json'), join(releaseDir, 'market-entry.json'))
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tarball=.release/${info.filename}\nname=${pkg.name}\nversion=${pkg.version}\npublish=${publish}\n`)
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, tarball: `.release/${info.filename}`, files: files.length, size: info.size, integrity: digest, publish }, null, 2))
