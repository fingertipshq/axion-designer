export default {
  customSyntax: 'postcss-html',
  plugins: ['stylelint-declaration-strict-value'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'scale-unlimited/declaration-strict-value': [
      ['/color/', 'fill', 'stroke', 'background', 'background-color', 'border-color', 'box-shadow', 'outline-color'],
      {
        ignoreValues: ['transparent', 'currentColor', 'inherit', 'none', 'unset', 'initial'],
        message: 'Use semantic var(--token) values from design/tokens.json instead of hardcoded colors or shadows.',
      },
    ],
  },
};
