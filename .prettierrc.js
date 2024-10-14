export default {
  tabWidth: 2,
  printWidth: 60,
  tailwindAttributes: ["class"],
  tailwindFunctions: ["clsx"],
  tailwindConfig: "tailwind.config.ts",
  customAttributes: ["class"],
  plugins: [
    "prettier-plugin-tailwindcss",
    "prettier-plugin-classnames",
    "prettier-plugin-merge",
  ],
};
