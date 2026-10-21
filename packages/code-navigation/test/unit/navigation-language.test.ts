import { describe, expect, it } from 'vitest';
import {
  fileSpecifierParser,
  isNavigationSymbol,
  navigationLanguageForPath,
  navigationLanguages,
  navigationSymbolAt
} from '../../src/index.js';
import { supportsSymbolNavigationPath } from '../../src/symbol-navigation.js';

describe('shared code-navigation language registry', () => {
  it.each([
    ['src/main.ts', 'ecmascript'],
    ['src/theme.css', 'css'],
    ['cmd/main.go', 'go'],
    ['pages/index.html', 'html'],
    ['src/Service.java', 'jvm'],
    ['src/Service.cs', 'csharp'],
    ['src/theme.less', 'less'],
    ['package/module.py', 'python'],
    ['src/theme.sass', 'sass'],
    ['src/theme.scss', 'scss'],
    ['src/main.c', 'c'],
    ['src/main.cpp', 'cpp'],
    ['src/main.mm', 'objective-cpp'],
    ['docs/guide.md', 'markdown'],
    ['src/lib.rs', 'rust'],
    ['src/App.vue', 'vue']
  ] as const)('selects %s as %s', (path, language) => {
    expect(navigationLanguageForPath(path)?.id).toBe(language);
  });

  it('keeps syntax definitions complete and language IDs unique', () => {
    const languages = navigationLanguages();
    expect(new Set(languages.map((language) => language.id)).size).toBe(languages.length);
    expect(languages.every((language) => language.suffixes.length > 0)).toBe(true);
    expect(languages.every((language) => language.parser !== undefined)).toBe(true);
  });

  it('keeps generic Ctags source registration separate from file-reference syntax', () => {
    expect(supportsSymbolNavigationPath('styles/theme.css')).toBe(true);
    expect(supportsSymbolNavigationPath('styles/theme.scss')).toBe(true);
    expect(supportsSymbolNavigationPath('pages/index.html')).toBe(true);
    expect(supportsSymbolNavigationPath('server/index.php')).toBe(true);
    expect(supportsSymbolNavigationPath('Makefile')).toBe(true);
    expect(supportsSymbolNavigationPath('components/App.vue')).toBe(false);
    expect(supportsSymbolNavigationPath('styles/theme.sass')).toBe(false);
    expect(supportsSymbolNavigationPath('styles/theme.less')).toBe(false);
    expect(supportsSymbolNavigationPath('src/main.cjs')).toBe(false);
    expect(supportsSymbolNavigationPath('src/main.pyw')).toBe(true);
    expect(supportsSymbolNavigationPath('src/App.tsx')).toBe(false);
    expect(supportsSymbolNavigationPath('src/main.mts')).toBe(false);
    expect(supportsSymbolNavigationPath('src/main.cts')).toBe(false);
  });

  it('extracts existing file-reference forms without selecting plain symbols', () => {
    expect(
      fileSpecifierParser('src/main.ts')?.find('import { x } from "./module.js";', 22)
    ).toMatchObject({
      value: './module.js',
      from: 19,
      to: 30,
      languageId: 'ecmascript',
      extractorId: 'ecmascript.static-module',
      kind: 'relative-file'
    });
    for (const source of [
      'import "./setup.js";',
      'export { value } from "./module.js";',
      'import {\n  first,\n  second\n} from "./module.js";'
    ]) {
      const value = source.includes('setup') ? './setup.js' : './module.js';
      expect(fileSpecifierParser('src/main.ts')?.find(source, source.indexOf(value))).toMatchObject(
        {
          value,
          extractorId: 'ecmascript.static-module'
        }
      );
    }
    const unrelatedString = 'import "./setup.js";\nconst image = "./logo.png";';
    expect(
      fileSpecifierParser('src/main.ts')?.find(
        unrelatedString,
        unrelatedString.indexOf('./logo.png')
      )
    ).toBeUndefined();
    expect(
      fileSpecifierParser('src/main.cpp', '#include "hal/ZOSHalMisc.h"')?.find(
        '#include "hal/ZOSHalMisc.h"',
        15
      )
    ).toMatchObject({
      value: 'hal/ZOSHalMisc.h',
      from: 10,
      to: 26,
      languageId: 'cpp',
      kind: 'include'
    });
    expect(fileSpecifierParser('src/lib.rs')?.find('pub(crate) mod child;', 16)).toMatchObject({
      value: 'child',
      from: 15,
      to: 20,
      languageId: 'rust',
      kind: 'module'
    });
    expect(
      fileSpecifierParser('package/sub/current.py')?.find('from ..parent import value', 7)
    ).toMatchObject({
      value: '..parent',
      languageId: 'python',
      extractorId: 'python.import',
      kind: 'relative-file'
    });
    expect(
      fileSpecifierParser('package/sub/current.py')?.find('from . import sibling', 5)
    ).toMatchObject({
      value: '.',
      languageId: 'python',
      extractorId: 'python.import',
      kind: 'relative-file'
    });
    expect(
      fileSpecifierParser('package/sub/current.py')?.find('from .. import parent', 5)
    ).toMatchObject({
      value: '..',
      languageId: 'python',
      extractorId: 'python.import',
      kind: 'relative-file'
    });
    expect(
      fileSpecifierParser('src/lib.rs')?.find('#[path = "child.rs"] mod child;', 12)
    ).toMatchObject({
      value: 'child.rs',
      languageId: 'rust',
      extractorId: 'rust.path-module',
      kind: 'relative-file'
    });
    expect(
      fileSpecifierParser('src/Current.java')?.find('import static com.example.Service.member;', 20)
    ).toMatchObject({
      value: 'com.example.Service.member',
      languageId: 'jvm',
      extractorId: 'jvm.import',
      kind: 'namespace'
    });
    const cssImport = '@import "./theme.css";';
    expect(
      fileSpecifierParser('styles/main.css')?.find(cssImport, cssImport.indexOf('./theme.css'))
    ).toMatchObject({
      value: './theme.css',
      languageId: 'css',
      extractorId: 'css.import'
    });
    const scssUse = '@use "palette";';
    expect(
      fileSpecifierParser('styles/main.scss')?.find(scssUse, scssUse.indexOf('palette'))
    ).toMatchObject({
      value: 'palette',
      languageId: 'scss',
      extractorId: 'scss.import'
    });
    const sassForward = '@forward "palette";';
    expect(
      fileSpecifierParser('styles/main.sass')?.find(sassForward, sassForward.indexOf('palette'))
    ).toMatchObject({
      value: 'palette',
      languageId: 'sass',
      extractorId: 'sass.import'
    });
    const lessImport = '@import (reference) "theme";';
    expect(
      fileSpecifierParser('styles/main.less')?.find(lessImport, lessImport.indexOf('theme'))
    ).toMatchObject({
      value: 'theme',
      languageId: 'less',
      extractorId: 'less.import'
    });
    const html = '<link href="../styles/theme.css">';
    expect(
      fileSpecifierParser('pages/index.html')?.find(html, html.indexOf('../styles/theme.css'))
    ).toMatchObject({
      value: '../styles/theme.css',
      languageId: 'html',
      extractorId: 'html.attribute'
    });
    const vueSource =
      '<template><img src="../assets/logo.svg"></template><script setup>import Child from "./Child.vue";</script><style>@use "../styles/palette";</style>';
    expect(
      fileSpecifierParser('components/App.vue')?.find(
        vueSource,
        vueSource.indexOf('../assets/logo.svg')
      )
    ).toMatchObject({
      value: '../assets/logo.svg',
      languageId: 'vue',
      extractorId: 'vue.attribute'
    });
    expect(
      fileSpecifierParser('components/App.vue')?.find(vueSource, vueSource.indexOf('./Child.vue'))
    ).toMatchObject({
      value: './Child.vue',
      languageId: 'ecmascript',
      extractorId: 'ecmascript.static-module'
    });
    const vueScss = '<style lang="scss">@use "../styles/palette";</style>';
    expect(
      fileSpecifierParser('components/App.vue')?.find(vueScss, vueScss.indexOf('../styles/palette'))
    ).toMatchObject({
      value: '../styles/palette',
      languageId: 'scss',
      extractorId: 'scss.import'
    });
    const boundedVueScript =
      'const filler = true;\nimport Child from "./Child.vue";\nconst tail = true;';
    expect(
      fileSpecifierParser('components/App.vue')?.find(
        boundedVueScript,
        boundedVueScript.indexOf('./Child.vue')
      )
    ).toMatchObject({
      value: './Child.vue',
      languageId: 'ecmascript',
      extractorId: 'ecmascript.static-module'
    });
    const boundedVueStyle =
      '.root { color: red; }\n@use "../styles/palette";\n.tail { color: blue; }';
    expect(
      fileSpecifierParser('components/App.vue')?.find(
        boundedVueStyle,
        boundedVueStyle.indexOf('../styles/palette')
      )
    ).toMatchObject({
      value: '../styles/palette',
      languageId: 'scss',
      extractorId: 'scss.import'
    });
    const staticMarkup =
      '<img :src="../assets/dynamic.svg" data-src="../assets/ignored.svg" src="../assets/static.svg">';
    expect(
      fileSpecifierParser('components/App.vue')?.find(
        staticMarkup,
        staticMarkup.indexOf('../assets/dynamic.svg')
      )
    ).toBeUndefined();
    expect(
      fileSpecifierParser('components/App.vue')?.find(
        staticMarkup,
        staticMarkup.indexOf('../assets/ignored.svg')
      )
    ).toBeUndefined();
    expect(
      fileSpecifierParser('components/App.vue')?.find(
        staticMarkup,
        staticMarkup.indexOf('../assets/static.svg')
      )
    ).toMatchObject({ value: '../assets/static.svg', extractorId: 'vue.attribute' });
    const goImports = 'import (\n  "example.test/project/internal/feature"\n)';
    expect(
      fileSpecifierParser('cmd/main.go')?.find(
        goImports,
        goImports.indexOf('example.test/project/internal/feature')
      )
    ).toMatchObject({
      value: 'example.test/project/internal/feature',
      languageId: 'go',
      extractorId: 'go.import',
      kind: 'module'
    });
    const csharpUsing = 'global using Alias = Company.Project.Models.Widget;';
    expect(
      fileSpecifierParser('src/Program.cs')?.find(
        csharpUsing,
        csharpUsing.indexOf('Company.Project.Models.Widget')
      )
    ).toMatchObject({
      value: 'Company.Project.Models.Widget',
      languageId: 'csharp',
      extractorId: 'csharp.using',
      kind: 'namespace'
    });
    const multilineImport = 'import {\n  value\n} from "./module.js";';
    expect(
      fileSpecifierParser('src/main.ts')?.find(
        multilineImport,
        multilineImport.indexOf('./module.js')
      )
    ).toMatchObject({
      value: './module.js',
      extractorId: 'ecmascript.static-module',
      kind: 'relative-file'
    });
    expect(fileSpecifierParser('src/main.ts')?.find('const target = call();', 7)).toBeUndefined();
  });

  it('uses source probes for ambiguous C-family suffixes and preserves a conservative fallback', () => {
    const objectiveCSource = '@interface Service\n#import "Service.h"';
    expect(navigationLanguageForPath('src/Service.m', objectiveCSource)?.id).toBe('objective-c');
    expect(
      fileSpecifierParser('src/Service.m', objectiveCSource)?.find(
        objectiveCSource,
        objectiveCSource.indexOf('Service.h')
      )
    ).toMatchObject({
      value: 'Service.h',
      languageId: 'objective-c',
      extractorId: 'objective-c.include'
    });

    expect(navigationLanguageForPath('src/math.m', 'function y = add(x)\ny = x + 1;')?.id).toBe(
      'c-family'
    );
    expect(
      navigationLanguageForPath('include/Service.h', 'template <class T> class Box {};')?.id
    ).toBe('cpp');
    expect(
      navigationLanguageForPath('include/Service.h', '@interface Service : NSObject')?.id
    ).toBe('objective-c');
    expect(
      navigationLanguageForPath(
        'include/Service.h',
        '@interface Service : NSObject\nnamespace detail {}'
      )?.id
    ).toBe('objective-cpp');
    expect(navigationLanguageForPath('include/plain.h', '#pragma once')?.id).toBe('c-family');
  });

  it('extracts quoted and angle-bracket C-family includes without restricting the file suffix', () => {
    expect(
      fileSpecifierParser('src/main.c', '#include "generated/config.inc"')?.find(
        '#include "generated/config.inc"',
        22
      )
    ).toMatchObject({
      value: 'generated/config.inc',
      languageId: 'c',
      extractorId: 'c.include'
    });
    expect(
      fileSpecifierParser('src/main.mm', '#import <Foundation/Foundation.h>')?.find(
        '#import <Foundation/Foundation.h>',
        23
      )
    ).toMatchObject({
      value: 'Foundation/Foundation.h',
      languageId: 'objective-cpp',
      extractorId: 'objective-cpp.include'
    });
    const continued = '#include \\\n  "generated/config.ipp"';
    expect(
      fileSpecifierParser('src/main.cpp', continued)?.find(
        continued,
        continued.indexOf('generated/config.ipp')
      )
    ).toMatchObject({
      value: 'generated/config.ipp',
      languageId: 'cpp',
      extractorId: 'cpp.include'
    });
  });

  it('extracts Markdown links and anchors from the fixed source window', () => {
    const inline = 'Read [the guide](../guides/setup.md#Install%20Now).';
    expect(
      fileSpecifierParser('docs/current.md', inline)?.find(
        inline,
        inline.indexOf('../guides/setup.md')
      )
    ).toMatchObject({
      value: '../guides/setup.md',
      anchor: 'Install%20Now',
      languageId: 'markdown',
      extractorId: 'markdown.inline'
    });

    const reference = '[Guide][setup]\n\n[setup]: ../guides/setup.md#install';
    expect(
      fileSpecifierParser('docs/current.md', reference)?.find(reference, reference.indexOf('Guide'))
    ).toMatchObject({
      value: '../guides/setup.md',
      anchor: 'install',
      languageId: 'markdown',
      extractorId: 'markdown.reference'
    });
    const autolink = '<../guides/setup.md#install>';
    expect(
      fileSpecifierParser('docs/current.md', autolink)?.find(
        autolink,
        autolink.indexOf('../guides/setup.md')
      )
    ).toMatchObject({
      value: '../guides/setup.md',
      anchor: 'install',
      extractorId: 'markdown.autolink'
    });
    const html = '<img src="../images/diagram.png">';
    expect(
      fileSpecifierParser('docs/current.md', html)?.find(
        html,
        html.indexOf('../images/diagram.png')
      )
    ).toMatchObject({ value: '../images/diagram.png', extractorId: 'markdown.html-attribute' });
    expect(
      fileSpecifierParser('docs/current.md', '<img src="../images/diagram.png">')?.find(
        '<img src="../images/diagram.png">',
        1
      )
    ).toBeUndefined();
    const staticHtml =
      '<img :src="../images/dynamic.png" data-src="../images/ignored.png" src="../images/static.png">';
    expect(
      fileSpecifierParser('docs/current.md', staticHtml)?.find(
        staticHtml,
        staticHtml.indexOf('../images/dynamic.png')
      )
    ).toBeUndefined();
    expect(
      fileSpecifierParser('docs/current.md', staticHtml)?.find(
        staticHtml,
        staticHtml.indexOf('../images/ignored.png')
      )
    ).toBeUndefined();
    expect(
      fileSpecifierParser('docs/current.md', staticHtml)?.find(
        staticHtml,
        staticHtml.indexOf('../images/static.png')
      )
    ).toMatchObject({ value: '../images/static.png', extractorId: 'markdown.html-attribute' });
    expect(
      fileSpecifierParser('docs/current.md', '[Guide][missing]')?.find('[Guide][missing]', 2)
    ).toBeUndefined();
    const fenced = '```md\n[hidden](../hidden.md)\n```';
    expect(
      fileSpecifierParser('docs/current.md', fenced)?.find(fenced, fenced.indexOf('../hidden.md'))
    ).toBeUndefined();
    const external = '[web](https://example.test/guide.md)';
    expect(
      fileSpecifierParser('docs/current.md', external)?.find(external, external.indexOf('https://'))
    ).toBeUndefined();
  });

  it.each([
    ['const module = import("./lazy.js");', 24, './lazy.js', 'ecmascript.dynamic-module'],
    ['const module = require("./legacy.js");', 25, './legacy.js', 'ecmascript.require'],
    ['/// <reference path="./types.d.ts" />', 23, './types.d.ts', 'typescript.reference-path'],
    [
      'const asset = new URL("./asset.svg", import.meta.url);',
      25,
      './asset.svg',
      'ecmascript.import-meta-url'
    ]
  ] as const)('extracts %s', (line, column, value, extractorId) => {
    expect(fileSpecifierParser('src/main.ts')?.find(line, column)).toMatchObject({
      value,
      extractorId,
      kind: 'relative-file'
    });
  });

  it('treats hyphens as language-specific symbol characters', () => {
    expect(navigationSymbolAt('styles/theme.css', '.main-color {}', 7)).toMatchObject({
      value: 'main-color',
      from: 1,
      to: 11
    });
    expect(navigationSymbolAt('Makefile', 'build-release:', 7)).toMatchObject({
      value: 'build-release'
    });
    expect(navigationSymbolAt('src/main.ts', 'left-right', 7)).toMatchObject({
      value: 'right'
    });
    expect(isNavigationSymbol('styles/theme.scss', '--main-color')).toBe(true);
    expect(isNavigationSymbol('src/main.ts', 'left-right')).toBe(false);
  });
});
