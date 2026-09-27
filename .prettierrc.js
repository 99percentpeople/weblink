export default {
  tabWidth: 2,
  printWidth: 60,
  tailwindAttributes: ["class"],
  tailwindFunctions: ["clsx"],
  tailwindStylesheet: "./apps/web/src/global.css",
  customAttributes: ["class"],
  plugins: [
    "prettier-plugin-tailwindcss",
    "prettier-plugin-classnames",
    "prettier-plugin-merge",
  ],
};
