import { describe, expect, it } from 'vitest';
import { navigationLanguages } from '@myagentroam/code-navigation';
import {
  navigationResolutionDefinitions,
  pathSpecifierResolver
} from '../../src/service/code-navigation/navigation-resolution-registry.js';
import { referenceCandidatePositions } from '../../src/service/code-navigation/file-reference-parser.js';
import { parseTag } from '../../src/service/code-navigation/ctags-query.js';
import {
  manifestEntry,
  sourceDelta
} from '../../src/service/code-navigation/ctags-index-storage.js';
import {
  containsSymbol,
  targetPreview
} from '../../src/service/code-navigation/navigation-target-validator.js';

describe('Node navigation resolution registry', () => {
  it('keeps each resolution definition paired with one public syntax language and resolver', () => {
    const definitions = navigationResolutionDefinitions();
    const syntaxLanguageIds = new Set(navigationLanguages().map((language) => language.id));

    expect(new Set(definitions.map((definition) => definition.languageId)).size).toBe(
      definitions.length
    );
    expect(new Set(definitions.map((definition) => definition.resolver.id)).size).toBe(
      definitions.length
    );
    expect(definitions.every((definition) => syntaxLanguageIds.has(definition.languageId))).toBe(
      true
    );
    expect(new Set(definitions.map((definition) => definition.languageId))).toEqual(
      syntaxLanguageIds
    );
  });

  it('selects the resolver from the Node-reparsed language definition', () => {
    expect(pathSpecifierResolver('ecmascript', './module.js')?.id).toBe(
      'ecmascript.path-specifier'
    );
    expect(pathSpecifierResolver('go', 'example.test/project/internal/feature')?.id).toBe(
      'go.path-specifier'
    );
    expect(pathSpecifierResolver('python', '.sibling')?.id).toBe('python.path-specifier');
    expect(pathSpecifierResolver('csharp', 'Company.Project.Models')?.id).toBe(
      'csharp.path-specifier'
    );
    expect(pathSpecifierResolver('markdown', '../guide.md')?.id).toBe('markdown.path-specifier');
    expect(pathSpecifierResolver('css', './theme.css')?.id).toBe('css.path-specifier');
    expect(pathSpecifierResolver('scss', 'palette')?.id).toBe('scss.path-specifier');
    expect(pathSpecifierResolver('vue', '../assets/logo.svg')?.id).toBe('vue.path-specifier');
    expect(pathSpecifierResolver('objective-c', 'hal/ZOSHalMisc.h')?.id).toBe(
      'objective-c.path-specifier'
    );
  });

  it('prefers the longest trailing path for unresolved ECMAScript aliases', () => {
    const resolver = pathSpecifierResolver('ecmascript', '@/features/account/Profile');
    expect(resolver).toBeDefined();
    expect(
      resolver?.matches(
        'src/features/account/Profile.ts',
        'src/view/current.ts',
        '@/features/account/Profile'
      )
    ).toBe(true);
    expect(
      resolver?.matches(
        'src/legacy/Profile.ts',
        'src/view/current.ts',
        '@/features/account/Profile'
      )
    ).toBe(true);
    expect(
      resolver!.score(
        'src/features/account/Profile.ts',
        'src/view/current.ts',
        '@/features/account/Profile'
      )
    ).toBeLessThan(
      resolver!.score('src/legacy/Profile.ts', 'src/view/current.ts', '@/features/account/Profile')
    );
  });

  it('applies alias suffix fallback only to path-based stylesheet languages', () => {
    const resolver = pathSpecifierResolver('scss', '@/styles/palette');
    expect(resolver).toBeDefined();
    expect(
      resolver?.matches('styles/_palette.scss', 'components/App.vue', '@/styles/palette')
    ).toBe(true);
    expect(
      resolver!.score('styles/_palette.scss', 'components/App.vue', '@/styles/palette')
    ).toBeLessThan(
      resolver!.score('legacy/_palette.scss', 'components/App.vue', '@/styles/palette')
    );
    expect(pathSpecifierResolver('python', '@/package/module')).toBeUndefined();
    expect(pathSpecifierResolver('jvm', '@/com/example/Service')).toBeUndefined();
  });

  it('bounds repeated untrusted reference positions before reparsing', () => {
    const text = Array.from({ length: 1_000 }, () => './same').join(' ');
    const positions = referenceCandidatePositions({
      value: './same',
      from: 0,
      to: './same'.length,
      sourceContext: { text, position: Math.floor(text.length / 2) }
    });

    expect(positions.length).toBeLessThanOrEqual(8);
    expect(positions).toContain(Math.floor(text.length / 2));
  });

  it('parses only bounded workspace-relative ctags records', () => {
    expect(parseTag('workbench\tsrc/model/workbench.ts\t12;"\tkind:v\tclass:Model')).toEqual({
      name: 'workbench',
      path: 'src/model/workbench.ts',
      line: 12,
      kind: 'v',
      scope: 'Model'
    });
    expect(parseTag('workbench\t../outside.ts\t12;"\tkind:v')).toBeUndefined();
    expect(parseTag(`workbench\tsrc/model.ts\t${'1'.repeat(17 * 1024)}`)).toBeUndefined();
  });

  it('keeps manifest and target validation helpers bounded and deterministic', () => {
    expect(manifestEntry('src/main.ts', '42:123.5')).toMatchObject({
      path: 'src/main.ts',
      size: 42,
      modifiedAt: 123.5
    });
    expect(manifestEntry('src/main.ts', 'invalid')).toBeUndefined();
    expect(
      sourceDelta(
        { 'src/changed.ts': '1:1', 'src/removed.ts': '2:2' },
        { 'src/changed.ts': '3:3', 'src/added.ts': '4:4' }
      )
    ).toEqual({
      changed: ['src/changed.ts', 'src/added.ts'],
      removed: ['src/removed.ts']
    });
    expect(containsSymbol('$accent: red;', 'accent')).toBe(true);
    expect(containsSymbol('accented: red;', 'accent')).toBe(false);
    expect(targetPreview('x'.repeat(600))).toHaveLength(512);
  });
});
