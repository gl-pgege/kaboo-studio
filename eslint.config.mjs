import tseslint from 'typescript-eslint';

export default [{ ignores: ['src/generated/**'] }, { files: ['src/**/*.ts'], languageOptions: { parser: tseslint.parser } }];
