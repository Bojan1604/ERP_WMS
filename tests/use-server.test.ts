/**
 * Datoteke s 'use server' smiju u izvezenim vrijednostima imati samo async funkcije
 * (Next inače ruši build: "Server Actions must be async functions"). Provjera bez builda.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test("'use server' datoteke: bez običnih funkcija u izvezenim akcijama", () => {
  const bad: string[] = [];
  for (const f of files(path.join(process.cwd(), 'src'))) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/^['"]use server['"]/.test(src.trimStart())) continue;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node, inAsync: boolean): void => {
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        const isAsync = (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
        if (!isAsync && !inAsync) bad.push(`${path.relative(process.cwd(), f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
        ts.forEachChild(n, (c) => visit(c, inAsync || isAsync));
        return;
      }
      ts.forEachChild(n, (c) => visit(c, inAsync));
    };
    for (const st of sf.statements)
      if (ts.isVariableStatement(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        for (const d of st.declarationList.declarations) if (d.initializer) visit(d.initializer, false);
  }
  assert.deepEqual(bad, [], `Obične (ne-async) funkcije u izvezenim server akcijama — premjestite ih u imenovane funkcije izvan izraza:\n${bad.join('\n')}`);
});
