#!/usr/bin/env node
/**
 * Prepares node_modules for building the Windows x64 app on macOS (`npm run dist:win`).
 *
 * npm installs native binaries for the machine it runs on, so a Mac has none for Windows:
 * - sharp (images for My Documents: embeddings and OCR load it) needs @img/sharp-win32-x64, the
 *   same version sharp itself asks for. It is unpacked next to the macOS package; sharp picks the
 *   one for the platform it runs on.
 * - ffmpeg-static (video recording, voice) needs ffmpeg.exe. Its own installer fetches it when
 *   told the platform; it lands next to the macOS `ffmpeg`, which the Windows build leaves out.
 *
 * Both are kept out of the macOS build by `build.mac.files`. Safe to run again.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function prepareSharp() {
  const sharp = readJson(path.join(nodeModules, 'sharp', 'package.json'));
  const name = '@img/sharp-win32-x64';
  const version = sharp.optionalDependencies && sharp.optionalDependencies[name];
  if (!version) throw new Error(`sharp ${sharp.version} does not list ${name}`);
  const target = path.join(nodeModules, '@img', 'sharp-win32-x64');
  const installed = fs.existsSync(path.join(target, 'package.json')) && readJson(path.join(target, 'package.json')).version;
  if (installed === version) {
    console.log(`${name}@${version} already present`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ulejra-win-sharp-'));
  try {
    const tarball = execFileSync('npm', ['pack', `${name}@${version}`, '--silent', '--pack-destination', tmp], {
      cwd: tmp,
      encoding: 'utf8',
    }).trim().split('\n').pop();
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', target, '--strip-components=1']);
    console.log(`${name}@${version} unpacked into node_modules`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function prepareFfmpeg() {
  const dir = path.join(nodeModules, 'ffmpeg-static');
  const exe = path.join(dir, 'ffmpeg.exe');
  if (fs.existsSync(exe) && fs.statSync(exe).size > 1024 * 1024) {
    console.log('ffmpeg.exe already present');
    return;
  }
  execFileSync(process.execPath, [path.join(dir, 'install.js')], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' },
  });
  if (!fs.existsSync(exe)) throw new Error('ffmpeg.exe was not downloaded');
  console.log('ffmpeg.exe downloaded');
}

prepareSharp();
prepareFfmpeg();
