#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function printHelp() {
  const text = [
    '4px (node) usage:',
    '  4px server [-c config/server.json]',
    '  4px client [-c config/client.json]',
    '  4px help',
    '',
    'Examples:',
    '  4px server -c config/server.json',
    '  4px client -c config/client.json'
  ].join('\n');
  process.stdout.write(`${text}\n`);
}

function parseConfigArg(args) {
  const idx = args.indexOf('-c');
  if (idx >= 0 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return null;
}

function ensureDefaultConfig(subcommand) {
  const fileName = subcommand === 'server' ? 'server.json' : 'client.json';
  const targetPath = path.resolve(process.cwd(), fileName);
  if (fs.existsSync(targetPath)) {
    return { created: false, path: targetPath };
  }

  const templateCandidates = [
    path.resolve(__dirname, '..', 'config', `${subcommand}.example.json`),
    path.resolve(__dirname, '..', 'config', `${subcommand}.json`)
  ];
  const templatePath = templateCandidates.find((p) => fs.existsSync(p));
  if (!templatePath) {
    throw new Error(`missing template for ${subcommand}: ${templateCandidates.join(', ')}`);
  }

  fs.copyFileSync(templatePath, targetPath);
  return { created: true, path: targetPath };
}

function buildArgsWithConfig(subcommand, args) {
  const explicit = parseConfigArg(args);
  if (explicit) return { args, createdDefault: false };

  const result = ensureDefaultConfig(subcommand);
  return { args: ['-c', result.path, ...args], createdDefault: result.created };
}

function runEntry(entry, args) {
  const entryPath = path.resolve(__dirname, '..', 'src', entry);
  const child = spawn(process.execPath, [entryPath, ...args], {
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    process.stderr.write(`failed to launch ${entry}: ${err.message}\n`);
    process.exit(1);
  });
}

const argv = process.argv.slice(2);
const sub = argv[0];
const rest = argv.slice(1);

if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
  printHelp();
  process.exit(0);
}

if (sub === 'server') {
  const { args, createdDefault } = buildArgsWithConfig('server', rest);
  if (createdDefault) {
    process.stdout.write(`已初始化默认配置文件：${path.resolve(process.cwd(), 'server.json')}\n`);
    process.stdout.write('请按需修改配置后重新运行：4px server\n');
    process.exit(0);
  }
  runEntry('server.js', args);
} else if (sub === 'client') {
  const { args, createdDefault } = buildArgsWithConfig('client', rest);
  if (createdDefault) {
    process.stdout.write(`已初始化默认配置文件：${path.resolve(process.cwd(), 'client.json')}\n`);
    process.stdout.write('请按需修改配置后重新运行：4px client\n');
    process.exit(0);
  }
  runEntry('client.js', args);
} else {
  process.stderr.write(`unknown subcommand: ${sub}\n\n`);
  printHelp();
  process.exit(2);
}
