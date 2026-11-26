import { isBuiltin } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const moduleCache = ts.createModuleResolutionCache(root, (path) =>
  ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase(),
);
const sourceFiles = ts.sys.readDirectory('src', extensions);
const importsByFile = new Map();

function onlyTypeSpecifiers(named) {
  return (
    named &&
    (ts.isNamedImports(named) || ts.isNamedExports(named)) &&
    named.elements.length > 0 &&
    named.elements.every((element) => element.isTypeOnly)
  );
}

function imports(file) {
  if (importsByFile.has(file)) return importsByFile.get(file);
  const source = ts.createSourceFile(file, ts.sys.readFile(file), ts.ScriptTarget.Latest);
  const edges = [];
  function add(specifier, typeOnly) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const name = specifier.text;
    const target = ts.resolveModuleName(name, file, options, ts.sys, moduleCache).resolvedModule;
    const local = target && !target.isExternalLibraryImport ? target.resolvedFileName : undefined;
    const { line } = source.getLineAndCharacterOfPosition(specifier.getStart(source));
    edges.push({ name, typeOnly, local, line: line + 1 });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      add(
        node.moduleSpecifier,
        clause?.isTypeOnly || (!clause?.name && onlyTypeSpecifiers(clause?.namedBindings)),
      );
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node.isTypeOnly || onlyTypeSpecifiers(node.exportClause));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require')
      ) {
        add(node.arguments[0], false);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  importsByFile.set(file, edges);
  return edges;
}

const client = /^src\/(?:client\.[cm]?[jt]sx?$|ui\/)/;
const ledger = /^src\/store(?:[./]|$)/;
const host = /^src\/(?:dsh|host|index|runtime|manager|[^/]+-host)(?:[./-]|$)/;
const dsh = /^@deepseek-ai\/(?:cordis|dsh)(?:[/\-]|$)/;
const dshClient = /^@deepseek-ai\/dsh-client-[^/]+\/client(?:\/|$)/;
const react = /^(?:react|react-dom)(?:\/|$)/;

function check(roots, message, forbidden, includeTypes) {
  const pending = new Set(roots.map((file) => resolve(file)));
  for (const file of pending) {
    for (const { name, typeOnly, local, line } of imports(file)) {
      if (typeOnly && !includeTypes) continue;
      const path = local ? relative(root, local).split(sep).join('/') : '';
      if (forbidden(name, path)) {
        console.error(`${relative(root, file)}:${line}: ${message}: "${name}"`);
        process.exitCode = 1;
      } else if (
        path.startsWith('src/') &&
        extensions.some((extension) => path.endsWith(extension))
      ) {
        pending.add(local);
      }
    }
  }
}

check(
  sourceFiles.filter((path) => client.test(path)),
  'Browser code cannot load ledger or host modules',
  (name, path) =>
    ledger.test(path) ||
    host.test(path) ||
    isBuiltin(name) ||
    (dsh.test(name) && !dshClient.test(name)),
  false,
);
check(
  ['src/model.ts', ...sourceFiles.filter((path) => ledger.test(path))],
  'Model and ledger code cannot depend on DSH or UI modules',
  (name, path) => dsh.test(name) || react.test(name) || client.test(path) || host.test(path),
  true,
);

if (!process.exitCode) console.log('Module boundaries passed.');
