'use strict';
// 本地构建镜像：版本号取自 git tag，提交号取自 HEAD，不修改任何文件。
//
// 用法：
//   npm run image                  # 推荐，等价于 node scripts/build-image.js
//   node scripts/build-image.js    # 版本 = git describe 的结果
//   node scripts/build-image.js --no-latest   # 不打 latest 别名
//   node scripts/build-image.js --dry-run     # 只打印将要执行的命令，不真的构建
//   node scripts/build-image.js --platform linux/amd64   # 交叉构建
//
// 版本号规则（Docker tag 只允许字母数字、. _ -，下面每一档都合法；一律带 v 前缀，
// 和 git tag、package.json 的写法保持一致，看到就知道是哪一版）：
//   HEAD 正好在 tag v1.1.0 且无改动      -> v1.1.0           同时打 latest
//   tag 之后又有 3 个提交                -> v1.1.0-3-g6ac568a 不打 latest
//   有未提交的已跟踪改动（脏工作区）      -> v1.1.0-dirty     不打 latest
//   一个 tag 都没有                      -> v0.0.0-<短提交号>
//
// latest 只给"发布版"打：否则 latest 会指向某个中间态，和 README 里
// 「固定版本用于部署、latest 仅本地随手跑」的约定就对不上了。要强行打用 --latest。

const { execFileSync } = require('node:child_process');

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return ''; // 没有 git、不是仓库、没有匹配的 tag，都走兜底逻辑
  }
}

// 只统计已跟踪文件的改动：未跟踪的文件不会被 COPY 进镜像（Dockerfile 列的是具体路径）
const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';
const revision = git(['rev-parse', '--short', 'HEAD']) || 'unknown';

const exactTag = git(['describe', '--tags', '--exact-match', '--match', 'v*']);
const longTag = git(['describe', '--tags', '--long', '--match', 'v*']);
// tag 必须带 v 前缀才会被识别；HEAD 上挂着别的 tag 时给一句提示，避免误以为脚本坏了
const anyTag = git(['describe', '--tags', '--exact-match']);
if (anyTag && !exactTag) {
  console.warn(`提示：当前提交上的 tag 是 ${anyTag}，不以 v 开头，脚本不会拿它当版本号。建议改用 v1.2.3 这种形式。\n`);
}

let version;
let release = false; // 是否算发布版（决定要不要打 latest）
if (exactTag) {
  version = exactTag; // 已经带 v，和 git tag 完全一致，方便对着 tag 找镜像
  release = !dirty;
} else if (longTag) {
  // v1.1.0-3-g6ac568a 原样使用
  version = longTag;
} else {
  version = `v0.0.0-${revision}`;
}
if (dirty) version += '-dirty';

// package.json 的 version 只是给人看的，镜像标签一律以 git tag 为准；
// 两边不一致时提示一句，免得以后对着 package.json 和镜像标签犯迷糊
const pkgVersion = require('../package.json').version;
const baseVersion = version.replace(/-dirty$/, '').replace(/-\d+-g[0-9a-f]+$/, '');
if (pkgVersion !== baseVersion) {
  console.warn(`提示：package.json 的 version 是 ${pkgVersion}，git tag 推出的是 ${baseVersion}。`);
  console.warn(`      镜像以 git tag 为准。想让两边一致：npm pkg set version=${baseVersion}\n`);
}

const argv = process.argv.slice(2);
const opts = {
  dryRun: argv.includes('--dry-run'),
  platform: argv.includes('--platform') ? argv[argv.indexOf('--platform') + 1] : null,
  // 默认：发布版打 latest；非发布版不打。--latest 强行打，--no-latest 强行不打
  latest: argv.includes('--latest') ? true : argv.includes('--no-latest') ? false : release,
};

const tags = [`tokenspeed:${version}`];
if (opts.latest) tags.push('tokenspeed:latest');

const args = ['build'];
for (const t of tags) args.push('-t', t);
args.push('--build-arg', `VERSION=${version}`, '--build-arg', `REVISION=${revision}`);
if (opts.platform) args.push('--platform', opts.platform);
args.push('.');

console.log(`版本号  ${version}${release ? '（发布版）' : '（开发版，不打 latest）'}`);
console.log(`提交号  ${revision}${dirty ? '（工作区有未提交改动）' : ''}`);
console.log(`镜像打  ${tags.join('  ')}`);
console.log(`命令    docker ${args.join(' ')}\n`);

if (opts.dryRun) {
  console.log('--dry-run：未执行构建');
  process.exit(0);
}

try {
  execFileSync('docker', args, { stdio: 'inherit' });
} catch (err) {
  console.error(`\n构建失败${err.status ? `（docker 退出码 ${err.status}）` : ''}。`);
  if (err.code === 'ENOENT') console.error('没找到 docker 命令，确认 Docker Desktop 已启动且 docker 在 PATH 里。');
  process.exit(err.status || 1);
}

// 构建完核对一遍元数据，防止 build arg 没传进去
try {
  const label = execFileSync(
    'docker',
    ['inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.version"}}', tags[0]],
    { encoding: 'utf8' },
  ).trim();
  console.log(`\n完成：${tags[0]}（镜像内 version 标签 = ${label}）`);
} catch (_) {
  console.log(`\n完成：${tags[0]}`);
}
