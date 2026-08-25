#!/usr/bin/env node
// Deterministic fixture executable for the CLI plane tests. Spawned directly
// (never through a shell), so behaviors are driven by argv[0]:
//   echo  <text...>       print text to stdout, exit 0
//   err   <text...>       print text to stderr, exit 0
//   mix                   stdout line + stderr line, exit 1
//   env   <NAME...>       print NAME=VALUE for each env var, exit 0
//   stdin                echo stdin after EOF, exit 0
//   exit  <code>          exit with the given code
//   sleep <ms>            wait, then exit 0
//   huge  <bytes>         emit <bytes> of 'x' to stdout, exit 0
//   probe [ver] [login]   print version=<ver> and loggedIn=<login>, exit 0
const [, , sub, ...rest] = process.argv;

function out(text) {
  process.stdout.write(`${text}\n`);
}

switch (sub) {
  case 'echo':
    out(rest.join(' '));
    break;
  case 'err':
    process.stderr.write(`${rest.join(' ')}\n`);
    break;
  case 'mix':
    out('out-line');
    process.stderr.write('err-line\n');
    process.exitCode = 1;
    break;
  case 'env':
    for (const name of rest) out(`${name}=${process.env[name] ?? ''}`);
    break;
  case 'stdin':
    process.stdin.setEncoding('utf8');
    let input = '';
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => out(input));
    break;
  case 'exit':
    process.exit(Number(rest[0] ?? 0));
    break;
  case 'sleep':
    setTimeout(() => process.exit(0), Number(rest[0] ?? 1000));
    break;
  case 'huge':
    out('x'.repeat(Number(rest[0] ?? 65536)));
    break;
  case 'probe':
    out(`version=${rest[0] ?? '1.2.3'}`);
    out(`loggedIn=${rest[1] ?? 'true'}`);
    break;
  default:
    process.stderr.write(`unknown subcommand: ${sub ?? ''}\n`);
    process.exitCode = 2;
}
